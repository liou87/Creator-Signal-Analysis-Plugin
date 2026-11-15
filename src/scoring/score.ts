import type {
  AccountFinding,
  AccountSignalId,
  Band,
  Confidence,
  CreatorSnapshot,
  Evidence,
  MonetizationType,
  Report,
  ScoreTriple,
  Tier,
  VideoItem,
  VideoVerdict,
} from '../types';
import { DEFAULT_CONFIG, type ScoringConfig } from './config';

/**
 * 评分引擎。纯函数：不读时钟、不访问网络、不依赖浏览器。
 * 同样的输入永远得到同样的输出。公式见 docs/DESIGN.md 第 3、4 节。
 */

const TIER_RANK: Record<Tier, number> = { A: 3, B: 2, C: 1 };

/** 取样窗口：最近 maxVideos 条，且不早于 maxAgeMonths 个月前（D-04） */
export function selectWindow(
  videos: VideoItem[],
  capturedAt: number,
  cfg: ScoringConfig = DEFAULT_CONFIG,
): VideoItem[] {
  const cutoff = capturedAt / 1000 - cfg.window.maxAgeMonths * 30 * 86400;
  return [...videos]
    // 没有发布时间的视频保留：无法判断新旧时不应丢弃样本
    .filter((v) => v.pubdate === undefined || v.pubdate >= cutoff)
    .sort((a, b) => (b.pubdate ?? 0) - (a.pubdate ?? 0))
    .slice(0, cfg.window.maxVideos);
}

/** 每条视频归入它命中的最高一档 */
export function buildVerdicts(videos: VideoItem[], evidence: Evidence[]): VideoVerdict[] {
  const byVideo = new Map<string, Evidence[]>();
  for (const e of evidence) {
    const list = byVideo.get(e.bvid) ?? [];
    list.push(e);
    byVideo.set(e.bvid, list);
  }
  return videos.map((video) => {
    const list = (byVideo.get(video.bvid) ?? []).sort(
      (a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier],
    );
    return { video, tier: list[0]?.tier ?? null, evidence: list };
  });
}

function contentScore(
  certain: number,
  suspected: number,
  n: number,
  suspectedWeight: number,
  cfg: ScoringConfig,
): { score: number; ratio: number } {
  const ratio = (certain + suspected * suspectedWeight) / (n + cfg.content.shrinkage);
  const score = cfg.content.max * Math.min(1, ratio / cfg.content.ratioCap);
  return { score, ratio };
}

function bandOf(point: number, cfg: ScoringConfig): Band {
  if (point >= cfg.bands.high) return 'high';
  if (point >= cfg.bands.mid) return 'mid';
  return 'low';
}

export function score(
  snapshot: Pick<CreatorSnapshot, 'mid' | 'name' | 'capturedAt' | 'sources'>,
  /** 已经过 selectWindow 的视频 */
  videos: VideoItem[],
  evidence: Evidence[],
  account: AccountFinding[],
  options: { llmUsed: boolean; config?: ScoringConfig },
): Report {
  const cfg = options.config ?? DEFAULT_CONFIG;
  const verdicts = buildVerdicts(videos, evidence);
  const n = verdicts.length;

  // A、B 两档权重相同，合称「确证」；C 为「疑似」
  const weightOfCertain = (t: Tier) => cfg.content.tierWeight[t];
  const certain = verdicts
    .filter((v) => v.tier === 'A' || v.tier === 'B')
    .reduce((sum, v) => sum + weightOfCertain(v.tier as Tier), 0);
  const certainCount = verdicts.filter((v) => v.tier === 'A' || v.tier === 'B').length;
  const suspectedCount = verdicts.filter((v) => v.tier === 'C').length;

  const point = contentScore(certain, suspectedCount, n, cfg.content.tierWeight.C, cfg);
  const low = contentScore(certain, suspectedCount, n, cfg.content.suspectedWeightRange.low, cfg);
  const high = contentScore(certain, suspectedCount, n, cfg.content.suspectedWeightRange.high, cfg);

  const stateOf = new Map(account.map((a) => [a.id, a]));
  const items = (Object.keys(cfg.account) as AccountSignalId[]).map((id) => {
    const finding = stateOf.get(id) ?? { id, state: 'unknown' as const };
    const { label, points } = cfg.account[id];
    return { ...finding, label, points, earned: finding.state === 'yes' ? points : 0 };
  });
  const accountScore = items.reduce((s, i) => s + i.earned, 0);
  const accountMax = items.reduce((s, i) => s + i.points, 0);

  const total: ScoreTriple = {
    low: low.score + accountScore,
    point: point.score + accountScore,
    high: high.score + accountScore,
  };

  const typeCounts: Record<MonetizationType, number> = { brand: 0, self: 0, knowledge: 0, fan: 0 };
  for (const v of verdicts) {
    const top = v.evidence[0];
    if (top) typeCounts[top.type] += 1;
  }

  const dates = videos.map((v) => v.pubdate).filter((d): d is number => d !== undefined);
  const span = dates.length
    ? { from: Math.min(...dates), to: Math.max(...dates) }
    : undefined;

  // 置信度：样本太少为低；有未能检查的项为中；否则为高
  const reasons: string[] = [];
  let level: Confidence = 'high';
  const unknownItems = items.filter((i) => i.state === 'unknown');
  if (unknownItems.length > 0) {
    level = 'mid';
    reasons.push(`未能检查：${unknownItems.map((i) => i.label).join('、')}`);
  }
  if (n < cfg.confidence.minSample) {
    level = 'low';
    reasons.push(`样本仅 ${n} 条视频（少于 ${cfg.confidence.minSample} 条）`);
  }
  if (!options.llmUsed) {
    reasons.push('未使用模型，疑似软广仅靠关键词识别，可能漏判');
  }

  return {
    creator: { mid: snapshot.mid, name: snapshot.name },
    analyzedAt: snapshot.capturedAt,
    total,
    band: bandOf(total.point, cfg),
    content: {
      low: low.score,
      point: point.score,
      high: high.score,
      max: cfg.content.max,
      sampleSize: n,
      certainCount,
      suspectedCount,
      ratio: point.ratio,
      span,
    },
    account: { score: accountScore, max: accountMax, items },
    typeCounts,
    verdicts,
    confidence: { level, reasons },
    llmUsed: options.llmUsed,
    sources: snapshot.sources,
  };
}
