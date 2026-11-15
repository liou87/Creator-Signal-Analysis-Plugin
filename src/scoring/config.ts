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
    /** 占比达到多少算内容层满分。初值为假设，校准后取样本 P90（D-05） */
    ratioCap: number;
  };
  /** 账号层各指标分值。强 = 10，弱 = 5，只主张顺序（D-07） */
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
    ratioCap: 0.5,
  },
  account: {
    businessContact: { label: '商务合作联系方式', points: 10 },
    shop: { label: '小店 / 橱窗', points: 10 },
    course: { label: '付费课程', points: 5 },
    offsite: { label: '站外导流', points: 5 },
    org: { label: '机构 / MCN', points: 5 },
    charge: { label: '充电', points: 5 },
  },
  bands: { mid: 33, high: 66 },
  confidence: { minSample: 10 },
};
