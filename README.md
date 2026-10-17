# 沉浸式网页翻译 · Universal Web Translator

[![CI](https://github.com/cgcoke666/universal-web-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/cgcoke666/universal-web-translator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome 138+](https://img.shields.io/badge/Chrome-138%2B%20desktop-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/ai/translator-api)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-3b5bfd)](https://developer.chrome.com/docs/extensions/develop/migrate)

一个 **Chrome / Edge（Manifest V3）整页翻译扩展**：双语对照、划词翻译、动态内容自动跟进。

**默认优先使用 Chrome 内置 Translator API**——完全免费、无需注册、无需 API Key，文本在设备上翻译、不出本机；
不可用时按链自动降级到免费通道、自备 Key 的服务或本地 Ollama。整页翻译与划词翻译共用同一条策略。

> **English**: A Manifest V3 translation extension for Chromium browsers. It prefers Chrome's built-in
> Translator API (free, on-device, private) and falls back through a pluggable provider chain
> (free endpoints → your own API key → local Ollama). Zero-dependency build, zero runtime deps,
> and a test suite that actually *executes* the bundled artifacts.

---

## 功能特性

- **端上翻译优先**：内置 Translator API 跑在本机，离线可用、零成本、文本不离开设备
- **双语对照 / 仅译文** 两种展示，译文与原文逐段对齐（按字符偏移回填，不乱序）
- **划词翻译**：选中即弹卡片，同样优先走端上引擎
- **动态内容跟进**：SPA 换页、无限滚动、懒加载内容自动补翻（防抖 + 增量采集）
- **站点规则**：按域名设置「自动翻译 / 永不翻译 / 独立目标语言」
- **多引擎可插拔**：适配器模式，新增引擎只需实现一个 `translate()` 契约
- **务实工程**：零第三方依赖；构建、校验、测试、打包全部是纯 Node 脚本
- **结果可验证**：`verify` 会把产物**真正执行一遍**，不是只做语法检查
- **隐私友好**：无遥测、无统计上报；API Key 只存在浏览器本地存储

## 安装

### 方式一：下载 Release（普通用户，推荐）

1. 打开 [Releases](https://github.com/cgcoke666/universal-web-translator/releases) 下载最新的
   `universal-web-translator-vX.Y.Z.zip`
2. 解压到任意目录
3. Chrome / Edge 打开 `chrome://extensions` → 右上角开启 **开发者模式**
4. 点 **加载已解压的扩展程序** → 选择第 2 步解压出来的目录（含 `manifest.json` 的那一层）
5. 建议点工具栏拼图图标，把扩展**固定**出来

> 需要 **Chrome 138+ 桌面版** 才能使用内置翻译；更低版本会自动走远端通道。

### 方式二：从源码构建（开发者）

需要 Node.js ≥ 18，**无需 `npm install`**（本项目零依赖）：

```bash
git clone https://github.com/cgcoke666/universal-web-translator.git
cd universal-web-translator
npm run build      # 构建到 dist/
```

然后按方式一的第 3–5 步，选择 `dist/` 目录。

## 使用

### 悬浮球：一眼看出能不能离线用

右下角悬浮球上的**指示灯颜色**就是当前状态，点开即可一键启动：

| 指示灯 | 状态 | 含义 |
| --- | --- | --- |
| ⚪ 灰 | 待命 | 尚未检测；点一下即可翻译 |
| 🟢 绿 | 离线就绪 | 内置翻译可用，文本不出本机 |
| 🟠 橙 | 需下载语言包 | 主按钮仍可直接翻译（走远端）；也可点「提前下载语言包」 |
| 🔵 蓝（呼吸） | 翻译中 / 下载中 | 正在工作，按钮进入禁用态 |
| 🟢 绿 | 远端就绪 | 环境不支持内置翻译，已自动改用远端引擎 |

面板里的**引擎标识**会显示这次实际使用的引擎（内置翻译 · 离线 / Microsoft 通道 / 本地缓存 …），
方便确认"到底有没有走本地"。

### 快捷键与其它入口

| 操作 | 方式 |
| --- | --- |
| 翻译 / 还原整页 | 点悬浮球主按钮，或 `Alt+Shift+T` |
| 切换双语 / 仅译文 | 面板内切换，或 `Alt+Shift+M` |
| 划词翻译 | 选中文字，自动弹出译文卡片 |
| 翻译整页 / 选中文字 / 还原 | 右键菜单 |
| 引擎与站点规则 | 扩展设置页 |

### 首次使用：关于语言包

内置翻译首次翻译某个语言时，需要下载一个几 MB 的语言包（由 Chrome 提供）。
这个下载**必须由用户点击触发**（浏览器的 transient activation 要求），所以：

- 点悬浮球面板里的 **「下载语言包」** 或直接点主按钮即可，脚本调用会被浏览器拒绝；
- 下载完成后即可**完全离线**使用，不再有任何网络请求。

## 翻译引擎与优先级

请求按下面的顺序尝试，**前一级失败会自动落到下一级**：

| 优先级 | 引擎 | 运行位置 | 成本 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | **Chrome 内置 Translator API** | 页面上下文（content script） | 免费、离线 | 需 Chrome 138+ 桌面版；首次某语言需下载几 MB 语言包 |
| 2 | Microsoft / Edge 免费通道 | service worker | 免费 | ⚠️ 其授权端点 `edge.microsoft.com/translate/auth` 实测已返回 404，代码会在失效后冷却 10 分钟并快速跳过 |
| 3 | Google 免费通道 | service worker | 免费 | 公开 web 端点；在部分网络环境（如中国大陆）不可达，表现为 `Failed to fetch` |
| 4 | 自备 Key：DeepL / OpenAI / DeepSeek / 自定义网关 | service worker | 自付或自建 | 质量更高，也最可靠可控 |
| 5 | 本地 Ollama / LM Studio | service worker | 免费、离线 | 数据不出本机 |

> **为什么要说这些**：端上引擎是唯一不依赖任何外部服务的路径，所以整页与划词都优先走它。
> 但如果你所在网络连 Chrome 的模型下载服务也不可达，语言包就下不下来，此时只能靠第 4/5 类引擎。
> 扩展会在失败时明确告诉你属于哪种情况，而不是甩一句 HTTP 错误。

### 接入本地 Ollama / LM Studio

扩展访问 `http://127.0.0.1:11434` 属于跨域请求，**必须**让 Ollama 放行扩展来源，否则会 CORS 失败：

```bash
# macOS / Linux
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

```powershell
# Windows PowerShell
$env:OLLAMA_ORIGINS="chrome-extension://*"; ollama serve
```

然后在设置页选择 `Ollama / LM Studio（本地）`，填入模型名（如 `qwen2.5:7b`、`translategemma:4b`）。
默认端点 `http://127.0.0.1:11434/v1/chat/completions`。

## 常见问题

**装了之后页面上没有悬浮球？**
按顺序排查：① 当前是 `chrome://` 等浏览器内置页，内容脚本无法注入，换普通网站；
② 改了代码只重新加载了扩展但**没刷新页面**；③ 设置里关了「启用扩展」或「显示页面悬浮球」；
④ 该站点被设成了「永不翻译」。

**扩展加载时报 `Default locale was specified, but _locales subtree is missing`？**
`dist/` 里缺少 `_locales/zh_CN/messages.json`。这是构建产物不完整，重新 `npm run build` 即可
（`scripts/verify.mjs` 会兜住这个坑）。

**扩展页报 `Service worker registration failed`？**
产物本身有问题（常见是模块初始化顺序 / 重复声明）。执行 `npm run check`，它会真正执行产物并指出原因。

**划词/整页翻译只显示一串错误？**
看错误里的关键词：
- 提到**语言包下载失败** → 网络到不了 Chrome 的模型服务，反复点下载无效，改用第 4/5 类引擎；
- 提到 `HTTP 404` / `Failed to fetch` → 对应远端通道不可用，同样改用自备引擎。

**改了代码没生效？**
必须 **① 重新 `npm run build` → ② 扩展页点「重新加载」→ ③ 刷新目标网页**。旧的内容脚本不会自动替换。

## 隐私

- 默认路径下文本**不出本机**（Chrome 内置翻译在设备上推理）；
- 只有降级到远端引擎时，被翻译的文本才会发送给对应服务；
- API Key 仅保存在浏览器本地存储（`chrome.storage.local`），不经过任何第三方服务器；
- 本扩展**没有**任何遥测、统计或远程配置。

## 架构

### 为什么内置翻译的宿主是 content script，而不是 service worker / offscreen document

三条硬约束决定了它：

1. **MV3 service worker 里没有 `Translator` 全局**——它是 `Window`/`Worker` 作用域的 API；
2. **`Translator.create()` 需要 transient activation（用户手势）**——点击悬浮球、按快捷键、右键菜单那一刻
   天然带着手势；offscreen document 是隐藏页面，**永远没有用户手势**，首次下载语言包会以 `NotAllowedError` 失败；
3. 远端引擎的限速、去重、统计已经收敛在 background 的 pipeline 里，不该为端上引擎推倒重来。

于是分工是：

```
点击悬浮球 ──► content script
                 │  ① 采集文本（同步）
                 │  ② 趁手势还新鲜 → prewarm()  ← Translator.create()
                 │  ③ 逐批：端上翻译 → 没翻好的分段 ──► background pipeline ──► 远端引擎链
                 │  ④ 渲染（双语对照 / 仅译文）
```

因此本扩展**不申请 `offscreen` 权限**：端上推理的可靠宿主就是页面本身，多要一个用不到的权限只是权限膨胀。

### 目录结构

```
src/
  manifest.json
  background/       index.js（消息路由/菜单/快捷键）  pipeline.js（缓存→分块→降级）
  content/          index.js（主流程）  translateFlow.js（端上优先+远端兜底）
                    launchState.js（状态机）  onDeviceLoader.js（端上调度）
                    collector.js  segmenter.js  renderer.js  observer.js  ui.js  cache.js
  shared/           onDevice.js（Translator API 适配器）  constants.js  lang.js  queue.js  cache.js
  providers/        index.js（注册表）  base.js（契约）  googleFree/microsoft/deepl/openaiCompat
  _locales/zh_CN/   messages.json（manifest 的 __MSG_*__ 文案）
  options/  popup/  debug/
fixtures/demo-page.html   # 手动测试用的示例页面
test/                     # node:test 用例
scripts/                  # 构建 / 校验 / 测试 / 打包 / 图标（纯 Node，零依赖）
```

### 缓存与轻量

- 两端缓存：`shared/cache.js`（`chrome.storage.local` 分桶，跨会话）+ `content/cache.js`（页面级）；
- 只翻译**可见**元素，默认跳过 `<code>`/`<pre>`/导航/页脚；
- 批次受 `TaskQueue` 限速、相同请求去重，避免触发公共端点 429；
- 动态内容由 `MutationObserver` 防抖跟进，不做全页重排。

## 开发与验证

```bash
npm run build     # 构建 dist/
npm run verify    # 产物校验：语法、manifest+locale、ESM 路径、入口可执行
npm run test      # 单元测试（node:test，同进程，无需安装依赖）
npm run check     # build + verify + test（CI 跑的就是它）
npm run pack      # 生成 release/universal-web-translator-v<version>.zip

node scripts/test.mjs lang   # 只跑文件名含 lang 的用例
```

测试覆盖：DOM 采集、分段回填、渲染与 XSS 防护、语言检测、provider 解析容错、缓存与队列、
端上引擎全部分支（能力探测 / 实例复用 / 并发串行 / 下载进度 / 错误分类 / 降级 / 超时）、
翻译策略（端上优先、部分成功、失败提示）、打包器行为，以及两个入口的**可执行性**。

### 自研打包器踩过的坑（均已有回归测试）

为了零依赖，构建用的是 `scripts/lib/bundler.mjs` 这个极简打包器，代价是这些坑要自己踩明白：

| 症状 | 根因 | 现状 |
| --- | --- | --- |
| `Cannot access '__mod_xxx' before initialization` | 依赖解构被集中声明在 bundle 顶部；模块 IIFE 里被提升的函数声明在依赖初始化前执行，撞上 `const` 的 TDZ | 依赖解构移入各模块自身 IIFE |
| `Identifier 'normalizeText' has already been declared` | 同一绑定被多个模块导入，各自生成一条同名 `const`，同属一个函数作用域 | 外层作用域内同名绑定只声明一次 |
| 产物残留 `import`、导出对象为空 | 行锚定的正则匹配不到行内 `import ...; export ...`，静默产出坏代码 | 检测到无法内联的 import 时构建直接失败 |

**核心教训：语法检查是不够的。** 上述缺陷有语法完全合法的，`verify` 当时"全部通过"，
浏览器里却报 `Service worker registration failed`。所以现在 `verify` 会用最小宿主替身
把 `background.js` / `content.js` **真正执行一遍**。

另外修掉一个真实资源泄漏：`content/client.js` 的 `withTimeout` 用 `Promise.race` 却没在正常返回时
`clearTimeout`，每发一条消息就留一个 90 秒挂起定时器——浏览器里无害，却让"执行产物"的校验
从 4 秒变成 100 秒。

## 兼容性

| 环境 | 表现 |
| --- | --- |
| Chrome 138+ 桌面版 | 内置翻译可用（端上路径），可完全离线 |
| Chrome 110 ~ 137 | 可安装使用，自动走远端通道 |
| Edge / 其它 Chromium | 同上；内置翻译若可用则自动启用 |
| Firefox / Safari | 不支持（本项目基于 Chromium 的 MV3 与内置 AI API） |

## 贡献

欢迎 issue 与 PR。提交前请跑通 `npm run check`；开发约定与新增引擎的步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

## 免责声明

本项目与 Google、Microsoft、DeepL、OpenAI 等均无隶属关系。其中的"免费通道"使用的是对应服务的
公开 Web 接口，**随时可能变更或失效**（例如微软的授权端点已经 404），请勿用于高频批量或商业用途，
并自行遵守相关服务条款。翻译结果由第三方模型生成，可能存在错误，请勿用于法律、医疗等专业场景。
