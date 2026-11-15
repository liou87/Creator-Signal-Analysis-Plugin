import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { extractSnapshot } from '../src/extract/bilibili';
import { midFromUrl, nameFromTitle } from '../src/extract/identify';
import type { ContentRequest, ContentResponse } from '../src/messages';

// 内容脚本运行在空间页里，负责读取页面和请求 B 站公开接口。
// 侧边栏通过长连接发起一次提取，并接收进度。
export default defineContentScript({
  matches: ['https://space.bilibili.com/*'],
  main() {
    const flag = '__creatorSignalAnalysis';
    const w = window as unknown as Record<string, boolean>;
    if (w[flag]) return; // 侧边栏可能补注入一次，避免重复监听
    w[flag] = true;

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== 'csa') return;
      const send = (msg: ContentResponse) => {
        try {
          port.postMessage(msg);
        } catch {
          // 侧边栏已关闭
        }
      };
      port.onMessage.addListener(async (req: ContentRequest) => {
        if (req.type === 'identify') {
          send({
            type: 'identity',
            mid: midFromUrl(location.href),
            name: nameFromTitle(document.title),
          });
        } else if (req.type === 'extract') {
          try {
            const snapshot = await extractSnapshot((text) => send({ type: 'progress', text }));
            send({ type: 'done', snapshot });
          } catch (e) {
            send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
          }
        }
      });
    });
  },
});
