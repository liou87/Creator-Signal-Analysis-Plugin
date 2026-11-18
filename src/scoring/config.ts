import type { AccountSignalId, Tier } from '../types';

/**
 * 所有评分参数的唯一出处。每一项的含义和来源见 docs/DESIGN.md，
 * 取舍记录见 docs/DECISIONS.md。改这里必须同步改文档。
 */
export interface ScoringConfig {
  window: {
    /** 最多取多少条视频（D-04） */
    maxVideos: number;
    /** 只取多少个月以内的视频（D-04） */
    maxAgeMonths: number;
  };
  content: {
    /** 内容层满分（D-02、D-07） */
    max: number;
    /** 各档单条权重。C 为点估计用的先验值（D-06） */
    tierWeight: Record<Tier, number>;
    /** 区间下界、上界使用的 C 档权重（D-15） */
    suspectedWeightRange: { low: number; high: number };
    /** 收缩参数 k：r̂ = Σw / (n + k)（D-03） */
    shrinkage: number;
    /**
     * 占比达到多少算内容层满分。取 10 位验证样本占比的 90 分位数（D-05、D-46）。
     * D-49 修正店铺规则后，大物是也多了 1 条确证，90 分位数由 0.256 变为 0.281，按同一办法改为 0.28（D-51）
     */
    ratioCap: number;
    /**
     * 视频列表只来自当前页面时，窗口内至少要有多少条才给指数。
     * 页面上的不一定是最新投稿，样本又少，就分不清「不做」和「看不出来」（D-44）
     */
    minPageSample: number;
  };
  /** 账号层各指标分值。强 = 11，弱 = 6，只主张「强高于弱」，不主张比例（D-07、D-40） */
  account: Record<AccountSignalId, { label: string; points: number }>;
  /** 三档分界：point < low 为低，>= high 为高（D-15） */
  bands: { mid: number; high: number };
  confidence: {
    /** 样本少于此数记为低置信 */
    minSample: number;
  };
}

export const DEFAULT_CONFIG: ScoringConfig = {
  window: { maxVideos: 30, maxAgeMonths: 12 },
  content: {
    max: 60,
    tierWeight: { A: 1, B: 1, C: 0.5 },
    suspectedWeightRange: { low: 0, high: 1 },
    shrinkage: 5,
    ratioCap: 0.28,
    minPageSample: 10,
  },
  account: {
    businessContact: { label: '商务合作联系方式', points: 11 },
    shop: { label: '公开说明的店铺', points: 11 },
    course: { label: '付费课程', points: 6 },
    paidCommunity: { label: '站外付费社群', points: 6 },
    charge: { label: '充电', points: 6 },
  },
  bands: { mid: 33, high: 66 },
  confidence: { minSample: 10 },
};
