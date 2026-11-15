import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';

// 后台脚本只做一件事：点击工具栏图标时打开侧边栏。
// 用侧边栏而不是弹窗，是因为用户点证据链接跳转时弹窗会关闭（D-18）。
export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
