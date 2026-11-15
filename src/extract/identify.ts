/**
 * 从地址和标题识别创作者。纯函数，侧边栏和内容脚本共用同一份，
 * 避免两处规则不一致。
 */

/**
 * 空间页地址的几种形式：
 *   space.bilibili.com/447317111
 *   space.bilibili.com/447317111/upload/video
 *   space.bilibili.com/zh-Hans/447317111?spm_id_from=…   ← UID 前可能有语言前缀
 */
const SPACE_URL =
  /^https?:\/\/space\.bilibili\.com\/(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*\/)?(\d+)(?:[/?#]|$)/;

export function midFromUrl(url: string): string | null {
  return SPACE_URL.exec(url)?.[1] ?? null;
}

/** 页面上的备用昵称：标题形如「某某的个人空间-某某个人主页-哔哩哔哩视频」 */
export function nameFromTitle(title: string): string | null {
  return /^(.+?)的个人空间/.exec(title)?.[1] ?? null;
}
