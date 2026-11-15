import type { CreatorSnapshot, SourceStatus, Tri, VideoItem } from '../types';
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
const CONCURRENCY = 3;

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

interface Profile {
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
  const name = nameFromTitle(document.title);
  if (name) c.ok('昵称', '页面标题（备用）');
  else c.fail('昵称', '页面标题（备用）', `标题格式不符：「${document.title.slice(0, 40)}」`);

  const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  const bio = bioFromMetaDescription(meta);
  if (bio !== null) c.ok('简介', '页面描述信息（备用）', '认证未能取到');
  else c.fail('简介', '页面描述信息（备用）', `格式不符：「${meta.slice(0, 40)}」`);

  return { name, bio, officialTitle: null, charge: 'unknown' };
}

/**
 * 备用简介：空间页的描述信息形如「昵称，简介内容；昵称的主页、动态、视频…」。
 * 格式不符时返回 null（未取到），不去猜。导出以便测试
 */
export function bioFromMetaDescription(content: string): string | null {
  const m = /^(.+?)，([\s\S]*?)；\1的主页/.exec(content);
  return m ? (m[2] ?? '').trim() : null;
}

// ── 视频列表 ────────────────────────────────────────────────

interface ArcSearch {
  list?: {
    vlist?: Array<{ bvid: string; title: string; description?: string; created?: number }>;
  };
}

function videoUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

/** 备用路径：页面上所有指向视频的链接。不依赖具体的类名，页面改版后仍然可用 */
export function videosFromDom(root: ParentNode): VideoItem[] {
  const seen = new Map<string, VideoItem>();
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/BV"]'))) {
    const m = /\/video\/(BV[0-9A-Za-z]{10})/.exec(a.getAttribute('href') ?? '');
    const bvid = m?.[1];
    if (!bvid) continue;
    const title = (a.getAttribute('title') || a.textContent || '').trim();
    const prev = seen.get(bvid);
    // 同一视频通常有封面和标题两个链接，取文字更长的那个作标题
    if (!prev || title.length > prev.title.length) {
      seen.set(bvid, { bvid, title, url: videoUrl(bvid) });
    }
  }
  return [...seen.values()].filter((v) => v.title.length > 0).slice(0, MAX_VIDEOS);
}

async function loadVideoList(mid: string, keys: WbiKeys | null, c: Collector): Promise<VideoItem[]> {
  if (keys) {
    try {
      const d = await getJson<ArcSearch>(
        signed(
          '/x/space/wbi/arc/search',
          { mid, ps: MAX_VIDEOS, pn: 1, order: 'pubdate', platform: 'web' },
          keys,
        ),
      );
      const list = d.list?.vlist ?? [];
      c.ok('视频列表', '接口 arc/search', `${list.length} 条`);
      return list.map((v) => ({
        bvid: v.bvid,
        title: v.title,
        url: videoUrl(v.bvid),
        pubdate: v.created,
        desc: v.description,
      }));
    } catch (e) {
      c.fail('视频列表', '接口 arc/search', e);
    }
  }
  const list = videosFromDom(document);
  if (list.length > 0) {
    c.ok('视频列表', '页面链接（备用）', `${list.length} 条，仅当前页面可见的视频`);
  } else {
    c.fail('视频列表', '页面链接（备用）', '页面上没有找到视频链接，请切到「投稿」标签页后重试');
  }
  return list;
}

// ── 单条视频的详情 ──────────────────────────────────────────

