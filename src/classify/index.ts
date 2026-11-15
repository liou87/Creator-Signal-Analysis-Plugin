import type { Evidence, VideoItem } from '../types';
import { classifySuspectedByLlm, type KeyValueStore, type LlmConfig } from './llm';
import { classifyVideoByRules } from './rules';

export interface ClassifyResult {
  evidence: Evidence[];
  /** 模型是否实际参与了 C 档判定 */
  llmUsed: boolean;
  llmError?: string;
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
    if (!result.error && result.judged === undecided.length) {
      return { evidence: [...certain, ...result.evidence], llmUsed: true };
    }
    return {
      evidence: videos.flatMap((v) => classifyVideoByRules(v, true)),
      llmUsed: false,
      llmError: result.error ?? '模型返回的结果不完整，已退回关键词识别',
    };
  }

  return { evidence: videos.flatMap((v) => classifyVideoByRules(v, true)), llmUsed: false };
}
