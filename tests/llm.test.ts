import { describe, expect, it, vi } from 'vitest';
import { classifyVideos } from '../src/classify';
import {
  classifySuspectedByLlm,
  hashText,
  validateLlmResults,
  type KeyValueStore,
  type LlmConfig,
} from '../src/classify/llm';
import type { VideoItem } from '../src/types';

const cfg: LlmConfig = { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' };

const videos: VideoItem[] = [
  { bvid: 'BV_a', title: '新耳机体验', url: '', desc: '这款某某耳机现在入手有粉丝专属价，推荐大家试试' },
  { bvid: 'BV_b', title: '周末爬山记录', url: '', desc: '天气很好' },
];

function fakeFetch(results: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }),
      { status },
    ),
  ) as unknown as typeof fetch;
}

function memoryCache(): KeyValueStore & { size: () => number } {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
    size: () => m.size,
  };
}

describe('模型输出校验（D-11）', () => {
  it('合格的结果变成 C 档证据，来源标为模型', () => {
    const out = validateLlmResults(videos, {
      results: [
        { id: 'BV_a', verdict: 'soft_ad', type: 'brand', quote: '粉丝专属价', reason: '有行动引导' },
        { id: 'BV_b', verdict: 'none', quote: '' },
      ],
    });
    const a = out.get('BV_a');
    expect(a).toMatchObject({
      verdict: 'soft_ad',
      evidence: { tier: 'C', source: 'llm', field: 'desc', quote: '粉丝专属价' },
    });
    expect(out.get('BV_b')).toEqual({ verdict: 'none' });
  });

  it('引用不是原文子串 → 整条丢弃', () => {
    const out = validateLlmResults(videos, {
      results: [{ id: 'BV_a', verdict: 'soft_ad', quote: '这句话原文里没有' }],
    });
    expect(out.has('BV_a')).toBe(false);
  });

  it('模型编造的视频编号 → 丢弃', () => {
    const out = validateLlmResults(videos, {
      results: [{ id: 'BV_fake', verdict: 'soft_ad', quote: '粉丝专属价' }],
    });
    expect(out.size).toBe(0);
  });

  it('结论不是枚举值 → 丢弃', () => {
    const out = validateLlmResults(videos, {
      results: [{ id: 'BV_a', verdict: 'definitely_ad', quote: '粉丝专属价' }],
    });
    expect(out.size).toBe(0);
  });

  it('模型不能给出 A、B 档：无论它说什么，证据都只会是 C', () => {
    const out = validateLlmResults(videos, {
      results: [{ id: 'BV_a', verdict: 'soft_ad', tier: 'A', quote: '粉丝专属价' }],
    });
    const a = out.get('BV_a');
    expect(a?.verdict === 'soft_ad' && a.evidence.tier).toBe('C');
  });

  it('返回结构不对 → 空结果，不报错', () => {
    expect(validateLlmResults(videos, null).size).toBe(0);
    expect(validateLlmResults(videos, { results: 'oops' }).size).toBe(0);
  });
});

describe('调用与缓存（D-10）', () => {
  it('同样的内容第二次不再请求模型', async () => {
    const fetchFn = fakeFetch([
      { id: 'BV_a', verdict: 'soft_ad', quote: '粉丝专属价' },
      { id: 'BV_b', verdict: 'none' },
    ]);
    const cache = memoryCache();
    const first = await classifySuspectedByLlm(videos, cfg, cache, fetchFn);
    const second = await classifySuspectedByLlm(videos, cfg, cache, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.evidence).toEqual(first.evidence);
    expect(cache.size()).toBe(2);
  });

  it('接口出错时不抛异常，返回错误说明', async () => {
    const result = await classifySuspectedByLlm(videos, cfg, undefined, fakeFetch([], 500));
    expect(result.error).toContain('500');
    expect(result.evidence).toEqual([]);
  });

  it('请求里 temperature 为 0', async () => {
    const fetchFn = fakeFetch([]);
    await classifySuspectedByLlm(videos, cfg, undefined, fetchFn);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).temperature).toBe(0);
  });

  it('分批请求：25 条分 3 批，避免输出过长被截断', async () => {
    const many: VideoItem[] = Array.from({ length: 25 }, (_, i) => ({ bvid: `BV_${i}`, title: `t${i}`, url: '' }));
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(JSON.parse(init.body as string).messages[1].content) as Array<{ id: string }>;
      const results = sent.map((s) => ({ id: s.id, verdict: 'none' }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
    }) as unknown as typeof fetch;
    const r = await classifySuspectedByLlm(many, cfg, undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(r.judged).toBe(25);
    expect(r.requested).toBe(25);
  });

  it('记录每条未采纳的原因，用于自检', async () => {
    const r = await classifySuspectedByLlm(
      videos,
      cfg,
      undefined,
      fakeFetch([
        { id: 'BV_a', verdict: 'soft_ad', quote: '原文里没有这句' },
        { id: 'BV_fake', verdict: 'none' },
      ]),
    );
    expect(r.rejected).toEqual([
      { bvid: 'BV_a', reason: '引用不是原文：「原文里没有这句」' },
      { bvid: 'BV_fake', reason: '编号不在本次输入里' },
      { bvid: 'BV_b', reason: '模型没有返回这条' },
    ]);
  });

  it('哈希稳定且对内容敏感', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});

