import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { classifyVideos } from '../src/classify';
import { classifyAccount } from '../src/classify/account';
import { score, selectWindow } from '../src/scoring/score';
import type { CreatorSnapshot, VideoItem } from '../src/types';
import { ReportView } from '../src/ui/ReportView';

/**
 * 端到端（不含浏览器）：快照 → 取样 → 分类 → 评分 → 报告界面。
 * 用一个虚构的创作者，手算出预期分数，确认整条链路与文档里的公式一致。
 */

const NOW = Date.UTC(2026, 10, 15);
const DAY = 86400;

function video(i: number, extra: Partial<VideoItem> = {}): VideoItem {
  return {
    bvid: `BV${String(i).padStart(10, '0')}`,
    title: `日常记录 第 ${i} 期`,
    url: `https://www.bilibili.com/video/BV${String(i).padStart(10, '0')}`,
    pubdate: NOW / 1000 - i * 7 * DAY,
    desc: '今天也是普通的一天',
    ...extra,
  };
}

const snapshot: CreatorSnapshot = {
  mid: '10086',
  name: '虚构的测评君',
  bio: '数码爱好者。商务合作请联系：biz@example.com',
  officialTitle: 'bilibili 知名UP主',
  hasCharge: 'yes',
  hasShop: 'no',
  hasCourse: 'unknown',
  capturedAt: NOW,
  sources: [{ item: '视频列表', path: '接口 arc/search', ok: true, detail: '20 条' }],
  videos: [
    video(0, { title: '新手机上手', desc: '感谢某某科技对本期视频的支持' }), // A
    video(1, { desc: '同款 https://item.taobao.com/item.htm?id=1' }), // B
    video(2, { pinnedComment: '购买链接在这里，领券更便宜' }), // B
    video(3, { desc: '粉丝专属福利，到手价 199' }), // C
    video(4, { desc: '这期不是恰饭，纯自费' }), // 无
    ...Array.from({ length: 15 }, (_, i) => video(5 + i)), // 无
    video(80, { desc: '感谢某某赞助' }), // 一年半以前，窗口之外
  ],
};

async function run() {
  const videos = selectWindow(snapshot.videos, snapshot.capturedAt);
  const classified = await classifyVideos(videos);
  const account = classifyAccount(snapshot, videos);
  return score(snapshot, videos, classified.evidence, account, { llmUsed: classified.llmUsed });
}

describe('端到端', () => {
  it('分数与手算一致', async () => {
    const r = await run();

    // 窗口：21 条里有 1 条超过 12 个月，剩 20 条
    expect(r.content.sampleSize).toBe(20);
    expect(r.content.certainCount).toBe(3);
    expect(r.content.suspectedCount).toBe(1);

    // 占比 = (3 + 1 × 0.5) ÷ (20 + 5) = 0.14；内容层 = 60 × 0.14 ÷ 0.5 = 16.8
    expect(r.content.ratio).toBeCloseTo(0.14);
    expect(r.content.point).toBeCloseTo(16.8);
    // 下界 3 ÷ 25 = 0.12 → 14.4；上界 4 ÷ 25 = 0.16 → 19.2
    expect(r.content.low).toBeCloseTo(14.4);
    expect(r.content.high).toBeCloseTo(19.2);

    // 账号层：商务联系方式 10 + 充电 5 = 15
    expect(r.account.score).toBe(15);
    expect(r.total.point).toBeCloseTo(31.8);
    expect(r.band).toBe('low');

    // 课程入口未能检查 → 置信度为中，不扣分
    expect(r.confidence.level).toBe('mid');
  });

  it('报告对应本次分析的创作者，并展示计算过程和依据', async () => {
    const html = renderToStaticMarkup(<ReportView report={await run()} />);

    expect(html).toContain('虚构的测评君');
    expect(html).toContain('UID 10086');
    // 计算过程带入了本次的真实数字
    expect(html).toContain('(3 + 1 × 0.5) ÷ (20 + 5) = 0.14');
    // 依据：原文引用与可点击的视频链接
    expect(html).toContain('感谢某某科技对本期视频的支持');
    expect(html).toContain('href="https://www.bilibili.com/video/BV0000000000"');
    expect(html).toContain('biz@example.com');
    // 被否定的「恰饭」不出现在依据里
    expect(html).not.toContain('这期不是恰饭');
    expect(html).toContain('未能检查');
  });
});
