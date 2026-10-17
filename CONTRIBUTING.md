# 贡献指南

感谢你愿意参与。这个项目刻意保持"零依赖 + 可完全离线验证"，请先读一下约定再动手。

## 环境

- Node.js ≥ 18（开发时用到 20 / 22 也都可以，CI 矩阵覆盖这两档）
- Chrome / Edge 桌面版（调端上引擎需要 138+）
- **不需要 `npm install`**：项目没有任何第三方依赖

## 常用命令

```bash
npm run build     # 构建到 dist/
npm run verify    # 产物校验（语法 / manifest+locale / ESM 路径 / 入口可执行）
npm run test      # 单元测试
npm run check     # 上面三件事一起做，提交前必须通过
npm run pack      # 生成 release/*.zip
```

只跑某个测试文件：`node scripts/test.mjs <文件名片段>`，例如 `node scripts/test.mjs lang`。

## 代码约定

1. **不引入运行时依赖，也不引入构建依赖。** 需要的能力优先自己写（打包器、ZIP、PNG 编码都是这么来的），
   并且要写清楚"为什么必须自己写"。
2. **不用 TypeScript 编译**，类型信息用 JSDoc 表达；但关键契约（provider、消息协议）必须有 JSDoc。
3. **注释解释"为什么"，而不是"做了什么"。** 尤其是踩过坑的地方：写清楚错误症状与根因，
   否则下一个人会原样踩回去。
4. **把决策做成纯函数并单测。** 例如引擎选择、失败提示、悬浮球状态机，都是纯函数模块，
   这样最容易被改坏的行为才能被测试钉住。
5. **不允许"静默产出坏代码/坏状态"。** 构建期能发现的错误就构建期报错；运行期出错要给出
   用户能照做的提示，而不是裸的 `HTTP 404`。

## 新增一个翻译引擎

1. 在 `src/providers/` 新建实现，导出 `meta` 与 `translate({segments, targetLang, sourceLang, config})`：
   - 返回数组长度必须与 `segments` 一致、顺序对应；单条失败填 `null`，整体失败才 `throw`；
   - 语言码差异在 `src/shared/constants.js` 的 `normalizeLangFor` 里抹平；
   - 需要网络访问时，把端点写进 `src/manifest.json` 的 `host_permissions`。
2. 在 `src/providers/index.js` 的 `PRESETS` 注册（`kind` / `needsKey` / 默认端点）。
3. 在 `test/providers.test.mjs` 补上响应解析与错误分支的用例。
4. 如果它要进默认兜底链，改 `AUTO_CHAIN` 并说明理由。

## 改 content script 的注意事项

- **端上翻译的 `Translator.create()` 必须发生在用户手势的同步阶段**，不要在它前面 `await`
  任何慢操作（详见 `src/content/index.js` 的 `prepareOnDevicePack`）。
- 新增的翻译入口请统一走 `src/content/translateFlow.js`，不要自己再拼一遍"端上优先"逻辑
  （历史上划词翻译就是这么被漏掉的）。
- 从页面读取的信息一律视为不可信；渲染译文走 `renderer.js` 的受限渲染，禁止直接 `innerHTML`。

## 提交与 PR

- 提交信息建议用 `type: 摘要`（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`）。
- PR 描述里请写清楚：**现象 → 根因 → 修法 → 怎么验证的**。
- `npm run check` 必须通过；如果修的是构建/打包相关，请同时补一个能复现原缺陷的测试。

## 报告问题

提 issue 时请附上：

- Chrome 版本、操作系统；
- 扩展页（`chrome://extensions`）里的报错原文；
- 页面上划词卡片/面板显示的错误原文（它会区分"语言包下载失败""远端通道不可用"等情况）；
- 复现步骤（哪个网站、点了什么）。
