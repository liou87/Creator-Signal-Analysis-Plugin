import { describe, expect, it } from 'vitest';
import { score } from '../src/scoring/score';
import { DEFAULT_CONFIG, type ScoringConfig } from '../src/scoring/config';
import type { AccountFinding, AccountSignalId, Evidence, VideoItem } from '../src/types';

/**
 * 校准数据（docs/CALIBRATION.md，2026-11-18 第十一次验证）。
 * 只记评分需要的输入：窗口内样本数、确证条数、疑似条数、账号层各项状态。
 * 用真实的 score() 重算，保证文档里的校准结论可以复现；以后改参数时，
 * 这里会告诉你区分度和分档是否还成立。
 */

type Group = '低分组' | '不活跃' | '活跃';
interface Point {
  name: string;
  group: Group;
  n: number;
  certain: number;
  suspected: number;
  yes: AccountSignalId[];
  unknown: AccountSignalId[];
}

// D-53：充电只认样本里的充电专属视频（食贫道）。颜辰鑫、极客湾、何同学、大物是也原来的「有」
// 来自 acc/info 的 elec 字段，该字段含义未证实，改为未能检查。
const DATA: Point[] = [
  { name: '共青团中央', group: '低分组', n: 30, certain: 0, suspected: 0, yes: [], unknown: ['charge'] },
  { name: '华西医院', group: '低分组', n: 30, certain: 0, suspected: 0, yes: [], unknown: ['charge'] },
  { name: '颜辰鑫', group: '低分组', n: 2, certain: 0, suspected: 0, yes: [], unknown: ['charge'] },
  { name: 'JOYE呗', group: '不活跃', n: 1, certain: 0, suspected: 0, yes: [], unknown: ['charge'] },
  { name: '所长林超', group: '不活跃', n: 6, certain: 0, suspected: 0, yes: ['course'], unknown: ['charge'] },
  { name: '极客湾', group: '活跃', n: 30, certain: 0, suspected: 0, yes: ['businessContact'], unknown: ['charge'] },
  { name: '影视飓风', group: '活跃', n: 30, certain: 4, suspected: 0, yes: ['businessContact', 'shop', 'course'], unknown: ['charge'] },
  { name: '何同学', group: '活跃', n: 18, certain: 4, suspected: 0, yes: ['businessContact'], unknown: ['charge'] },
  // D-49：置顶评论「去我首页小店里看一下」→ 该视频由疑似外的「无」变为确证，店铺为有
  { name: '大物是也', group: '活跃', n: 30, certain: 9, suspected: 1, yes: ['shop'], unknown: ['charge'] },
  { name: '食贫道', group: '活跃', n: 30, certain: 13, suspected: 0, yes: ['businessContact', 'charge'], unknown: [] },
];

const NOW = Date.UTC(2026, 10, 18);
const IDS = Object.keys(DEFAULT_CONFIG.account) as AccountSignalId[];

function run(p: Point, config: ScoringConfig = DEFAULT_CONFIG) {
  const videos: VideoItem[] = Array.from({ length: p.n }, (_, i) => ({
    bvid: `${p.name}-${i}`,
    title: '',
    url: '',
    pubdate: NOW / 1000 - i * 86400,
  }));
  const evidence: Evidence[] = videos
    .slice(0, p.certain + p.suspected)
    .map((v, i) => ({
      bvid: v.bvid,
      tier: i < p.certain ? 'B' : 'C',
      type: 'goods',
      quote: 'x',
      field: 'pinnedComment',
      source: 'rule',
      reason: 'calibration',
    }));
  const account: AccountFinding[] = IDS.map((id) => ({
    id,
    state: p.yes.includes(id) ? 'yes' : p.unknown.includes(id) ? 'unknown' : 'no',
  }));
  return score(
    { mid: '0', name: p.name, capturedAt: NOW, sources: [], videos, videoSource: 'latest' },
    videos,
    evidence,
    account,
    { llmUsed: false, config },
  );
}

