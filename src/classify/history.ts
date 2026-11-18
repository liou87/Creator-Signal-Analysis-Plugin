import type { Report, VideoItem } from '../types';
import { classifyVideoByRules } from './rules';

/**
 * 窗口之外的历史：取到了、但早于 12 个月窗口的视频里，有没有确证的商业内容。
 * 只展示，不计分（D-45）。
 *
 * 只用规则、只看 A、B 两档：历史只是背景说明，不值得为它再调一次模型，
 * 也不该把需要判断的疑似档拿来下「以前做过」的结论。
 * 这些视频的详情和置顶评论在提取时已经取到了，不多发请求。
 */
export function summarizeHistory(all: VideoItem[], window: VideoItem[]): Report['history'] {
  const inWindow = new Set(window.map((v) => v.bvid));
  const older = all
    .filter((v) => !inWindow.has(v.bvid) && v.pubdate !== undefined)
    .sort((a, b) => (b.pubdate ?? 0) - (a.pubdate ?? 0));

  const videos = older.flatMap((video) => {
    const evidence = classifyVideoByRules(video, false).filter(
      (e) => e.tier === 'A' || e.tier === 'B',
    );
    const top = evidence.find((e) => e.tier === 'A') ?? evidence[0];
    return top ? [{ video, evidence: top }] : [];
  });

  return { checked: older.length, videos };
}
