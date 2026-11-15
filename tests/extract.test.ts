import { describe, expect, it } from 'vitest';
import {
  entriesFromTexts,
  midFromUrl,
  nameFromTitle,
  pinnedFromReply,
} from '../src/extract/bilibili';
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

  it('不是空间页时返回 null', () => {
    expect(midFromUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBeNull();
    expect(midFromUrl('https://example.com/123')).toBeNull();
  });

  it('从页面标题取昵称', () => {
    expect(nameFromTitle('某某的个人空间-某某个人主页-哔哩哔哩视频')).toBe('某某');
    expect(nameFromTitle('哔哩哔哩')).toBeNull();
  });
});

describe('置顶评论（D-12）', () => {
  const content = {
    message: '同款在这 某某耳机旗舰款 还有我的主页 @某人',
    jump_url: {
      某某耳机旗舰款: { pc_url: '', extra: { goods_show_type: 1 } },
      '@某人': { pc_url: 'https://space.bilibili.com/1' },
    },
  };

  it('三种返回结构都能取到置顶评论', () => {
    expect(pinnedFromReply({ top: { upper: { content } } }).pinnedComment).toBe(content.message);
    expect(pinnedFromReply({ upper: { top: { content } } }).pinnedComment).toBe(content.message);
    expect(pinnedFromReply({ top_replies: [{ content }] }).pinnedComment).toBe(content.message);
  });

  it('没有置顶评论时返回空', () => {
    expect(pinnedFromReply({ top: { upper: null }, top_replies: null })).toEqual({});
  });

  it('记录链接片段，并标出平台标记的商品链接', () => {
    const links = pinnedFromReply({ top: { upper: { content } } }).pinnedLinks;
    expect(links).toEqual([
      { keyword: '某某耳机旗舰款', target: '', isGoods: true },
      { keyword: '@某人', target: 'https://space.bilibili.com/1', isGoods: false },
    ]);
  });
});

describe('页面入口三态（D-13）', () => {
  it('认出导航栏且有入口 → 有', () => {
    const r = entriesFromTexts(new Set(['主页', '动态', '投稿128', '小店', '课堂', '充电']));
    expect(r).toEqual({ shop: 'yes', course: 'yes', charge: 'yes' });
  });

  it('认出导航栏但没有入口 → 无', () => {
    const r = entriesFromTexts(new Set(['主页', '动态', '投稿', '收藏']));
    expect(r).toEqual({ shop: 'no', course: 'no', charge: 'no' });
  });

  it('没认出导航栏 → 未能检查，而不是无', () => {
    const r = entriesFromTexts(new Set(['登录', '注册']));
    expect(r).toEqual({ shop: 'unknown', course: 'unknown', charge: 'unknown' });
  });

  it('正文里出现「充电」二字的长句不会被当成入口', () => {
    const r = entriesFromTexts(new Set(['主页', '手机充电测试']));
    expect(r.charge).toBe('no');
  });
});