/** 线性插值的分位数（与常见统计软件的默认做法一致） */
function quantile(xs: number[], q: number): number {
  const a = [...xs].sort((x, y) => x - y);
  const pos = q * (a.length - 1);
  const lo = Math.floor(pos);
  return a[lo]! + (pos - lo) * ((a[lo + 1] ?? a[lo]!) - a[lo]!);
}

/** 区分度：低分组的区间上界，低于活跃组的最低点估计 */
function separated(config: ScoringConfig): boolean {
  const lowMax = Math.max(...DATA.filter((p) => p.group === '低分组').map((p) => run(p, config).total.high));
  const activeMin = Math.min(...DATA.filter((p) => p.group === '活跃').map((p) => run(p, config).total.point));
  return lowMax < activeMin;
}

describe('封顶值来自样本（D-05、D-46）', () => {
  it('封顶值 = 全部 10 位占比的 90 分位数，保留两位小数', () => {
    const ratios = DATA.map((p) => run(p).content.ratio);
    const p90 = quantile(ratios, 0.9);
    // 第十一次验证的数据为 0.256（D-46）；D-49 修正店铺规则后为 0.281（D-51）
    expect(p90).toBeCloseTo(0.281, 3);
    expect(DEFAULT_CONFIG.content.ratioCap).toBe(Math.round(p90 * 100) / 100);
  });
});

describe('区分度与分档（第十一次验证的数据）', () => {
  it('低分组与活跃组不重叠', () => {
    expect(separated(DEFAULT_CONFIG)).toBe(true);
  });

  it('分档与 CALIBRATION.md 记录的一致', () => {
    const bands = Object.fromEntries(DATA.map((p) => [p.name, run(p).band]));
    expect(bands).toEqual({
      共青团中央: 'low',
      华西医院: 'low',
      颜辰鑫: 'low',
      JOYE呗: 'low',
      所长林超: 'low',
      极客湾: 'low', // 可见的只有商务邮箱和充电；商单在口播里，按定义看不到
      影视飓风: 'mid',
      何同学: 'mid',
      大物是也: 'high', // D-49：自家小店的引导算确证，店铺为有
      食贫道: 'high',
    });
  });
});

describe('敏感性：参数变化时两组是否还分得开', () => {
  const scaleAccount = (f: (id: AccountSignalId, pts: number) => number): ScoringConfig['account'] =>
    Object.fromEntries(
      IDS.map((id) => [id, { ...DEFAULT_CONFIG.account[id], points: f(id, DEFAULT_CONFIG.account[id].points) }]),
    ) as ScoringConfig['account'];
  const strong = (id: AccountSignalId) => id === 'businessContact' || id === 'shop';
  const c = DEFAULT_CONFIG;

  const variants: Array<[string, ScoringConfig]> = [
    ['k = 3', { ...c, content: { ...c.content, shrinkage: 3 } }],
    ['k = 10', { ...c, content: { ...c.content, shrinkage: 10 } }],
    ['内容 50 / 账号 50', { ...c, content: { ...c.content, max: 50 }, account: scaleAccount((_, p) => (p * 50) / 40) }],
    ['内容 70 / 账号 30', { ...c, content: { ...c.content, max: 70 }, account: scaleAccount((_, p) => (p * 30) / 40) }],
    ['强项 +20%', { ...c, account: scaleAccount((id, p) => (strong(id) ? p * 1.2 : p)) }],
    ['弱项 +20%', { ...c, account: scaleAccount((id, p) => (strong(id) ? p : p * 1.2)) }],
    ['疑似档按 1 计', { ...c, content: { ...c.content, tierWeight: { ...c.content.tierWeight, C: 1 } } }],
  ];

  it.each(variants)('%s', (_, config) => {
    expect(separated(config)).toBe(true);
  });
});
