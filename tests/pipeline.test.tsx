import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { classifyVideos } from '../src/classify';
import { classifyAccount } from '../src/classify/account';
import { summarizeHistory } from '../src/classify/history';
import { score, selectWindow } from '../src/scoring/score';
import type { CreatorSnapshot, VideoItem } from '../src/types';
import { ReportView } from '../src/ui/ReportView';

/**
 * 端到端（不含浏览器）：快照 → 取样 → 分类 → 评分 → 报告界面。
 * 用一个虚构的创作者，手算出预期分数，确认整条链路与文档里的公式一致。
 */

const NOW = Date.UTC(2026, 10, 15);
const DAY = 86400;

function video(i: number, extra: Partial<VideoItem> = {}): VideoItem {
  return {
    bvid: `BV${String(i).padStart(10, '0')}`,
    title: `日常记录 第 ${i} 期`,
    url: `https://www.bilibili.com/video/BV${String(i).padStart(10, '0')}`,
    pubdate: NOW / 1000 - i * 7 * DAY,
    desc: '今天也是普通的一天',
    ...extra,
  };
}

const snapshot: CreatorSnapshot = {
  mid: '10086',
  name: '虚构的测评君',
  bio: '数码爱好者。商务合作请联系：biz@example.com',
  officialTitle: 'bilibili 知名UP主',
  hasCharge: 'yes',
  hasShop: 'no',
  hasCourse: 'unknown',
  videoSource: 'latest',
  capturedAt: NOW,
  sources: [{ item: '视频列表', path: '接口 arc/search', ok: true, detail: '20 条' }],
  videos: [
    video(0, { title: '新手机上手', desc: '感谢某某科技对本期视频的支持' }), // A
    video(1, { desc: '同款 https://item.taobao.com/item.htm?id=1' }), // B
    video(2, { pinnedComment: '购买链接在这里，领券更便宜' }), // B
    video(3, { desc: '粉丝专属福利，到手价 199' }), // C
    video(4, { desc: '这期不是恰饭，纯自费' }), // 无
    ...Array.from({ length: 15 }, (_, i) => video(5 + i)), // 无
    video(80, { desc: '感谢某某赞助' }), // 一年半以前，窗口之外
  ],
};

async function run() {
  const videos = selectWindow(snapshot.videos, snapshot.capturedAt);
  const classified = await classifyVideos(videos);
  const account = classifyAccount(snapshot, videos);
  return score(snapshot, videos, classified.evidence, account, { llmUsed: classified.llmUsed });
}

