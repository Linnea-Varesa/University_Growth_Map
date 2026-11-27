# HANDOFF · 大学成长地图（Qoder Sites 单版本）

2026-11-27 起只保留 Qoder Sites 这条线。WorkBuddy 资料库版（`__SMART_PAGE__.database`
SDK、6 张数据表、schema/seed/建表工具）与更早的自建服务端（`server.mjs` / `start.cmd` /
`tools/legacy`）已删除，需要考古去 git 历史（`572db42` 及之前）。

---

## 1. 形态与数据层

- `index.html`：HTML + CSS + 应用 JS 一体，插画内联为 data URI，零 CDN/框架。
- `atlas-ai-consult.js`：AI 咨询模块，外链引入（IIFE、零依赖、类名全 `atlas-ai-` 前缀）。
- 数据存浏览器 **localStorage**，无账号体系、无跨设备同步。示例数据内置在页面里，
  带「示例（请替换）」标记，统计默认剔除。
- 挂载链路：页面 `bindAI()` 设置 `window.AtlasAIProvider` → `AtlasAI.mount()`。
  数据桥每次打开面板重新取，改完数据不用重挂。

## 2. 发布与账号

- 发布记录 `.大学成长地图.qoder.site` 绑定**队友的 Qoder 账号**；线上地址
  `https://college-growth-atlas-janhbyll1di.qoder.zone/`。
- 其他账号名下没有这个站点，无法直接更新。更新路径：提交推送 → 队友拉取 → 队友重新发布。
- 发布至少带 `index.html` + `atlas-ai-consult.js`。Qoder Sites 整目录托管，外链 JS 正常加载。

## 3. 已知坑（都踩过）

### 3.1 单 HTML 托管必丢外链 JS
「只传一个 HTML」的形态（如 WorkBuddy 资料库上传）不会带 `atlas-ai-consult.js`，
线上 404 → `window.AtlasAI` 不存在，AI 面板与「问AI」全失效。那种形态必须先把模块
内联进 HTML（内联时 `</script` 字面量要转义成 `<\/script`，否则截断页面）。
Qoder Sites 整目录托管无此问题。

### 3.2 平台徽标压住悬浮按钮
Qoder Sites 在右下角注入「Made with Qoder」徽标，挂在 `<html>` 上、DOMContentLoaded
时注入。v1.1.2 的 `avoidBadge()` 用 MutationObserver 观察 documentElement + 延时兜底，
检测到就给 body 加 `atlas-ai-with-badge`，悬浮按钮与面板抬高让位。改徽标相关逻辑时
注意注入时机晚于模块 mount。

### 3.3 改插画要改两处
`assets/*.svg` 是源文件，`index.html` 里已内联成 data URI（4 处）。改了 SVG 必须
重新内联，否则页面不变。

### 3.4 ICS 导出
纯前端生成（Blob 下载）。UTF-8 按 75 字节折行；`TextEncoder` 仅现代浏览器有，
IE 下折行失效——目标环境是现代浏览器，可接受。

### 3.5 中文文件名进 zip
Windows 下打中文名接收方解压可能乱码。工程刻意全用 ASCII 文件名，保持这个约定。

## 4. 怎么验证没改坏

```bash
python tools/check-js.py    # 内联块 + 外链模块语法自检（pip install esprima）
```

浏览器控制台自检钩子：`window.__APP_STATE__()` 应返回启动状态与数据计数，
`window.__APP_ERROR__` 应为空。

冒烟清单：

- [ ] 四视图切换正常，空数据不崩（各视图有空态）
- [ ] 跨月/跨年日期正确（月历切换、倒计时）
- [ ] 批量删除 + 撤销恢复
- [ ] ICS 导出（提醒模式、长赛期单事件）
- [ ] AI 面板开合；未配 Key 时「问AI」预填不丢（v1.1.1）
- [ ] 线上徽标出现时悬浮按钮让位（v1.1.2）
- [ ] 窄屏无横向溢出

## 5. 版本

| 版本 | 内容 |
|---|---|
| v1.0.0 | 队友交付的 AI 模块原始版 |
| v1.1.0 | 校园绿 × 液态玻璃外观适配 + Qoder 账号登录状态行 |
| v1.1.1 | 未配 Key 时「问AI」预填问题保留到输入框出现 |
| v1.1.2 | 检测 Qoder Sites 徽标并让位 |

## 6. 环境

- 浏览器：Chrome / Edge / Safari 现代版本。
- Python 3 + esprima（仅语法自检用，页面本身不依赖）。
- 编码统一 UTF-8。