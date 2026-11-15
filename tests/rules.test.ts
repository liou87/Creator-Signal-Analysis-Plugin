import { describe, expect, it } from 'vitest';
import { classifyVideoByRules } from '../src/classify/rules';
import { classifyAccount } from '../src/classify/account';
import type { CreatorSnapshot, VideoItem } from '../src/types';

function v(partial: Partial<VideoItem>): VideoItem {
  return { bvid: 'BV1', title: '', url: '', ...partial };
}

function tiers(video: VideoItem, suspected = true): string[] {
  return classifyVideoByRules(video, suspected).map((e) => e.reason);
}

describe('A 明确披露', () => {
  it.each([
    ['本视频含商业合作内容', 'A1-声明'],
    ['感谢某某科技对本期视频的支持', 'A2-感谢赞助'],
    ['感谢 XX 提供的样机', 'A2-感谢赞助'],
    ['本次手机由品牌方提供', 'A3-品牌方提供'],
    ['本期由某某赞助播出', 'A4-合作标注'],
    ['这期是恰饭视频，大家多多支持', 'A5-恰饭'],
  ])('%s', (desc, rule) => {
    expect(tiers(v({ desc }))).toContain(rule);
  });
});

describe('否定与误判（D-09）', () => {
  it.each(['这期不是恰饭', '本期没有恰饭，纯分享', '本视频不含任何广告', '无广告，自费购买'])(
    '%s → 不算披露',
    (desc) => {
      expect(tiers(v({ desc })).filter((r) => r.startsWith('A'))).toEqual([]);
    },
  );

  it('标题里只是讨论广告行业，不算', () => {
    expect(tiers(v({ title: '为什么现在的广告越来越难看了' }))).toEqual([]);
  });

  it('简介里的商务联系脚注不算本条视频的披露', () => {
    const video = v({ desc: '今天聊聊显卡\n商务合作：abc@example.com' });
    expect(tiers(video)).toEqual([]);
  });
});

describe('B 带货转化', () => {
  it.each([
    ['同款在这里 https://item.taobao.com/item.htm?id=1', 'B1-购物链接'],
    ['京东：https://u.jd.com/abcd', 'B1-购物链接'],
    ['复制 ￥AbCd1234EfG￥ 打开淘宝', 'B2-淘口令'],
    ['下单时填优惠码：UP2026', 'B3-优惠码'],
    ['购买链接在评论区置顶', 'B4-链接引导'],
    ['我的淘宝店上新了', 'B5-自营店铺'],
    ['新课程已上架，报名链接见下方', 'B6-付费课程'],
    ['本期为充电专属内容', 'B7-充电专属'],
  ])('%s', (desc, rule) => {
    expect(tiers(v({ desc }))).toContain(rule);
  });

  it('置顶评论里的蓝链也能识别（D-12）', () => {
    const video = v({ title: '开箱', pinnedComment: '蓝链在这：https://b23.tv/mall-abc 专属链接' });
    const hits = classifyVideoByRules(video, true);
    expect(hits.some((e) => e.tier === 'B' && e.field === 'pinnedComment')).toBe(true);
  });

  it('变现类型：自营与知识付费区别于品牌合作', () => {
    const self = classifyVideoByRules(v({ desc: '我的淘宝店上新了' }), false);
    const course = classifyVideoByRules(v({ desc: '训练营报名开始' }), false);
    expect(self[0].type).toBe('self');
    expect(course[0].type).toBe('knowledge');
  });
});

describe('C 疑似软广', () => {
  it('有行动引导但无披露无链接', () => {
    expect(tiers(v({ desc: '粉丝专属福利，到手价只要 199' }))).toContain('C1-行动引导');
  });

  it('只提到品牌、没有行动引导，不算（D-08）', () => {
    expect(tiers(v({ title: '小米 15 深度体验：这次真的不错', desc: '用了两周的感受' }))).toEqual(
      [],
    );
  });

  it('有模型时关闭 C 档关键词', () => {
    expect(tiers(v({ desc: '粉丝专属福利' }), false)).toEqual([]);
  });
});

describe('证据可回溯', () => {
  it('引用必须是原文子串', () => {
    const desc = '第一行\n感谢某某科技对本期视频的支持，欢迎三连\n第三行';
    const [e] = classifyVideoByRules(v({ desc }), false);
    expect(desc).toContain(e.quote);
    expect(e.quote).not.toContain('\n');
  });
});

describe('账号层', () => {
  const base: CreatorSnapshot = {
    mid: '1',
    name: 't',
    bio: '',
    officialTitle: '',
    hasCharge: 'no',
    hasShop: 'no',
    hasCourse: 'no',
    videos: [],
    capturedAt: 0,
    sources: [],
  };
  const state = (s: CreatorSnapshot, id: string, videos: VideoItem[] = []) =>
    classifyAccount(s, videos).find((a) => a.id === id)!.state;

  it('简介里的商务联系方式', () => {
    expect(state({ ...base, bio: '商务合作请联系：abc@example.com' }, 'businessContact')).toBe(
      'yes',
    );
    expect(state({ ...base, bio: '商务vx：abc123' }, 'businessContact')).toBe('yes');
    expect(state({ ...base, bio: '一个爱打游戏的人' }, 'businessContact')).toBe('no');
  });

  it('简介没取到时为「未能检查」，而不是「无」（D-13）', () => {
    expect(state({ ...base, bio: null }, 'businessContact')).toBe('unknown');
    expect(state({ ...base, bio: null }, 'offsite')).toBe('unknown');
  });

  it('视频简介脚注反复出现商务联系方式，也算', () => {
    const vs = [
      v({ bvid: 'a', desc: '正文\n商务合作：a@b.com' }),
      v({ bvid: 'b', desc: '正文\n商务合作：a@b.com' }),
    ];
    expect(state({ ...base, bio: null }, 'businessContact', vs)).toBe('yes');
  });

  it('站外导流与机构', () => {
    expect(state({ ...base, bio: '公众号：某某' }, 'offsite')).toBe('yes');
    expect(state({ ...base, bio: '', officialTitle: '某某公司官方账号' }, 'org')).toBe('yes');
    expect(state({ ...base, bio: '', officialTitle: 'bilibili 知名UP主' }, 'org')).toBe('no');
  });

  it('入口类信号直接取自快照', () => {
    expect(state({ ...base, hasShop: 'yes' }, 'shop')).toBe('yes');
    expect(state({ ...base, hasCharge: 'unknown' }, 'charge')).toBe('unknown');
  });
});