describe('端到端', () => {
  it('分数与手算一致', async () => {
    const r = await run();

    // 窗口：21 条里有 1 条超过 12 个月，剩 20 条
    expect(r.content.sampleSize).toBe(20);
    expect(r.content.certainCount).toBe(3);
    expect(r.content.suspectedCount).toBe(1);

    // 占比 = (3 + 1 × 0.5) ÷ (20 + 5) = 0.14；内容层 = 60 × 0.14 ÷ 0.26 = 32.3（D-46）
    expect(r.content.ratio).toBeCloseTo(0.14);
    expect(r.content.point).toBeCloseTo(32.31, 1);
    // 下界 3 ÷ 25 = 0.12 → 27.7；上界 4 ÷ 25 = 0.16 → 36.9
    expect(r.content.low).toBeCloseTo(27.69, 1);
    expect(r.content.high).toBeCloseTo(36.92, 1);

    // 账号层：商务联系方式 11 + 充电 6 = 17（D-40）
    expect(r.account.score).toBe(17);
    expect(r.total.point).toBeCloseTo(49.31, 1);
    // 总分区间：下界 27.7 + 17；上界 36.9 + 17，再加未能检查的课程 6 分
    expect(r.total.low).toBeCloseTo(44.69, 1);
    expect(r.total.high).toBeCloseTo(59.92, 1);
    expect(r.band).toBe('mid');

    // 课程入口未能检查 → 置信度为中，不扣分
    expect(r.confidence.level).toBe('mid');
  });

  it('报告对应本次分析的创作者，并展示计算过程和依据', async () => {
    const html = renderToStaticMarkup(<ReportView report={await run()} />);

    expect(html).toContain('虚构的测评君');
    expect(html).toContain('UID 10086');
    // 计算过程带入了本次的真实数字
    expect(html).toContain('(3 + 1 × 0.5) ÷ (20 + 5) = 0.14');
    // 依据：原文引用与可点击的视频链接
    expect(html).toContain('感谢某某科技对本期视频的支持');
    expect(html).toContain('href="https://www.bilibili.com/video/BV0000000000"');
    expect(html).toContain('biz@example.com');
    // 被否定的「恰饭」不出现在依据里
    expect(html).not.toContain('这期不是恰饭');
    expect(html).toContain('未能检查');
    // 取到 21 条，窗口内 20 条，两个数字都要让人看到
    expect(html).toContain('本次取到 21 条');
    // 上界算进了未能检查的项，要说明是哪几项
    expect(html).toContain('付费课程，共 6 分');
  });

  it('区间跨档时明说「还不能确定属于哪一档」（D-29）', async () => {
    // 没有商务联系方式；1 条确证、2 条疑似 → 内容层 9.2 / 18.5 / 27.7，账号层充电 6，课程未能检查 6
    // 总分区间 15–40，跨了「低」和「中」
    const crossing: CreatorSnapshot = {
      ...snapshot,
      bio: '数码爱好者',
      videos: [
        video(1, { desc: '同款 https://item.taobao.com/item.htm?id=1' }),
        video(2, { desc: '粉丝专属福利，到手价 199' }),
        video(3, { desc: '限时优惠，现在下单' }),
        ...Array.from({ length: 17 }, (_, i) => video(4 + i)),
      ],
    };
    const videos = selectWindow(crossing.videos, crossing.capturedAt);
    const classified = await classifyVideos(videos);
    const report = score(crossing, videos, classified.evidence, classifyAccount(crossing, videos), {
      llmUsed: false,
    });
    expect(report.total.low).toBeLessThan(33);
    expect(report.total.high).toBeGreaterThanOrEqual(33);
    const html = renderToStaticMarkup(<ReportView report={report} />);
    expect(html).toContain('区间跨了「低」和「中');
  });

  it('取不到视频时不给指数，并把自检展开（D-27）', async () => {
    const failed: CreatorSnapshot = {
      ...snapshot,
      videos: [],
      videoSource: 'none',
      sources: [{ item: '视频列表', path: '接口 arc/search', ok: false, detail: 'code -352' }],
    };
    const report = score(failed, [], [], classifyAccount(failed, []), { llmUsed: false });
    const html = renderToStaticMarkup(<ReportView report={report} />);

    expect(html).toContain('本次无法给出指数');
    expect(html).toContain('没有取到这位创作者的视频列表');
    // 不能出现分档结论和总分算式
    expect(html).not.toContain('商业化程度：');
    expect(html).not.toContain('<h3>总分</h3>');
    // 账号层结果仍然展示
    expect(html).toContain('biz@example.com');
    // 自检默认展开，失败原因可见
    expect(html).toContain('<details open="">');
    expect(html).toContain('code -352');
  });

  it('只从页面读到 1 条窗口内的视频时也不给指数，并说明原因（D-44）', async () => {
    const few: CreatorSnapshot = {
      ...snapshot,
      videoSource: 'page',
      videos: [video(0), video(80), video(90)],
    };
    const videos = selectWindow(few.videos, few.capturedAt);
    const classified = await classifyVideos(videos);
    const report = score(few, videos, classified.evidence, classifyAccount(few, videos), {
      llmUsed: false,
    });
    const html = renderToStaticMarkup(<ReportView report={report} />);
    expect(html).toContain('本次无法给出指数');
    expect(html).toContain('其中 1 条在最近 12 个月内，少于 10 条');
    expect(html).not.toContain('商业化程度：');
  });
});

