import type { Evidence, MonetizationType, TextField, Tier, VideoItem } from '../types';

/**
 * 规则分类。A、B 两档只由这里判定，模型不参与（D-10）。
 * 特征来源见 docs/DESIGN.md 3.2 与第 7 节：披露用语、购物链接、优惠码、行动引导。
 */

interface Rule {
  id: string;
  tier: Tier;
  type: MonetizationType;
  pattern: RegExp;
  /** 为 true 时，匹配前若紧跟否定词则不算（「这期不是恰饭」，D-09） */
  checkNegation?: boolean;
}

const NEGATION = /(不是|并非|没有|没|非|无|不|未|零|拒绝|绝不|从不)[^，。！？,.!?\n]{0,3}$/;

const NEGATION_INSIDE = /不含|不包含|不是|并非|没有|未含|无任何|零广告/;

const SHOP_DOMAINS =
  'taobao\\.com|tmall\\.com|tb\\.cn|jd\\.com|3\\.cn|yangkeduo\\.com|pinduoduo\\.com|' +
  'weidian\\.com|youzan\\.com|mall\\.bilibili\\.com|gaoneng\\.bilibili\\.com|' +
  'show\\.bilibili\\.com|xiaohongshu\\.com/goods|haohuo\\.jinritemai\\.com|v\\.douyin\\.com';

export const RULES: Rule[] = [
  // ── A 明确披露：创作者自己承认 ──────────────────────────────
  {
    id: 'A1-声明',
    tier: 'A',
    type: 'brand',
    pattern: /本(视频|期|片|条)[^，。\n]{0,8}(含|包含|为|是|有)[^，。\n]{0,6}(广告|商业合作|商业推广|商单|推广内容)/,
    checkNegation: true,
  },
  {
    id: 'A2-感谢赞助',
    tier: 'A',
    type: 'brand',
    pattern: /感谢[^，。\n]{1,24}(赞助|对本(期|视频)[^，。\n]{0,6}支持|提供的?(样机|样品|产品|设备|试用))/,
  },
  {
    id: 'A3-品牌方提供',
    tier: 'A',
    type: 'brand',
    pattern: /(品牌方|厂商|厂家|官方)(提供|送测|寄来|寄送|赞助|借测)/,
  },
  {
    id: 'A4-合作标注',
    tier: 'A',
    type: 'brand',
    pattern: /(本期|本视频|视频)(由|与)[^，。\n]{1,24}(赞助|合作|联合)(播出|出品|制作|推出)?|[#＃【\[](广告|商业合作|合作推广|赞助)[#＃】\]]/,
  },
  {
    id: 'A5-恰饭',
    tier: 'A',
    type: 'brand',
    pattern: /恰饭|金主爸爸|甲方爸爸|商单视频/,
    checkNegation: true,
  },

  // ── B 带货转化：推荐 + 购买方式（《互联网广告管理办法》第九条）──
  {
    id: 'B1-购物链接',
    tier: 'B',
    type: 'brand',
    pattern: new RegExp(`(https?://)?[\\w.-]*(${SHOP_DOMAINS})[^\\s，。）)】]*`, 'i'),
  },
  {
    id: 'B2-淘口令',
    tier: 'B',
    type: 'brand',
    pattern: /[￥¥€₤₳¢¤฿₵£][A-Za-z0-9]{8,13}[￥¥€₤₳¢¤฿₵£]/,
  },
  {
    id: 'B3-优惠码',
    tier: 'B',
    type: 'brand',
    pattern: /(优惠码|折扣码|优惠券|领券|口令|暗号)[^，。\n]{0,10}[:：「“"]\s*\S{2,}/,
  },
  {
    id: 'B4-链接引导',
    tier: 'B',
    type: 'brand',
    pattern: /(购买|下单|同款|商品|产品|专属|优惠|活动)(链接|地址|入口|通道)|蓝链|(链接|购买方式|同款)[^，。\n]{0,6}(在|见|看|戳)[^，。\n]{0,4}(评论区|置顶|简介)|(评论区|置顶)[^，。\n]{0,8}(链接|下单|购买|领券)/,
    checkNegation: true,
  },
  {
    id: 'B5-自营店铺',
    tier: 'B',
    type: 'self',
    pattern: /(我的|自家|本人|咱家|我们的?)[^，。\n]{0,4}(店铺|小店|淘宝店|网店|周边)|(店铺|淘宝店|网店)(名|名称)?[:：]\s*\S{2,}|周边[^，。\n]{0,6}(开售|预售|上架|购买)/,
  },
  {
    id: 'B6-付费课程',
    tier: 'B',
    type: 'knowledge',
    pattern: /(课程|网课|训练营|专栏|小册|电子书)[^，。\n]{0,10}(报名|购买|开售|上线|链接|优惠|已上架)|(报名|购买)[^，。\n]{0,6}(课程|训练营)/,
    checkNegation: true,
  },
  {
    id: 'B7-充电专属',
    tier: 'B',
    type: 'fan',
    pattern: /充电专属|包月充电[^，。\n]{0,8}(可看|观看|解锁)|付费(视频|内容)/,
    checkNegation: true,
  },

  // ── C 疑似软广（无模型时的退化方案）：行动引导但无披露无链接（D-08）──
  {
    id: 'C1-行动引导',
    tier: 'C',
    type: 'brand',
    pattern: /(粉丝|专属|限时|独家)(专属)?(福利|优惠|折扣|特价|价)|到手价|首发价|立减\s*\d|(现在|立即|赶紧|快去)(下单|购买|入手|抢)|(搜索?|搜)[^，。\n]{1,12}(即可|就能|就可以)?(购买|下单|领取)|(官方)?旗舰店|闭眼入|(强烈|真心|良心)推荐[^，。\n]{0,10}(入手|购买|下单)/,
    checkNegation: true,
  },
];

/** 简介里的商务联系方式脚注。属于账号层信号，不是「这条视频是广告」的披露 */
export const BUSINESS_CONTACT =
  /(商务|商业|合作|广告|推广|品牌)[^，。\n]{0,10}(合作|联系|洽谈|对接|投放|邮箱|微信|vx|v信|wx|qq)[^，。\n]{0,10}([:：]|@|私信|➕|\+)|(商务|合作)[^\n]{0,20}[\w.+-]+@[\w-]+\.[\w.]+/i;

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 14);
  const end = Math.min(text.length, index + length + 14);
  // 不跨行，保证引用可读
  let quote = text.slice(start, end);
  const matchOffset = index - start;
  const before = quote.slice(0, matchOffset);
  const after = quote.slice(matchOffset + length);
  const cutBefore = before.lastIndexOf('\n');
  const cutAfter = after.indexOf('\n');
  quote =
    (cutBefore >= 0 ? before.slice(cutBefore + 1) : before) +
    quote.slice(matchOffset, matchOffset + length) +
    (cutAfter >= 0 ? after.slice(0, cutAfter) : after);
  return quote.trim();
}

