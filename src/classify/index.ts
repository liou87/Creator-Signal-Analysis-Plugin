import type { Evidence, VideoItem } from '../types';
import {
  classifySuspectedByLlm,
  PROMPT_VERSION,
  type KeyValueStore,
  type LlmConfig,
  type LlmRejection,
} from './llm';
import { classifyVideoByRules } from './rules';

/** 模型与关键词对同一条视频的疑似判定。只用于自检，不计分 */
export interface SuspectedComparison {
  video: VideoItem;
  llm?: Evidence;
  keyword?: Evidence;
}

/**
 * 模型对照（不计分）。配置了模型时才有。
 * 计分只用其中一种口径（D-22）；这里把两种都列出来，用来验证模型判得对不对。
 */
export interface LlmCheck {
  model: string;
  promptVersion: string;
  /** 送去判定的条数：规则没有判为确证的视频 */
  sent: number;
  /** 其中实际请求了模型的条数，其余来自缓存 */
  requested: number;
  judged: number;
  rejected: LlmRejection[];
  error?: string;
  /** 本次计分是否采用了模型的结论 */
  used: boolean;
  /** 至少一方判为疑似的视频 */
  rows: SuspectedComparison[];
}

export interface ClassifyResult {
  evidence: Evidence[];
  /** 模型是否实际参与了 C 档判定 */
  llmUsed: boolean;
  llmError?: string;
  llmCheck?: LlmCheck;
}

/** 按视频对齐两种口径的疑似判定。导出以便测试 */
export function compareSuspected(
  videos: VideoItem[],
  llm: Evidence[],
  keyword: Evidence[],
): SuspectedComparison[] {
  return videos.flatMap((video) => {
    const l = llm.find((e) => e.bvid === video.bvid && e.tier === 'C');
    const k = keyword.find((e) => e.bvid === video.bvid && e.tier === 'C');
    return l || k ? [{ video, llm: l, keyword: k }] : [];
  });
}

/**
 * 分类入口。
 * - A、B 两档：只由规则判定。
 * - C 档：配置了模型且调用成功时由模型判定；否则退化为关键词。
 */
export async function classifyVideos(
  videos: VideoItem[],
  llm?: LlmConfig,
  cache?: KeyValueStore,
): Promise<ClassifyResult> {
  const certain = videos.flatMap((v) => classifyVideoByRules(v, false));

  if (llm) {
    const decided = new Set(certain.map((e) => e.bvid));
    const undecided = videos.filter((v) => !decided.has(v.bvid));
    const result = await classifySuspectedByLlm(undecided, llm, cache);
    // 只要模型判定了全部待定视频，就算模型生效；否则整体退回关键词，避免两种口径混用
    const used = !result.error && result.judged === undecided.length;
    const keyword = undecided.flatMap((v) => classifyVideoByRules(v, true));
    const llmCheck: LlmCheck = {
      model: llm.model,
      promptVersion: PROMPT_VERSION,
      sent: undecided.length,
      requested: result.requested,
      judged: result.judged,
      rejected: result.rejected,
      error: result.error,
      used,
      rows: compareSuspected(undecided, result.evidence, keyword),
    };
    if (used) {
      return { evidence: [...certain, ...result.evidence], llmUsed: true, llmCheck };
    }
    return {
      evidence: videos.flatMap((v) => classifyVideoByRules(v, true)),
      llmUsed: false,
      llmError: result.error ?? '模型返回的结果不完整，已退回关键词识别',
      llmCheck,
    };
  }

  return { evidence: videos.flatMap((v) => classifyVideoByRules(v, true)), llmUsed: false };
}
