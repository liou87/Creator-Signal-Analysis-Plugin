/**
 * 模块之间唯一的接口：CreatorSnapshot → Evidence[] → Report。
 * 见 docs/ARCHITECTURE.md。
 */

/** 证据档位。A 明确披露、B 带货转化、C 疑似软广。定义见 docs/DESIGN.md 3.2 */
export type Tier = 'A' | 'B' | 'C';

/** 变现类型。不影响分数，帮助判断此人做的是哪种生意 */
export type MonetizationType = 'brand' | 'self' | 'knowledge' | 'fan';

/** 三态：有 / 无 / 未能检查。没抓到不等于没有（D-13） */
export type Tri = 'yes' | 'no' | 'unknown';

export type TextField = 'title' | 'desc' | 'tags' | 'pinnedComment' | 'bio';

export interface VideoItem {
  bvid: string;
  title: string;
  url: string;
  /** 发布时间，Unix 秒。取不到时为 undefined */
  pubdate?: number;
  desc?: string;
  tags?: string[];
  /** UP 主置顶的评论正文。B 站带货蓝链多在这里（D-12） */
  pinnedComment?: string;
  /**
   * 置顶评论里平台渲染成可点击链接的片段。提取层只记录事实，是否算带货由分类层判断。
   * keyword 是评论正文里的原文片段。
   */
  pinnedLinks?: PinnedLink[];
}

export interface PinnedLink {
  keyword: string;
  /** 跳转目标地址，可能为空 */
  target: string;
  /** 平台是否把它标记为商品链接 */
  isGoods: boolean;
}

/**
 * 视频列表从哪里来：
 *   api  接口返回的最近投稿，可以认为是完整的
 *   page 只是当前页面上看得到的视频，不一定是最近的投稿
 *   none 所有路径都没走通
 */
export type VideoSource = 'api' | 'page' | 'none';

/** 提取层对每个数据源的自检结果（D-17） */
export interface SourceStatus {
  item: string;
  path: string;
  ok: boolean;
  detail?: string;
}

export interface CreatorSnapshot {
  mid: string;
  name: string;
  /** 个人简介。null 表示未能取到（区别于取到了但为空） */
  bio: string | null;
  /** 认证信息，如「bilibili 知名UP主」或机构认证文案。null 表示未能取到 */
  officialTitle: string | null;
  /** 由页面或接口直接观察到的入口。文本类信号（商务联系方式等）由分类层从 bio 推出 */
  hasCharge: Tri;
  hasShop: Tri;
  hasCourse: Tri;
  videos: VideoItem[];
  /** 视频列表的来源。决定了「取到 0 条」该如何解读（D-27） */
  videoSource: VideoSource;
  /** 采集时间，Unix 毫秒。评分引擎用它而不是系统时钟，保证可复现 */
  capturedAt: number;
  sources: SourceStatus[];
}

export interface Evidence {
  bvid: string;
  tier: Tier;
  type: MonetizationType;
  /** 原文引用。必须是对应字段文本的子串 */
  quote: string;
  field: TextField;
  source: 'rule' | 'llm';
  /** 命中的规则编号或模型给出的理由 */
  reason: string;
}

export type AccountSignalId =
  | 'businessContact'
  | 'shop'
  | 'course'
  | 'offsite'
  | 'org'
  | 'charge';

export interface AccountFinding {
  id: AccountSignalId;
  state: Tri;
  /** state 为 yes 时的依据：原文引用或「页面存在该入口」 */
  basis?: string;
}

export type Band = 'low' | 'mid' | 'high';
export type Confidence = 'low' | 'mid' | 'high';

export interface ScoreTriple {
  /** 下界：疑似档权重取 0 */
  low: number;
  /** 点估计 */
  point: number;
  /** 上界：疑似档权重取 1 */
  high: number;
}

export interface VideoVerdict {
  video: VideoItem;
  /** 该视频命中的最高档；未命中为 null */
  tier: Tier | null;
  evidence: Evidence[];
}

export interface Report {
  creator: { mid: string; name: string };
  analyzedAt: number;
  total: ScoreTriple;
  band: Band;
  content: ScoreTriple & {
    max: number;
    sampleSize: number;
    certainCount: number;
    suspectedCount: number;
    /** 点估计下的收缩占比 r̂ */
    ratio: number;
    /** 样本覆盖的时间段，Unix 秒 */
    span?: { from: number; to: number };
    /**
     * 内容层是否评估得了。取不到视频不等于没有商业内容（D-27）。
     * 为 false 时 total 与 band 没有意义，界面不得把它们当作指数展示
     */
    assessed: boolean;
    source: VideoSource;
    /** 取样之前取到的视频总数 */
    fetched: number;
    /** 取到的视频里最新一条的发布时间，Unix 秒 */
    latestPubdate?: number;
  };
  account: {
    score: number;
    max: number;
    items: Array<AccountFinding & { label: string; points: number; earned: number }>;
  };
  typeCounts: Record<MonetizationType, number>;
  verdicts: VideoVerdict[];
  confidence: { level: Confidence; reasons: string[] };
  /** 本次是否使用了模型判定疑似档 */
  llmUsed: boolean;
  sources: SourceStatus[];
}