describe('确证的构成（D-35）', () => {
  it('带货和付费内容分开列出', async () => {
    const mixed: CreatorSnapshot = {
      ...snapshot,
      videos: [
        video(0, { desc: '同款 https://b23.tv/mall-abc' }),
        video(1, { badges: ['充电专属'] }),
        video(2, { badges: ['充电专属'] }),
        ...Array.from({ length: 10 }, (_, i) => video(3 + i)),
      ],
    };
    const videos = selectWindow(mixed.videos, mixed.capturedAt);
    const classified = await classifyVideos(videos);
    const report = score(mixed, videos, classified.evidence, classifyAccount(mixed, videos), {
      llmUsed: false,
    });
    const html = renderToStaticMarkup(<ReportView report={report} />);
    expect(html).toContain('（带货 1、付费内容 2）');
    expect(html).toContain('直接变现');
    expect(html).not.toContain('带货转化');
  });
});

describe('模型对照（不计分）', () => {
  it('列出模型与关键词的分歧和未采纳的输出', async () => {
    const report = await run();
    const html = renderToStaticMarkup(
      <ReportView
        report={report}
        llmCheck={{
          model: 'deepseek-chat',
          promptVersion: 'v2',
          sent: 17,
          requested: 17,
          judged: 16,
          rejected: [{ bvid: 'BV0000000007', reason: '引用不是原文：「xx」' }],
          used: false,
          rows: [
            {
              video: snapshot.videos[3]!,
              keyword: { bvid: snapshot.videos[3]!.bvid, tier: 'C', type: 'brand', quote: '粉丝专属福利', field: 'desc', source: 'rule', reason: 'C1' },
            },
          ],
        }}
      />,
    );
    expect(html).toContain('模型对照（不计分）：模型判疑似 0 条 · 关键词 1 条');
    expect(html).toContain('只有关键词判为疑似（1）');
    expect(html).toContain('本次计分采用关键词');
    expect(html).toContain('BV0000000007</a>：引用不是原文');
  });
});

describe('窗口之外的历史（D-45）', () => {
  // 真实情形：最近一年只发了 1 条，更早的视频置顶评论里挂过商品链接（第十次验证的小号）
  const inactive: CreatorSnapshot = {
    ...snapshot,
    videos: [
      video(4), // 窗口内，无商业内容
      video(70, { title: '旧视频一', pinnedComment: '同款在这 https://b23.tv/mall-RXUsO-72OkP' }),
      video(75, { title: '旧视频二', desc: '粉丝专属福利，到手价 99' }), // 只是疑似，不算
      video(90, { title: '旧视频三', desc: '感谢某某对本期视频的支持' }),
    ],
  };

  async function runInactive() {
    const videos = selectWindow(inactive.videos, inactive.capturedAt);
    const classified = await classifyVideos(videos);
    return score(inactive, videos, classified.evidence, classifyAccount(inactive, videos), {
      llmUsed: false,
      history: summarizeHistory(inactive.videos, videos),
    });
  }

  it('只统计窗口外的确证内容，不计分', async () => {
    const r = await runInactive();
    expect(r.content.sampleSize).toBe(1);
    expect(r.content.point).toBe(0);
    expect(r.history.checked).toBe(3);
    // 疑似不算；按发布时间从新到旧
    expect(r.history.videos.map((h) => h.video.title)).toEqual(['旧视频一', '旧视频三']);
    expect(r.history.videos[1]?.evidence.tier).toBe('A');
  });

  it('报告里单独展示，并说明不计分', async () => {
    const html = renderToStaticMarkup(<ReportView report={await runInactive()} />);
    expect(html).toContain('窗口之外（不计分）');
    expect(html).toContain('其中 2 条带确证的商业内容');
    expect(html).toContain('b23.tv/mall-RXUsO-72OkP');
  });

  it('没有窗口外的视频时不显示这一块', async () => {
    // 主算例里有一条一年半以前的视频（「感谢某某赞助」）
    const h = summarizeHistory(snapshot.videos, selectWindow(snapshot.videos, snapshot.capturedAt));
    expect(h?.checked).toBe(1);
    expect(h?.videos).toHaveLength(1);
    const none = score(snapshot, [], [], [], { llmUsed: false });
    expect(renderToStaticMarkup(<ReportView report={none} />)).not.toContain('窗口之外');
  });
});
