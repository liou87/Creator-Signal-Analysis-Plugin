import { describe, expect, it } from 'vitest';
import { score, selectWindow } from '../src/scoring/score';
import { DEFAULT_CONFIG } from '../src/scoring/config';
import type { AccountFinding, Evidence, Tier, VideoItem, VideoSource } from '../src/types';

const NOW = Date.UTC(2026, 10, 15);
const DAY = 86400;

function videos(n: number): VideoItem[] {
  return Array.from({ length: n }, (_, i) => ({
    bvid: `BV${i}`,
    title: `视频 ${i}`,
    url: `https://www.bilibili.com/video/BV${i}`,
    pubdate: NOW / 1000 - i * DAY,
  }));
}

function ev(bvid: string, tier: Tier): Evidence {
  return { bvid, tier, type: 'brand', quote: 'x', field: 'title', source: 'rule', reason: 't' };
}

function run(n: number, tiers: Tier[], account: AccountFinding[] = []) {
  const vs = videos(n);
  const evidence = tiers.map((t, i) => ev(`BV${i}`, t));
  return score(
    { mid: '1', name: '测试', capturedAt: NOW, sources: [], videos: vs, videoSource: 'api' },
    vs,
    evidence,
    account,
    { llmUsed: true },
  );
}

const allNo: AccountFinding[] = (
  ['businessContact', 'shop', 'course', 'offsite', 'org', 'charge'] as const
).map((id) => ({ id, state: 'no' }));

describe('内容层公式', () => {
  it('文档中的例子：3 条 2 广告 → r̂ = 0.25', () => {
    const r = run(3, ['A', 'B']);
    expect(r.content.ratio).toBeCloseTo(0.25);
    expect(r.content.point).toBeCloseTo(30);
  });

  it('文档中的例子：30 条 10 广告 → r̂ ≈ 0.29', () => {
    const r = run(30, Array(10).fill('A'));
    expect(r.content.ratio).toBeCloseTo(10 / 35);
  });

  it('没有视频时为 0，不报错', () => {
    const r = run(0, []);
    expect(r.total.point).toBe(0);
    expect(r.confidence.level).toBe('low');
  });

  it('全部是商业内容时封顶在内容层满分', () => {
    const r = run(30, Array(30).fill('A'));
    expect(r.content.point).toBe(DEFAULT_CONFIG.content.max);
  });

  it('一条视频同时命中多档时取最高档，只算一次', () => {
    const vs = videos(10);
    const r = score(
      { mid: '1', name: 't', capturedAt: NOW, sources: [], videos: vs, videoSource: 'api' },
      vs,
      [ev('BV0', 'C'), ev('BV0', 'A'), ev('BV0', 'B')],
      [],
      { llmUsed: true },
    );
    expect(r.content.certainCount).toBe(1);
    expect(r.content.suspectedCount).toBe(0);
    expect(r.verdicts[0]?.tier).toBe('A');
  });
});

describe('区间', () => {
  it('下界 ≤ 点估计 ≤ 上界', () => {
    const r = run(20, ['A', 'C', 'C', 'C', 'B']);
    expect(r.total.low).toBeLessThanOrEqual(r.total.point);
    expect(r.total.point).toBeLessThanOrEqual(r.total.high);
  });

  it('没有疑似证据时区间收缩为一个点', () => {
    const r = run(20, ['A', 'B']);
    expect(r.total.low).toBe(r.total.high);
  });

  it('只有疑似证据时下界的内容层为 0', () => {
    const r = run(20, ['C', 'C', 'C']);
    expect(r.content.low).toBe(0);
    expect(r.content.high).toBeGreaterThan(r.content.point);
  });

  it('模型的最大影响有上界：疑似档全算也不超过对应的确证分', () => {
    const suspected = run(20, Array(6).fill('C'));
    const certain = run(20, Array(6).fill('A'));
    expect(suspected.total.high).toBeCloseTo(certain.total.point);
  });
});

describe('单调性：证据越多分数不降', () => {
  it('逐条增加确证证据', () => {
    let prev = -1;
    for (let k = 0; k <= 30; k++) {
      const r = run(30, Array(k).fill('B'));
      expect(r.total.point).toBeGreaterThanOrEqual(prev);
      prev = r.total.point;
    }
  });

  it('疑似升级为确证时分数不降', () => {
    const before = run(20, ['C', 'C']);
    const after = run(20, ['A', 'C']);
    expect(after.total.point).toBeGreaterThan(before.total.point);
  });

  it('账号层每多一项，总分增加该项分值', () => {
    const base = run(10, [], allNo);
    const withShop = run(
      10,
      [],
      allNo.map((a) => (a.id === 'shop' ? { ...a, state: 'yes' as const } : a)),
    );
    expect(withShop.total.point - base.total.point).toBe(DEFAULT_CONFIG.account.shop.points);
  });
});

