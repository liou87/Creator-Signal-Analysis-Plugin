import { md5 } from 'js-md5';

/**
 * B 站 WBI 签名。部分公开接口（空间信息、投稿列表）要求请求参数带 w_rid 签名。
 * 密钥来自 nav 接口返回的两个图片地址的文件名，未登录也能取到。
 * 纯函数，可单独测试。
 */

const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export interface WbiKeys {
  imgKey: string;
  subKey: string;
}

export function keysFromNav(imgUrl: string, subUrl: string): WbiKeys {
  const name = (url: string) => url.slice(url.lastIndexOf('/') + 1).split('.')[0] ?? '';
  return { imgKey: name(imgUrl), subKey: name(subUrl) };
}

export function mixinKey(keys: WbiKeys): string {
  const raw = keys.imgKey + keys.subKey;
  return MIXIN_TABLE.map((i) => raw[i])
    .join('')
    .slice(0, 32);
}

export function signQuery(
  params: Record<string, string | number>,
  keys: WbiKeys,
  /** Unix 秒。作为参数传入以便测试 */
  wts: number,
): string {
  const all: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const value = String(all[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey(keys))}`;
}