interface ViewData {
  aid?: number;
  desc?: string;
  pubdate?: number;
  title?: string;
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
  tags: number;
  pinned: number;
  pinnedFound: number;
  pinnedGoods: number;
  /** 置顶评论实际走通的路径 → 次数 */
  pinnedPaths: Record<string, number>;
  errors: string[];
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

/** 从评论接口的返回里取出 UP 主置顶的那条。导出以便测试 */
export function pinnedFromReply(d: ReplyData): Pick<VideoItem, 'pinnedComment' | 'pinnedLinks'> {
  const content =
    d.top?.upper?.content ?? d.upper?.top?.content ?? d.top_replies?.[0]?.content;
  if (!content?.message) return {};
  const links = Object.entries(content.jump_url ?? {}).map(([keyword, info]) => ({
    keyword,
    target: info?.pc_url ?? '',
    // 平台对商品链接会在附加信息里带 goods 相关字段
    isGoods: /goods/i.test(JSON.stringify(info?.extra ?? '')),
  }));
  return { pinnedComment: content.message, pinnedLinks: links.length ? links : undefined };
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
    if (d.title && !out.title) out.title = d.title;
    stats.view++;
  } catch (e) {
    stats.errors.push(`view ${video.bvid}: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const tags = await getJson<Array<{ tag_name?: string }>>(
      `${API}/x/tag/archive/tags?bvid=${video.bvid}`,
    );
    out.tags = tags.map((t) => t.tag_name ?? '').filter(Boolean);
    stats.tags++;
  } catch {
    // 标签是次要信息，失败不记错误明细，只体现在成功计数里
  }

  if (aid !== undefined) {
    let lastError: unknown;
    let reached = false;
    for (const { name, url } of replyUrls(aid, keys)) {
      try {
        const pinned = pinnedFromReply(await getJson<ReplyData>(url));
        reached = true;
        stats.pinnedPaths[name] = (stats.pinnedPaths[name] ?? 0) + 1;
        if (pinned.pinnedComment) {
          Object.assign(out, pinned);
          stats.pinnedFound++;
          if (pinned.pinnedLinks?.some((l) => l.isGoods)) stats.pinnedGoods++;
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

export function entriesFromTexts(texts: Set<string>): { shop: Tri; course: Tri; charge: Tri } {
  const list = [...texts];
  // 能认出导航栏，才有资格说某个入口「没有」；认不出就是「未能检查」
  const navFound = list.some((t) => /^(主页|动态|投稿|合集|收藏)\d*$/.test(t));
  const has = (p: RegExp): Tri => (list.some((t) => p.test(t)) ? 'yes' : navFound ? 'no' : 'unknown');
  return {
    shop: has(/^(小店|橱窗|店铺|商品)\d*$/),
    course: has(/^(课堂|课程)\d*$/),
    charge: has(/^(充电|为TA充电|包月充电|充电中)$/),
  };
}

// ── 入口 ────────────────────────────────────────────────────

export async function extractSnapshot(onProgress: Progress): Promise<CreatorSnapshot> {
  const mid = midFromUrl(location.href);
  if (!mid) throw new Error('当前页面不是 B 站 UP 主空间页');

  const c = new Collector();
  onProgress('读取账号信息');
  const keys = await loadWbiKeys(c);
  const profile = await loadProfile(mid, keys, c);

  onProgress('读取视频列表');
  const list = await loadVideoList(mid, keys, c);

  const stats: DetailStats = {
    view: 0,
    tags: 0,
    pinned: 0,
    pinnedFound: 0,
    pinnedGoods: 0,
    pinnedPaths: {},
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
  report('视频简介', '接口 view', stats.view);
  report('视频标签', '接口 tag/archive/tags', stats.tags);
  const paths = Object.entries(stats.pinnedPaths)
    .map(([name, count]) => `${name} ×${count}`)
    .join('、');
  report(
    '置顶评论',
    `接口 ${paths || 'reply（三条路径均未走通）'}`,
    stats.pinned,
    `，其中 ${stats.pinnedFound} 条有置顶评论，${stats.pinnedGoods} 条含平台标记的商品链接`,
  );
  if (stats.errors.length > 0) {
    c.sources.push({
      item: '详情请求错误（前 3 条）',
      path: '—',
      ok: false,
      detail: stats.errors.slice(0, 3).join('；'),
    });
  }

  const entries = entriesFromTexts(shortTexts(document));
  // 充电：接口给了明确答案就用接口的，否则看页面
  const charge = profile.charge !== 'unknown' ? profile.charge : entries.charge;
  c.sources.push({
    item: '充电、小店、课程入口',
    path: '页面文字',
    ok: entries.shop !== 'unknown',
    detail:
      entries.shop === 'unknown'
        ? '没有认出导航栏，这三项记为未能检查'
        : `小店 ${entries.shop}，课程 ${entries.course}，充电 ${charge}`,
  });

  return {
    mid,
    name: profile.name ?? `UID ${mid}`,
    bio: profile.bio,
    officialTitle: profile.officialTitle,
    hasCharge: charge,
    hasShop: entries.shop,
    hasCourse: entries.course,
    videos,
    capturedAt: Date.now(),
    sources: c.sources,
  };
}