describe('账号层', () => {
  it('全部命中时为 40 分', () => {
    const r = run(
      10,
      [],
      allNo.map((a) => ({ ...a, state: 'yes' as const })),
    );
    expect(r.account.score).toBe(40);
    expect(r.account.max).toBe(40);
  });

  it('未能检查不扣分，但降低置信度', () => {
    const known = run(20, [], allNo);
    const unknown = run(
      20,
      [],
      allNo.map((a) => (a.id === 'shop' ? { ...a, state: 'unknown' as const } : a)),
    );
    expect(unknown.total.point).toBe(known.total.point);
    expect(known.confidence.level).toBe('high');
    expect(unknown.confidence.level).toBe('mid');
  });
});

describe('取不到视频不等于没有商业内容（D-27）', () => {
  const old: VideoItem[] = [
    { bvid: 'old1', title: '', url: '', pubdate: NOW / 1000 - 500 * DAY },
    { bvid: 'old2', title: '', url: '', pubdate: NOW / 1000 - 700 * DAY },
  ];
  const runWith = (all: VideoItem[], source: VideoSource) =>
    score(
      { mid: '1', name: 't', capturedAt: NOW, sources: [], videos: all, videoSource: source },
      selectWindow(all, NOW),
      [],
      allNo,
      { llmUsed: false },
    );

  it('所有路径都没取到视频 → 内容层未能评估，置信度为低', () => {
    const r = runWith([], 'none');
    expect(r.content.assessed).toBe(false);
    expect(r.confidence.level).toBe('low');
    expect(r.confidence.reasons.join()).toContain('未能评估');
  });

  it('只从页面读到旧视频 → 未能评估：页面上的不一定是最新投稿', () => {
    const r = runWith(old, 'page');
    expect(r.content.sampleSize).toBe(0);
    expect(r.content.fetched).toBe(2);
    expect(r.content.assessed).toBe(false);
  });

  it('接口返回了投稿但都在窗口之外 → 可以评估，结论是最近没有投稿', () => {
    const r = runWith(old, 'api');
    expect(r.content.assessed).toBe(true);
    expect(r.content.point).toBe(0);
    expect(r.content.latestPubdate).toBe(old[0]!.pubdate);
  });

  it('从页面读到窗口内的视频 → 可以评估，但置信度最多为中', () => {
    const r = runWith(videos(20), 'page');
    expect(r.content.assessed).toBe(true);
    expect(r.confidence.level).toBe('mid');
  });
});

describe('可复现', () => {
  it('同样的输入得到同样的输出', () => {
    const a = run(25, ['A', 'C', 'B', 'C'], allNo);
    const b = run(25, ['A', 'C', 'B', 'C'], allNo);
    expect(a).toEqual(b);
  });
});

describe('分档', () => {
  it('按点估计分三档', () => {
    expect(run(30, []).band).toBe('low');
    expect(run(30, Array(30).fill('A')).band).toBe('mid'); // 60 分，账号层为 0
    expect(
      run(
        30,
        Array(30).fill('A'),
        allNo.map((a) => ({ ...a, state: 'yes' as const })),
      ).band,
    ).toBe('high');
  });
});

describe('取样窗口', () => {
  it('最多 30 条，按发布时间从新到旧', () => {
    const w = selectWindow(videos(50).reverse(), NOW);
    expect(w).toHaveLength(30);
    expect(w[0]?.bvid).toBe('BV0');
  });

  it('丢弃 12 个月之前的视频', () => {
    const vs: VideoItem[] = [
      { bvid: 'new', title: '', url: '', pubdate: NOW / 1000 - 10 * DAY },
      { bvid: 'old', title: '', url: '', pubdate: NOW / 1000 - 400 * DAY },
    ];
    expect(selectWindow(vs, NOW).map((v) => v.bvid)).toEqual(['new']);
  });

  it('没有发布时间的视频保留', () => {
    const vs: VideoItem[] = [{ bvid: 'x', title: '', url: '' }];
    expect(selectWindow(vs, NOW)).toHaveLength(1);
  });
});
