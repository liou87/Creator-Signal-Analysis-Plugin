import type { CreatorSnapshot } from './types';

/** 侧边栏 → 内容脚本 */
export type ContentRequest = { type: 'identify' } | { type: 'extract' };

/** 内容脚本 → 侧边栏 */
export type ContentResponse =
  | { type: 'identity'; mid: string | null; name: string | null }
  | { type: 'progress'; text: string }
  | { type: 'done'; snapshot: CreatorSnapshot }
  | { type: 'error'; message: string };
