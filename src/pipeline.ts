import { browser } from 'wxt/browser';
import { classifyAccount } from './classify/account';
import { classifyVideos, type LlmCheck } from './classify';
import { summarizeHistory } from './classify/history';
import type { KeyValueStore, LlmConfig } from './classify/llm';
import { midFromUrl } from './extract/identify';
import type { ContentRequest, ContentResponse } from './messages';
import { score, selectWindow } from './scoring/score';
import type { CreatorSnapshot, Report } from './types';

/**
 * 侧边栏一侧的分析流程：提取（内容脚本）→ 取样 → 分类 → 评分。
 * 不持久化创作者数据；只缓存模型对单条视频文本的判定结果。
 */

const CONTENT_SCRIPT = '/content-scripts/content.js';

export const storageCache: KeyValueStore = {
  async get(key) {
    return (await browser.storage.local.get(key))[key];
  },
  async set(key, value) {
    await browser.storage.local.set({ [key]: value });
  },
};

export async function loadLlmConfig(): Promise<LlmConfig | undefined> {
  const cfg = (await browser.storage.local.get('llmConfig')).llmConfig as LlmConfig | undefined;
  return cfg?.baseUrl && cfg.apiKey && cfg.model ? cfg : undefined;
}

export async function saveLlmConfig(cfg: LlmConfig | undefined): Promise<void> {
  if (cfg) await browser.storage.local.set({ llmConfig: cfg });
  else await browser.storage.local.remove('llmConfig');
}

/** 向内容脚本发一个请求，直到收到终止消息。连接不上时补注入一次再试 */
function talk(
  tabId: number,
  request: ContentRequest,
  onMessage: (msg: ContentResponse) => boolean,
): Promise<void> {
  const attempt = () =>
    new Promise<void>((resolve, reject) => {
      const port = browser.tabs.connect(tabId, { name: 'csa' });
      let finished = false;
      port.onMessage.addListener((msg: ContentResponse) => {
        if (onMessage(msg)) {
          finished = true;
          port.disconnect();
          resolve();
        }
      });
      port.onDisconnect.addListener(() => {
        if (!finished) reject(new Error('无法连接到页面'));
      });
      port.postMessage(request);
    });

  return attempt().catch(async () => {
    // 页面在插件安装之前就已打开时，内容脚本还没注入
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    return attempt();
  });
}

export interface Identity {
  tabId: number;
  mid: string;
  name: string | null;
}

export async function identifyActiveTab(): Promise<Identity | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  // 只对 B 站空间页有主机权限，其他页面的 url 取不到
  const mid = midFromUrl(tab?.url ?? '');
  if (!tab?.id || !mid) return null;
  let name: string | null = null;
  try {
    await talk(tab.id, { type: 'identify' }, (msg) => {
      if (msg.type !== 'identity') return false;
      name = msg.name;
      return true;
    });
  } catch {
    // 取不到昵称不影响发起分析
  }
  return { tabId: tab.id, mid, name };
}

export interface AnalysisResult {
  report: Report;
  llmError?: string;
  llmCheck?: LlmCheck;
}

export async function analyze(
  tabId: number,
  onProgress: (text: string) => void,
): Promise<AnalysisResult> {
  let snapshot: CreatorSnapshot | undefined;
  let failure: string | undefined;
  await talk(tabId, { type: 'extract' }, (msg) => {
    if (msg.type === 'progress') onProgress(msg.text);
    if (msg.type === 'done') snapshot = msg.snapshot;
    if (msg.type === 'error') failure = msg.message;
    return msg.type === 'done' || msg.type === 'error';
  });
  if (!snapshot) throw new Error(failure ?? '提取失败');

  const videos = selectWindow(snapshot.videos, snapshot.capturedAt);
  const llm = await loadLlmConfig();
  onProgress(llm ? '模型判定疑似软广' : '规则分类');
  const classified = await classifyVideos(videos, llm, storageCache);
  const account = classifyAccount(snapshot, videos);

  const report = score(snapshot, videos, classified.evidence, account, {
    llmUsed: classified.llmUsed,
    history: summarizeHistory(snapshot.videos, videos),
  });
  return { report, llmError: classified.llmError, llmCheck: classified.llmCheck };
}
