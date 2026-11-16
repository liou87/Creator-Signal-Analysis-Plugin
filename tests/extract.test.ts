import { describe, expect, it } from 'vitest';
import {
  candidateFlags,
  entriesFromTexts,
  isUploadsPath,
  pickTitle,
  pinnedFromReply,
  profileFromCard,
} from '../src/extract/bilibili';
import { midFromUrl, nameFromTitle } from '../src/extract/identify';
import { keysFromNav, mixinKey, signQuery } from '../src/extract/wbi';

describe('WBI 签名', () => {
  // 算例来自公开的 B 站接口文档，用来确认混淆表和签名流程没有写错
  const keys = keysFromNav(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  );

  it('从图片地址取出密钥', () => {
    expect(keys).toEqual({
      imgKey: '7cd084941338484aae1ad9425b84077c',
      subKey: '4932caff0ff746eab6f01bf08b70ac45',
    });
  });

  it('混合密钥', () => {
    expect(mixinKey(keys)).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('参数按键名排序后签名', () => {
    expect(signQuery({ foo: '114', bar: '514', zab: 1919810 }, keys, 1702204169)).toBe(
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
    );
  });
});

describe('识别创作者', () => {
  it('从空间页地址取 UID', () => {
    expect(midFromUrl('https://space.bilibili.com/123456')).toBe('123456');
    expect(midFromUrl('https://space.bilibili.com/123456/upload/video?x=1')).toBe('123456');
  });

  // 2026-11-15 首次在真实页面上验证时发现：地址里 UID 前可能有语言前缀
  it('地址带语言前缀时也能取到 UID', () => {
    expect(
      midFromUrl('https://space.bilibili.com/zh-Hans/447317111?spm_id_from=333.788.upinfo.head.click'),
    ).toBe('447317111');
    expect(midFromUrl('https://space.bilibili.com/zh-Hant/447317111/upload/video')).toBe('447317111');
    expect(midFromUrl('https://space.bilibili.com/en/447317111')).toBe('447317111');
  });

  it('不是空间页时返回 null', () => {
    expect(midFromUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBeNull();
    expect(midFromUrl('https://example.com/123')).toBeNull();
    expect(midFromUrl('https://space.bilibili.com/')).toBeNull();
    // 路径里别处出现的数字不能被当成 UID
    expect(midFromUrl('https://space.bilibili.com/zh-Hans/')).toBeNull();
    expect(midFromUrl('https://space.bilibili.com/a/b/123')).toBeNull();
  });

  it('从页面标题取昵称', () => {
    expect(nameFromTitle('某某的个人空间-某某个人主页-哔哩哔哩视频')).toBe('某某');
    expect(nameFromTitle('哔哩哔哩')).toBeNull();
  });

  it('从名片接口取昵称、简介、认证；名片里没有充电信息', () => {
    expect(
      profileFromCard({
        card: {
          name: '某某',
          sign: '商务合作请联系vx：abc',
          Official: { title: '知名美食UP主', desc: '' },
        },
      }),
    ).toEqual({
      name: '某某',
      bio: '商务合作请联系vx：abc',
      officialTitle: '知名美食UP主',
      charge: 'unknown',
    });
  });

  it('名片里简介为空时是空字符串（取到了但为空），不是 null', () => {
    expect(profileFromCard({ card: { name: '某某' } }).bio).toBe('');
  });
});

describe('置顶评论（D-12）', () => {
  const content = {
    message: '同款 https://b23.tv/mall-abc 感谢 Akira 出镜',
    jump_url: {
      'https://b23.tv/mall-abc': {
        pc_url: 'https://mall.bilibili.com/x',
        title: '某某零食',
        extra: { goods_show_type: 1, is_word_search: false },
      },
      Akira: {
        pc_url: 'https://search.bilibili.com/all?keyword=Akira',
        title: 'Akira',
        extra: { goods_show_type: 0, is_word_search: true },
      },
    },
  };

  it('三种返回结构都能取到置顶评论', () => {
    expect(pinnedFromReply({ top: { upper: { content } } }).comment).toBe(content.message);
    expect(pinnedFromReply({ upper: { top: { content } } }).comment).toBe(content.message);
    expect(pinnedFromReply({ top_replies: [{ content }] }).comment).toBe(content.message);
  });

  it('没有置顶评论时返回空', () => {
    expect(pinnedFromReply({ top: { upper: null }, top_replies: null })).toEqual({
      links: [],
      raw: [],
    });
  });

  it('记录链接片段，并标出平台自动加的搜索词', () => {
    expect(pinnedFromReply({ top: { upper: { content } } }).links).toEqual([
      {
        keyword: 'https://b23.tv/mall-abc',
        target: 'https://mall.bilibili.com/x',
        title: '某某零食',
        wordSearch: false,
      },
      {
        keyword: 'Akira',
        target: 'https://search.bilibili.com/all?keyword=Akira',
        title: 'Akira',
        wordSearch: true,
      },
    ]);
  });

  it('保留原始附加信息，供自检核对', () => {
    const raw = pinnedFromReply({ top: { upper: { content } } }).raw;
    expect(raw[1]?.extra).toContain('is_word_search');
  });
});

describe('页面入口三态（D-13）', () => {
  it('认出导航栏且有入口 → 有', () => {
    const r = entriesFromTexts(new Set(['主页', '动态', '投稿128', '小店', '课堂', '充电']));
    expect(r).toEqual({ shop: 'yes', course: 'yes', charge: 'yes' });
  });

  it('没看到入口 → 未能检查，而不是无', () => {
    const r = entriesFromTexts(new Set(['主页', '动态', '投稿', '收藏']));
    // 页面只能确认有，不能确认无（D-31、D-36）：一位确有付费课的创作者曾被判成「课程：无」
    expect(r).toEqual({ shop: 'unknown', course: 'unknown', charge: 'unknown' });
  });

  it('没认出导航栏 → 未能检查，而不是无', () => {
    const r = entriesFromTexts(new Set(['登录', '注册']));
    expect(r).toEqual({ shop: 'unknown', course: 'unknown', charge: 'unknown' });
  });

  it('正文里出现「充电」二字的长句不会被当成入口', () => {
    const r = entriesFromTexts(new Set(['主页', '手机充电测试']));
    expect(r.charge).toBe('unknown');
  });
});

describe('从页面链接读视频（真实页面验证后修正）', () => {
  it('封面文字（播放量、弹幕数、时长）不当作标题', () => {
    expect(
      pickTitle([
        { text: '207.1万265207:30', fromAttr: false },
        { text: '我将负责嘎嘎乱吃！', fromAttr: false },
      ]),
    ).toBe('我将负责嘎嘎乱吃！');
  });

  it('有 title 属性的优先', () => {
    expect(
      pickTitle([
        { text: '一段很长很长的、并不是标题的链接文字', fromAttr: false },
        { text: '真标题', fromAttr: true },
      ]),
    ).toBe('真标题');
  });

  it('只有封面文字时也返回它，等详情接口的标题来覆盖', () => {
    expect(pickTitle([{ text: '143.4万1.6万02:13:12', fromAttr: false }])).toBe(
      '143.4万1.6万02:13:12',
    );
    expect(pickTitle([])).toBe('');
  });

  it('识别当前是否在投稿页', () => {
    expect(isUploadsPath('/zh-Hans/39627524/upload/video')).toBe(true);
    expect(isUploadsPath('/39627524/video')).toBe(true);
    expect(isUploadsPath('/zh-Hans/39627524')).toBe(false);
    expect(isUploadsPath('/39627524/dynamic')).toBe(false);
  });
});

describe('候选标记字段（仅供自检核对，D-36）', () => {
  it('只列出名字相关且值不为空的字段', () => {
    expect(
      candidateFlags({
        title: '某视频',
        is_upower_exclusive: true,
        is_upower_play: false,
        mission_id: 0,
        honor_reply: { honor: [{ desc: '热门' }] },
        rights: { pay: 0, ugc_pay: 1, is_cooperation: 1, hd5: 1 },
      }),
    ).toEqual(['is_upower_exclusive', 'honor_reply', 'rights.ugc_pay', 'rights.is_cooperation']);
  });

  it('没有相关字段时为空', () => {
    expect(candidateFlags({ title: 'x', duration: 10 })).toEqual([]);
  });
});