export function videoFields(video: VideoItem): Array<{ field: TextField; text: string }> {
  const fields: Array<{ field: TextField; text: string }> = [
    { field: 'title', text: video.title },
  ];
  if (video.desc) fields.push({ field: 'desc', text: video.desc });
  if (video.tags?.length) fields.push({ field: 'tags', text: video.tags.join(' ') });
  if (video.pinnedComment) fields.push({ field: 'pinnedComment', text: video.pinnedComment });
  return fields;
}

function applyRules(
  bvid: string,
  field: TextField,
  text: string,
  rules: Rule[],
): Evidence[] {
  const found: Evidence[] = [];
  // 去掉商务联系脚注再匹配，避免把「商务合作：xxx」当成本条视频的广告声明
  const cleaned = text.replace(new RegExp(BUSINESS_CONTACT.source + '[^\\n]*', 'gi'), (m) =>
    ' '.repeat(m.length),
  );
  for (const rule of rules) {
    const m = rule.pattern.exec(cleaned);
    if (!m) continue;
    if (
      rule.checkNegation &&
      // 否定词可能在匹配之前（「不是恰饭」），也可能在匹配之内（「本视频不含广告」）
      (NEGATION.test(cleaned.slice(Math.max(0, m.index - 8), m.index)) ||
        NEGATION_INSIDE.test(m[0]))
    ) {
      continue;
    }
    found.push({
      bvid,
      tier: rule.tier,
      type: rule.type,
      quote: quoteAround(text, m.index, m[0].length),
      field,
      source: 'rule',
      reason: rule.id,
    });
  }
  return found;
}

/**
 * @param includeSuspected 是否启用 C 档关键词。有模型时由模型判定 C 档，这里传 false
 */
export function classifyVideoByRules(video: VideoItem, includeSuspected: boolean): Evidence[] {
  const rules = includeSuspected ? RULES : RULES.filter((r) => r.tier !== 'C');
  const found = videoFields(video).flatMap(({ field, text }) =>
    applyRules(video.bvid, field, text, rules),
  );

  // 置顶评论里的商品链接：平台标记为商品，或跳转到购物网站。
  // 这是结构化事实而不是文字匹配，所以单独处理。
  const shop = new RegExp(SHOP_DOMAINS, 'i');
  for (const link of video.pinnedLinks ?? []) {
    if (!link.isGoods && !shop.test(link.target)) continue;
    // 引用必须是评论原文的子串，否则不采信
    if (!link.keyword || !video.pinnedComment?.includes(link.keyword)) continue;
    found.push({
      bvid: video.bvid,
      tier: 'B',
      type: 'brand',
      quote: link.keyword,
      field: 'pinnedComment',
      source: 'rule',
      reason: 'B8-评论商品链接',
    });
    break;
  }
  return found;
}
