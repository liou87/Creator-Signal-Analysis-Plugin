import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '创作者信号分析',
    description: '在 B 站 UP 主空间页分析创作者的商业化程度，并说明分数的计算方式与依据',
    permissions: ['sidePanel', 'storage', 'scripting'],
    // 只申请读取 B 站公开页面与接口所需的权限
    host_permissions: ['https://space.bilibili.com/*', 'https://api.bilibili.com/*'],
    // 模型接口地址由用户填写，保存时再按该地址单独申请
    optional_host_permissions: ['https://*/*', 'http://localhost/*'],
    action: { default_title: '打开创作者信号分析' },
  },
});
