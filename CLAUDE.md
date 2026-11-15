# 给 AI 协作者的说明

## 项目是什么

一个 Chrome 插件（MV3）。用户在 B 站 UP 主空间页（`space.bilibili.com/{mid}`）打开侧边栏，点「开始分析」，得到该创作者的**商业化程度指数**及其依据。

这是一个面试作业。验收方式是当面演示并解释分数，所以**可解释性优先于功能数量**：任何评分逻辑都必须能说清「为什么这样算」。

先读 [docs/DESIGN.md](docs/DESIGN.md)（算什么、为什么），再读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（代码怎么组织）。

## 不可违反的约束

1. **大模型不出分。** 分数只由 `src/scoring/` 里的确定性公式算出。模型只把内容归类为证据，且只能影响「疑似软广」一档。
2. **评分引擎是纯函数。** `src/scoring/` 不得依赖浏览器接口、网络或时间，方便测试和复现。
3. **参数只有一个出处。** 所有权重、阈值定义在 `src/scoring/config.ts`，别处不得写死数字。
4. **每条证据可回溯。** 证据必须带原文引用，且引用必须是输入文本的子串，否则丢弃。
5. **没抓到 ≠ 没有。** 账号层指标是三态：有 / 无 / 未能检查。未能检查只降低置信度，不扣分。
6. **只读公开内容。** 不读取登录态下的私有数据；API Key 只存浏览器本地存储，绝不写入仓库。

## 改了什么，就同步哪份文档

| 改动 | 必须同步 |
|---|---|
| 评分公式、权重、阈值、档位定义 | `docs/DESIGN.md` + `docs/DECISIONS.md` 新增一条 |
| 模块划分、数据结构、数据来源 | `docs/ARCHITECTURE.md` |
| 任何「在两个方案里选了一个」的决定 | `docs/DECISIONS.md` |
| 安装方式、使用流程 | `README.md` |
| 校准数据或结论 | `docs/CALIBRATION.md` |

`docs/DECISIONS.md` 只追加、不改写历史；推翻旧决定时新增一条并在旧条目标注「已被 D-xx 取代」。

## 命令

```bash
npm test           # 单元测试（Vitest）。改评分或规则后必须跑
npm run typecheck  # 类型检查
npm run build      # 构建到 .output/chrome-mv3，在 chrome://extensions 里加载这个目录
npm run dev        # 开发模式
```

提交前三项都要通过：`npm test && npm run typecheck && npm run build`。

## 目录地图

```
entrypoints/        插件入口。background 只负责打开侧边栏；content 在空间页里跑提取
src/types.ts        三个核心数据结构：CreatorSnapshot → Evidence[] → Report
src/extract/        B 站数据提取（接口为主、页面为辅）、WBI 签名；identify.ts 从地址识别创作者
src/classify/       rules.ts 规则；account.ts 账号层；llm.ts 模型；index.ts 入口
src/scoring/        config.ts 全部参数；score.ts 评分公式（纯函数）
src/pipeline.ts     侧边栏一侧的流程编排
src/ui/             侧边栏界面
tests/              pipeline.test.tsx 是端到端算例，改公式时先看它
```

## 当前最大的未知数

数据提取**没有在真实浏览器里验证过**（开发环境直接请求 B 站接口会被风控拦截，见 D-17）。
接口路径、返回字段、页面文字的判断都来自公开资料和经验，可能与现状不符。
验证方法：加载插件，在真实空间页上跑一次，看报告底部的「数据来源自检」。
验证结果要写回 `docs/ARCHITECTURE.md` 的「数据来源」表。

## 约定

- 语言：TypeScript，文档和界面文案用中文，代码标识符用英文。
- 包管理：npm（本机没有 pnpm）。
- 提交：一个决定或一个功能一次提交，提交信息写「为什么」。推送前先征得用户同意。
