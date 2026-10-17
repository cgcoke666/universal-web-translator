# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。版本号同时维护在 `package.json` 与
`src/manifest.json`，`npm run pack` 会校验两者一致。

## [0.1.0] - 2026-10-17

首个公开版本。

### 新增

- **端上翻译**：接入 Chrome 内置 Translator API，免费、离线、文本不出设备；
  整页翻译与划词翻译统一走「端上优先 + 远端兜底」策略（`src/content/translateFlow.js`）。
- **多引擎适配器**：Microsoft/Edge、Google 免费通道、DeepL、OpenAI、DeepSeek、
  自定义 OpenAI 兼容网关、本地 Ollama / LM Studio，支持自定义兜底顺序。
- **整页双语对照**：按字符偏移精确回填译文，支持「双语对照 / 仅译文」切换、字号与颜色调整。
- **划词翻译**：选中即弹卡片，可复制译文。
- **动态内容跟进**：MutationObserver 增量补翻，支持 SPA 换页与无限滚动。
- **站点规则**：按域名设置自动翻译 / 永不翻译 / 独立目标语言。
- **悬浮球状态机**：待命 / 离线就绪 / 需下载语言包 / 翻译中 / 远端就绪，颜色即状态。
- **零依赖工程链**：自研打包器、产物校验、测试运行器、ZIP 打包，全部纯 Node 实现。
- **执行级产物校验**：`npm run verify` 会用最小宿主替身真正运行入口脚本。

### 修复

- 打包器 TDZ 缺陷：依赖解构被集中声明在 bundle 顶部，导致 service worker 注册失败。
- 打包器重复声明：多个模块导入同一绑定会生成重复 `const`，产物直接语法错误。
- 打包器对行内 `import` 静默产出坏代码，现改为构建期报错。
- `withTimeout` 未清理定时器，导致每条消息遗留 90 秒挂起定时器。
- 缺少 `_locales` 导致 Chrome 拒绝加载扩展（`default_locale` 校验）。
- 划词翻译绕过端上引擎，远端不可用时完全不可用。
- 微软免费通道授权端点 404 时反复请求，现改为冷却 10 分钟后重试。
- 语言包下载卡住时整页翻译无限等待，现加 60 秒上限并降级。

### 已知问题

- 微软 `edge.microsoft.com/translate/auth` 端点已返回 404，该免费通道目前不可用
  （代码会自动跳过并给出提示）。
- Google 免费通道在部分网络环境不可达。
- 内置翻译的语言包下载依赖 Chrome 的模型服务，网络受限时可能失败。
- 仅支持 Chromium 桌面版；移动端与 Firefox / Safari 不支持。