describe('分类入口', () => {
  it('没有模型时用关键词判定 C 档', async () => {
    const r = await classifyVideos(videos);
    expect(r.llmUsed).toBe(false);
    expect(r.evidence.some((e) => e.bvid === 'BV_a' && e.tier === 'C' && e.source === 'rule')).toBe(
      true,
    );
  });

  it('规则已命中 A、B 的视频不会发给模型', async () => {
    const withLink: VideoItem = {
      bvid: 'BV_c',
      title: '开箱',
      url: '',
      desc: '购买链接 https://item.taobao.com/x',
    };
    const fetchFn = fakeFetch([
      { id: 'BV_a', verdict: 'none' },
      { id: 'BV_b', verdict: 'none' },
    ]);
    vi.stubGlobal('fetch', fetchFn);
    const r = await classifyVideos([...videos, withLink], cfg);
    vi.unstubAllGlobals();
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(JSON.parse(init.body as string).messages[1].content) as Array<{
      id: string;
    }>;
    expect(sent.map((s) => s.id)).toEqual(['BV_a', 'BV_b']);
    expect(r.llmUsed).toBe(true);
    expect(r.evidence.find((e) => e.bvid === 'BV_c')?.tier).toBe('B');
  });

  it('模型失败时整体退回关键词，并说明原因', async () => {
    vi.stubGlobal('fetch', fakeFetch([], 401));
    const r = await classifyVideos(videos, cfg);
    vi.unstubAllGlobals();
    expect(r.llmUsed).toBe(false);
    expect(r.llmError).toContain('401');
    expect(r.evidence.some((e) => e.tier === 'C' && e.source === 'rule')).toBe(true);
  });

  it('模型对照：两种口径并排列出，不影响计分', async () => {
    // BV_a 关键词判疑似（粉丝专属价）；模型判 BV_b 疑似、BV_a 不是
    const hiking: VideoItem = { ...videos[1]!, desc: '天气很好，这件冲锋衣点击下方链接领券' };
    vi.stubGlobal(
      'fetch',
      fakeFetch([
        { id: 'BV_a', verdict: 'none' },
        { id: 'BV_b', verdict: 'soft_ad', quote: '冲锋衣点击下方链接领券', reason: '有购买引导' },
      ]),
    );
    const r = await classifyVideos([videos[0]!, hiking], cfg);
    vi.unstubAllGlobals();
    expect(r.llmUsed).toBe(true);
    expect(r.llmCheck).toMatchObject({ model: 'm', promptVersion: 'v2', sent: 2, judged: 2, used: true });
    const rows = r.llmCheck!.rows.map((x) => [x.video.bvid, !!x.llm, !!x.keyword]);
    expect(rows).toContainEqual(['BV_a', false, true]);
    // 计分只用模型的结论
    expect(r.evidence.filter((e) => e.tier === 'C').map((e) => e.bvid)).toEqual(['BV_b']);
  });

  it('没有配置模型时没有对照', async () => {
    expect((await classifyVideos(videos)).llmCheck).toBeUndefined();
  });

  it('模型漏判部分视频时也退回关键词，不混用两种口径', async () => {
    vi.stubGlobal('fetch', fakeFetch([{ id: 'BV_b', verdict: 'none' }]));
    const r = await classifyVideos(videos, cfg);
    vi.unstubAllGlobals();
    expect(r.llmUsed).toBe(false);
    expect(r.evidence.every((e) => e.source === 'rule')).toBe(true);
  });
});
