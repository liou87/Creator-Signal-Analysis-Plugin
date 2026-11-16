import type {
  CreatorSnapshot,
  PinnedLink,
  SourceStatus,
  Tri,
  VideoItem,
  VideoSource,
} from '../types';
import { midFromUrl, nameFromTitle } from './identify';
import { keysFromNav, signQuery, type WbiKeys } from './wbi';

/**
 * B 站数据提取。在内容脚本里运行（空间页的上下文，带页面自己的 Cookie）。
 *
 * 每项数据都有主、备两条路径，并把每条路径是否成功记进 sources，
 * 报告里的「数据来源」一节原样展示。这就是数据源自检（D-17）：
 * 接口可用性无法在开发环境验证，只能在真实页面上看结果。
 *
 * 只读取公开内容，不读登录态下的私有数据（D-16）。
 */

const API = 'https://api.bilibili.com';
const MAX_VIDEOS = 30;
const CONCURRENCY = 2;
const REQUEST_GAP_MS = 150;

type Progress = (text: string) => void;

interface ApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as ApiResponse<T>;
  if (json.code !== 0 || json.data === undefined) {
    throw new Error(`code ${json.code} ${json.message ?? ''}`.trim());
  }
  return json.data;
}

class Collector {
  readonly sources: SourceStatus[] = [];
  ok(item: string, path: string, detail?: string) {
    this.sources.push({ item, path, ok: true, detail });
  }
  fail(item: string, path: string, error: unknown) {
    this.sources.push({
      item,
      path,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function loadWbiKeys(c: Collector): Promise<WbiKeys | null> {
  try {
    // nav 在未登录时 code 为 -101，但 data.wbi_img 仍然存在，所以不走 getJson
    const res = await fetch(`${API}/x/web-interface/nav`, { credentials: 'include' });
    const json = (await res.json()) as {
      data?: { wbi_img?: { img_url?: string; sub_url?: string } };
    };
    const img = json.data?.wbi_img;
    if (!img?.img_url || !img.sub_url) throw new Error('返回中没有签名密钥');
    c.ok('签名密钥', '接口 nav');
    return keysFromNav(img.img_url, img.sub_url);
  } catch (e) {
    c.fail('签名密钥', '接口 nav', e);
    return null;
  }
}

function signed(path: string, params: Record<string, string | number>, keys: WbiKeys): string {
  return `${API}${path}?${signQuery(params, keys, Math.floor(Date.now() / 1000))}`;
}

// ── 账号信息 ────────────────────────────────────────────────

interface AccInfo {
  name?: string;
  sign?: string;
  official?: { title?: string; desc?: string };
  elec?: { show_info?: { show?: boolean } };
}

export interface Profile {
  name: string | null;
  bio: string | null;
  officialTitle: string | null;
  charge: Tri;
}

async function loadProfile(mid: string, keys: WbiKeys | null, c: Collector): Promise<Profile> {
  if (keys) {
    try {
      const d = await getJson<AccInfo>(
        signed('/x/space/wbi/acc/info', { mid, platform: 'web' }, keys),
      );
      c.ok('昵称、简介、认证', '接口 acc/info');
      const show = d.elec?.show_info?.show;
      return {
        name: d.name ?? null,
        bio: d.sign ?? '',
        officialTitle: [d.official?.title, d.official?.desc].filter(Boolean).join(' '),
        charge: show === undefined ? 'unknown' : show ? 'yes' : 'no',
      };
    } catch (e) {
      c.fail('昵称、简介、认证', '接口 acc/info', e);
    }
  }

  // 备用：用户名片接口，不需要签名。有简介和认证，没有充电信息。
  try {
    const d = await getJson<CardData>(`${API}/x/web-interface/card?mid=${mid}&photo=false`);
    if (!d.card) throw new Error('返回中没有名片信息');
    c.ok('昵称、简介、认证', '接口 card（备用）', '不含充电信息');
    return profileFromCard(d);
  } catch (e) {
    c.fail('昵称、简介、认证', '接口 card（备用）', e);
  }

  const name = nameFromTitle(document.title);
  if (name) c.ok('昵称', '页面标题（备用）', '简介与认证未能取到');
  else c.fail('昵称', '页面标题（备用）', `标题格式不符：「${document.title.slice(0, 40)}」`);
  return { name, bio: null, officialTitle: null, charge: 'unknown' };
}

interface CardData {
  card?: {
    name?: string;
    sign?: string;
    Official?: { title?: string; desc?: string };
  };
}

/** 导出以便测试 */
export function profileFromCard(d: CardData): Profile {
  const official = d.card?.Official;
  return {
    name: d.card?.name ?? null,
    bio: d.card?.sign ?? '',
    officialTitle: [official?.title, official?.desc].filter(Boolean).join(' '),
    charge: 'unknown',
  };
}

// ── 视频列表 ────────────────────────────────────────────────

function videoUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

/**
 * 从一组候选文字里挑出最像标题的。同一个视频通常有两个链接：
 * 封面（文字是播放量、弹幕数、时长，如「207.1万265207:30」）和标题。
 * 真实页面验证时曾把封面文字当成标题，所以：有 title 属性的优先；
 * 其次排除以时长结尾的；最后才比长短。导出以便测试
 */
export function pickTitle(candidates: Array<{ text: string; fromAttr: boolean }>): string {
  const coverLike = (t: string) => /\d{1,2}:\d{2}$/.test(t);
  const rank = (c: { text: string; fromAttr: boolean }) =>
    (c.fromAttr ? 2 : 0) + (coverLike(c.text) ? 0 : 1);
  return (
    candidates
      .filter((c) => c.text.length > 0)
      .sort((a, b) => rank(b) - rank(a) || b.text.length - a.text.length)[0]?.text ?? ''
  );
}

/**
 * 页面上所有指向视频的链接。不依赖具体的类名，页面改版后仍然可用。
 * 标题只是临时的，详情接口返回的标题会覆盖它
 */
export function videosFromDom(root: ParentNode): VideoItem[] {
  const seen = new Map<string, Array<{ text: string; fromAttr: boolean }>>();
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/BV"]'))) {
    const bvid = /\/video\/(BV[0-9A-Za-z]{10})/.exec(a.getAttribute('href') ?? '')?.[1];
    if (!bvid) continue;
    const attr = (a.getAttribute('title') ?? '').trim();
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const list = seen.get(bvid) ?? [];
    list.push(attr ? { text: attr, fromAttr: true } : { text, fromAttr: false });
    seen.set(bvid, list);
  }
  return [...seen.entries()]
    .slice(0, MAX_VIDEOS)
    .map(([bvid, candidates]) => ({ bvid, title: pickTitle(candidates), url: videoUrl(bvid) }));
}

interface RecArchives {
  archives?: Array<{ bvid: string; title: string; pubdate?: number }>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 当前是否就在「投稿」标签页上。此时页面上的视频就是最近投稿 */
export function isUploadsPath(pathname: string): boolean {
  return /\/(upload|video)(\/|$)/.test(pathname);
}

/** 投稿页的地址：优先用导航栏里「投稿」链接的真实地址，找不到再按规律拼 */
function uploadsUrl(mid: string): string {
  const nav = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) =>
    /^投稿\d*$/.test((a.textContent ?? '').replace(/\s+/g, '')),
  );
  if (nav?.href.startsWith(location.origin)) return nav.href;
  const at = location.pathname.indexOf(`/${mid}`);
  const prefix = at >= 0 ? location.pathname.slice(0, at) : '';
  return `${location.origin}${prefix}/${mid}/upload/video`;
}

/**
 * 在后台加载这位创作者的投稿页，读它渲染出来的视频链接。
 *
 * 请求由 B 站自己的页面代码发出，这里只读结果，和用户自己点一下「投稿」
 * 标签看到的内容相同。不伪造任何参数（D-28）。
 */
async function videosFromUploadsPage(mid: string): Promise<VideoItem[]> {
  const frame = document.createElement('iframe');
  frame.src = uploadsUrl(mid);
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // 放在屏幕外但保留尺寸：页面按可见区域渲染列表
  frame.style.cssText =
    'position:fixed;left:-20000px;top:0;width:1280px;height:2400px;border:0;pointer-events:none;';
  document.body.appendChild(frame);
  try {
    let last = 0;
    let stable = 0;
    let list: VideoItem[] = [];
    // 最多等 15 秒；数量连续两次不变即认为渲染完成
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const doc = frame.contentDocument;
      if (!doc) continue;
      list = videosFromDom(doc);
      stable = list.length > 0 && list.length === last ? stable + 1 : 0;
      last = list.length;
      if (stable >= 2 && i >= 4) break;
    }
    return list;
  } finally {
    frame.remove();
  }
}

/** 按发布时间从新到旧取前 MAX_VIDEOS 条。没有发布时间的排在最后 */
function newest(list: VideoItem[]): VideoItem[] {
  return [...list].sort((a, b) => (b.pubdate ?? 0) - (a.pubdate ?? 0)).slice(0, MAX_VIDEOS);
}

function describeList(list: VideoItem[]): string {
  const dates = list.map((v) => v.pubdate).filter((d): d is number => d !== undefined);
  if (dates.length === 0) return `${list.length} 条`;
  const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
  return `${list.length} 条，发布于 ${day(Math.min(...dates))} 至 ${day(Math.max(...dates))}`;
}

/**
 * 视频列表依次尝试三条路径（D-33）：
 *   1. 接口 recArchivesByKeywords：最快，但不稳定（成功过，也返回过 412）
 *   2. 投稿页：当前就在投稿页则直接读，否则在后台加载。得到的是最近投稿
 *   3. 当前页面上看得到的视频：不一定是最近的（D-27）
 *
 * 曾经的 arc/search 路径在每次验证里都被风控拒绝（-352），已移除。
 */
async function loadVideoList(
  mid: string,
  c: Collector,
  onProgress: Progress,
): Promise<{ list: VideoItem[]; source: VideoSource }> {
  try {
    // 多取一些再按时间排序，不依赖它的默认顺序
    const d = await getJson<RecArchives>(
      `${API}/x/series/recArchivesByKeywords?mid=${mid}&keywords=&ps=100&pn=1`,
    );
    const list = (d.archives ?? []).map((v) => ({
      bvid: v.bvid,
      title: v.title,
      url: videoUrl(v.bvid),
      pubdate: v.pubdate,
    }));
    c.ok('视频列表', '接口 recArchivesByKeywords', describeList(list));
    return { list: newest(list), source: 'latest' };
  } catch (e) {
    c.fail('视频列表', '接口 recArchivesByKeywords', e);
  }

  const where = `当前页面路径 ${location.pathname}`;
  if (isUploadsPath(location.pathname)) {
    const list = videosFromDom(document);
    if (list.length > 0) {
      c.ok('视频列表', '投稿页（当前页面）', `${list.length} 条；${where}`);
      return { list, source: 'latest' };
    }
    c.fail('视频列表', '投稿页（当前页面）', `页面上没有找到视频链接；${where}`);
  } else {
    onProgress('在后台加载投稿页');
    try {
      const list = await videosFromUploadsPage(mid);
      if (list.length === 0) throw new Error('加载后没有找到视频链接');
      c.ok('视频列表', '投稿页（后台加载）', `${list.length} 条`);
      return { list, source: 'latest' };
    } catch (e) {
      c.fail('视频列表', '投稿页（后台加载）', e);
    }
  }

  const list = videosFromDom(document);
  if (list.length > 0) {
    c.ok(
      '视频列表',
      '当前页面上的链接（备用）',
      `${list.length} 条，只是当前页面上看得到的视频；${where}`,
    );
    return { list, source: 'page' };
  }
  c.fail('视频列表', '当前页面上的链接（备用）', `页面上没有找到视频链接；${where}`);
  return { list: [], source: 'none' };
}

// ── 单条视频的详情 ──────────────────────────────────────────

interface ViewData {
  aid?: number;
  desc?: string;
  pubdate?: number;
  title?: string;
  /** 是否为充电专属视频。字段名来自公开资料，未确认；自检里会报告命中条数 */
  is_upower_exclusive?: boolean;
}

interface ReplyContent {
  message?: string;
  /** 评论里被渲染成链接的片段 → 跳转信息 */
  jump_url?: Record<string, { pc_url?: string; title?: string; extra?: unknown } | undefined>;
}

interface ReplyData {
  top?: { upper?: { content?: ReplyContent } | null };
  upper?: { top?: { content?: ReplyContent } | null };
  top_replies?: Array<{ content?: ReplyContent }> | null;
}

interface DetailStats {
  view: number;
  /** 平台标记为充电专属的条数 */
  chargeExclusive: number;
  pinned: number;
  pinnedFound: number;
  /** 置顶评论里带链接片段的条数 */
  pinnedWithLinks: number;
  /** 置顶评论实际走通的路径 → 次数 */
  pinnedPaths: Record<string, number>;
  /** 每种链接各留一个原始样例，供自检展示。用来核对对返回字段的理解是否正确 */
  linkSamples: Map<string, string>;
  /** 详情接口里的候选标记字段 → 出现在多少条视频里 */
  flags: Map<string, number>;
  errors: string[];
}

interface PinnedResult {
  comment?: string;
  links: PinnedLink[];
  /** 每个链接的原始附加信息，仅用于自检 */
  raw: Array<{ keyword: string; target: string; extra: string }>;
}

/** 置顶评论有三条路径，依次尝试。哪条走通记在 stats 里，供自检展示 */
function replyUrls(aid: number, keys: WbiKeys | null): Array<{ name: string; url: string }> {
  const urls: Array<{ name: string; url: string }> = [];
  if (keys) {
    urls.push({
      name: 'reply/wbi/main',
      url: signed('/x/v2/reply/wbi/main', { oid: aid, type: 1, mode: 3, plat: 1 }, keys),
    });
  }
  urls.push(
    { name: 'reply/main', url: `${API}/x/v2/reply/main?oid=${aid}&type=1&mode=3&next=0&ps=1` },
    { name: 'reply', url: `${API}/x/v2/reply?oid=${aid}&type=1&pn=1&ps=1&sort=1` },
  );
  return urls;
}

/**
 * 从评论接口的返回里取出 UP 主置顶的那条。导出以便测试。
 *
 * 只记录事实，不判断是不是带货。唯一读取的附加字段是 is_word_search：
 * 平台会给评论里的热词自动加搜索链接，那不是创作者放的。
 * （曾经用「附加信息里有没有 goods 字样」判断商品链接，真实页面验证发现
 * 所有链接都带这类字段，包括搜索词，已弃用。见 D-30。）
 */
export function pinnedFromReply(d: ReplyData): PinnedResult {
  const content =
    d.top?.upper?.content ?? d.upper?.top?.content ?? d.top_replies?.[0]?.content;
  if (!content?.message) return { links: [], raw: [] };
  const entries = Object.entries(content.jump_url ?? {});
  return {
    comment: content.message,
    links: entries.map(([keyword, info]) => ({
      keyword,
      target: info?.pc_url ?? '',
      title: info?.title ?? '',
      wordSearch: (info?.extra as { is_word_search?: unknown } | undefined)?.is_word_search === true,
    })),
    raw: entries.map(([keyword, info]) => ({
      keyword,
      target: info?.pc_url ?? '',
      extra: JSON.stringify(info?.extra ?? null),
    })),
  };
}

async function enrich(
  video: VideoItem,
  keys: WbiKeys | null,
  stats: DetailStats,
): Promise<VideoItem> {
  const out = { ...video };
  let aid: number | undefined;
  try {
    const d = await getJson<ViewData>(`${API}/x/web-interface/view?bvid=${video.bvid}`);
    aid = d.aid;
    // 列表接口里的简介可能被截断，以详情为准
    if (d.desc !== undefined) out.desc = d.desc;
    if (d.pubdate !== undefined) out.pubdate = d.pubdate;
    // 以接口返回的标题为准：从页面链接读到的标题可能混进封面上的文字
    if (d.title) out.title = d.title;
    for (const flag of candidateFlags(d as unknown as Record<string, unknown>)) {
      stats.flags.set(flag, (stats.flags.get(flag) ?? 0) + 1);
    }
    if (d.is_upower_exclusive === true) {
      out.badges = ['充电专属'];
      stats.chargeExclusive++;
    }
    stats.view++;
  } catch (e) {
    stats.errors.push(`view ${video.bvid}: ${e instanceof Error ? e.message : e}`);
  }

  if (aid !== undefined) {
    let lastError: unknown;
    let reached = false;
    for (const { name, url } of replyUrls(aid, keys)) {
      try {
        const pinned = pinnedFromReply(await getJson<ReplyData>(url));
        reached = true;
        stats.pinnedPaths[name] = (stats.pinnedPaths[name] ?? 0) + 1;
        if (pinned.comment) {
          out.pinnedComment = pinned.comment;
          stats.pinnedFound++;
          if (pinned.links.length > 0) {
            out.pinnedLinks = pinned.links;
            stats.pinnedWithLinks++;
          }
          for (const r of pinned.raw) {
            // 分三类各留一个样例：网址、视频编号、其他文字（搜索词属于这一类）
            const kind = /^https?:\/\//.test(r.keyword)
              ? '网址片段'
              : /^(BV[0-9A-Za-z]{10}|av\d+)$/i.test(r.keyword)
                ? '视频编号片段'
                : '其他文字片段';
            if (!stats.linkSamples.has(kind)) {
              stats.linkSamples.set(
                kind,
                `${kind}「${r.keyword.slice(0, 40)}」→ 跳转 ${r.target.slice(0, 60) || '（空）'}，附加信息 ${r.extra.slice(0, 200)}`,
              );
            }
          }
        }
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (reached) stats.pinned++;
    else {
      stats.errors.push(
        `reply ${video.bvid}: ${lastError instanceof Error ? lastError.message : lastError}`,
      );
    }
  }
  // 每条视频之间稍作停顿，降低短时间内的请求密度（D-33）
  await sleep(REQUEST_GAP_MS);
  return out;
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return results;
}

// ── 页面入口：充电、小店、课程 ──────────────────────────────

/** 收集页面上所有短文本，用来判断某个入口是否存在。不依赖类名 */
export function shortTexts(root: ParentNode): Set<string> {
  const texts = new Set<string>();
  for (const el of Array.from(root.querySelectorAll('a, button, span, div, li'))) {
    if (el.children.length > 2) continue;
    const t = (el.textContent ?? '').replace(/\s+/g, '');
    if (t.length > 0 && t.length <= 8) texts.add(t);
  }
  return texts;
}

/**
 * 页面文字只能给出「有」，给不出「无」（D-31、D-36）。
 *
 * 最初假定小店和课程是导航栏里的标签，认出导航栏而没看到它们就判「无」。
 * 真实页面验证推翻了这个假定：一位确有付费课的创作者被判成了「课程：无」。
 * 在弄清这些入口到底显示在哪之前，没看到一律是「未能检查」。
 */
export function entriesFromTexts(texts: Set<string>): { shop: Tri; course: Tri; charge: Tri } {
  const list = [...texts];
  const seen = (p: RegExp): Tri => (list.some((t) => p.test(t)) ? 'yes' : 'unknown');
  return {
    shop: seen(/^(TA的)?(小店|橱窗|店铺)\d*$/),
    course: seen(/^(TA的)?(课堂|课程)\d*$/),
    charge: seen(/^(充电|为TA充电|包月充电|充电中)$/),
  };
}

/** 导航栏里各标签的文字，仅用于自检：让人看到页面上到底有哪些标签 */
export function navTexts(root: ParentNode): string[] {
  const anchor = Array.from(root.querySelectorAll('a, div, span, li')).find(
    (el) => el.children.length <= 2 && /^投稿\d*$/.test((el.textContent ?? '').replace(/\s+/g, '')),
  );
  // 从「投稿」往上找，直到找到一个包含好几个短文本子项的容器
  for (let node = anchor?.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const texts = Array.from(node.children)
      .map((child) => (child.textContent ?? '').replace(/\s+/g, ''))
      .filter((t) => t.length > 0 && t.length <= 10);
    if (texts.length >= 3) return texts;
  }
  return [];
}

/**
 * 从详情接口的返回里找出「看名字可能与商业化有关、且值不为空」的字段。
 * 仅用于自检：我不知道平台有没有给商业合作视频打标记、字段叫什么，
 * 先把候选字段列出来，看到真实数据再决定用哪个（D-36）。导出以便测试
 */
export function candidateFlags(d: Record<string, unknown>): string[] {
  const interesting =
    /(^|_)(ad|cm|pay|order)(_|$)|commerc|business|sponsor|promo|charg|upower|elec|cooperat|declar|goods|mall|shop|activity|honor/i;
  const truthy = (v: unknown) =>
    v === true ||
    (typeof v === 'number' && v !== 0) ||
    (typeof v === 'string' && v.length > 0) ||
    (Array.isArray(v) && v.length > 0) ||
    (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0);
  const found: string[] = [];
  const scan = (obj: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(obj)) {
      if (interesting.test(key) && truthy(value)) found.push(prefix + key);
    }
  };
  scan(d, '');
  const rights = d.rights;
  if (rights && typeof rights === 'object') scan(rights as Record<string, unknown>, 'rights.');
  return found;
}

/** 课程数。接口字段的含义还没有确认，所以只在大于 0 时采信（D-36） */
async function loadCourseCount(mid: string, c: Collector): Promise<Tri> {
  try {
    const d = await getJson<Record<string, unknown>>(`${API}/x/space/navnum?mid=${mid}`);
    const summary = Object.entries(d)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k}=${v}`)
      .join('，');
    const count = d.pugv;
    c.ok('课程数', '接口 navnum', `返回：${summary || '（没有数值字段）'}`);
    return typeof count === 'number' && count > 0 ? 'yes' : 'unknown';
  } catch (e) {
    c.fail('课程数', '接口 navnum', e);
    return 'unknown';
  }
}

const TRI_TEXT: Record<Tri, string> = { yes: '有', no: '无', unknown: '未能检查' };

// ── 入口 ────────────────────────────────────────────────────

export async function extractSnapshot(onProgress: Progress): Promise<CreatorSnapshot> {
  const mid = midFromUrl(location.href);
  if (!mid) throw new Error('当前页面不是 B 站 UP 主空间页');

  const c = new Collector();
  onProgress('读取账号信息');
  const keys = await loadWbiKeys(c);
  const profile = await loadProfile(mid, keys, c);

  onProgress('读取视频列表');
  const { list, source: videoSource } = await loadVideoList(mid, c, onProgress);

  const stats: DetailStats = {
    view: 0,
    chargeExclusive: 0,
    pinned: 0,
    pinnedFound: 0,
    pinnedWithLinks: 0,
    pinnedPaths: {},
    linkSamples: new Map(),
    flags: new Map(),
    errors: [],
  };
  let done = 0;
  const videos = await mapLimited(list, CONCURRENCY, async (v) => {
    const out = await enrich(v, keys, stats);
    onProgress(`读取视频详情 ${++done} / ${list.length}`);
    return out;
  });

  const n = list.length;
  const report = (item: string, path: string, okCount: number, extra = '') => {
    const detail = `${okCount} / ${n} 条成功${extra}`;
    if (n > 0 && okCount === 0) c.fail(item, path, detail);
    else c.ok(item, path, detail);
  };
  report(
    '视频标题、简介、发布时间',
    '接口 view',
    stats.view,
    `，其中 ${stats.chargeExclusive} 条被平台标记为充电专属`,
  );
  const paths = Object.entries(stats.pinnedPaths)
    .map(([name, count]) => `${name} ×${count}`)
    .join('、');
  report(
    '置顶评论',
    `接口 ${paths || 'reply（三条路径均未走通）'}`,
    stats.pinned,
    `，其中 ${stats.pinnedFound} 条有置顶评论，${stats.pinnedWithLinks} 条带链接片段`,
  );
  for (const sample of stats.linkSamples.values()) {
    c.ok('评论链接原始样例', '接口返回的 jump_url', sample);
  }
  if (stats.errors.length > 0) {
    c.sources.push({
      item: '详情请求错误（前 3 条）',
      path: '—',
      ok: false,
      detail: stats.errors.slice(0, 3).join('；'),
    });
  }

  if (stats.flags.size > 0) {
    c.ok(
      '详情接口里的候选标记字段',
      '接口 view（仅供核对）',
      [...stats.flags.entries()].map(([k, n]) => `${k} ×${n}`).join('，'),
    );
  }

  const entries = entriesFromTexts(shortTexts(document));
  const courseByApi = await loadCourseCount(mid, c);
  const course: Tri = courseByApi === 'yes' ? 'yes' : entries.course;
  const nav = navTexts(document);
  c.sources.push({
    item: '小店、课程入口',
    path: '页面文字（只能确认有，不能确认无）',
    ok: true,
    detail: `小店：${entries.shop === 'yes' ? '看到入口' : '没看到'}；课程：${entries.course === 'yes' ? '看到入口' : '没看到'}。导航栏标签：${nav.length ? nav.join(' / ') : '没有认出导航栏'}`,
  });
  // 充电：接口给了明确答案就用接口的；否则页面上看到按钮算「有」，看不到算「未能检查」
  const charge = profile.charge !== 'unknown' ? profile.charge : entries.charge;
  c.sources.push({
    item: '充电',
    path: '接口 acc/info，其次页面文字',
    ok: charge !== 'unknown',
    detail: `接口：${TRI_TEXT[profile.charge]}；页面：${entries.charge === 'yes' ? '看到充电按钮' : '没看到充电按钮（不能据此认为没有）'}；采用：${TRI_TEXT[charge]}。这是提取层的结果；样本里有充电专属视频时，账号层会另行判为有`,
  });

  return {
    mid,
    name: profile.name ?? `UID ${mid}`,
    bio: profile.bio,
    officialTitle: profile.officialTitle,
    hasCharge: charge,
    hasShop: entries.shop,
    hasCourse: course,
    videos,
    videoSource,
    capturedAt: Date.now(),
    sources: c.sources,
  };
}
