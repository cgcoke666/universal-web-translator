/**
 * 冒烟测试：把自检页（debug.js）依赖的全部模块在 Node 里真实 import 一遍。
 *
 * 这一步验证的是"模块图能加载"——包括 import 路径、顶层代码是否会因为缺少
 * 浏览器 API 而抛异常。语法检查（verify.mjs）管不到这些，而它们恰恰是最常见的
 * "打开页面白屏"原因。
 *
 * 需要伪造的浏览器全局只有两个：chrome（扩展 API）与 indexedDB（缓存用）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 最小可用的 chrome 替身：只覆盖被 import 时会用到的部分 */
function installChromeStub() {
  const store = new Map();
  globalThis.chrome = {
    runtime: {
      id: 'smoke-test',
      lastError: null,
      getManifest: () => ({ version: '0.0.0-smoke', manifest_version: 3 }),
      getURL: (path) => `chrome-extension://smoke-test/${path}`,
      sendMessage: async () => ({ ok: true, settings: {} }),
      onMessage: { addListener() {}, removeListener() {} },
      onInstalled: { addListener() {} },
      openOptionsPage() {}
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === undefined || keys === null) return Object.fromEntries(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (store.has(key)) out[key] = store.get(key);
          return out;
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
        }
      }
    },
    contextMenus: { removeAll(cb) { cb?.(); }, create() {}, onClicked: { addListener() {} } },
    tabs: { query: async () => [], sendMessage() {} },
    commands: { onCommand: { addListener() {} } }
  };
}

installChromeStub();

test('自检页依赖的模块可以全部加载，顶层代码无副作用异常', async () => {
  const modules = [
    '../src/shared/constants.js',
    '../src/shared/lang.js',
    '../src/shared/queue.js',
    '../src/shared/cache.js',
    '../src/shared/onDevice.js',
    '../src/providers/base.js',
    '../src/providers/googleFree.js',
    '../src/providers/microsoft.js',
    '../src/providers/deepl.js',
    '../src/providers/openaiCompat.js',
    '../src/providers/index.js',
    '../src/content/collector.js',
    '../src/content/segmenter.js',
    '../src/content/renderer.js',
    '../src/content/cache.js',
    '../src/content/launchState.js',
    '../src/content/onDeviceLoader.js'
  ];
  for (const spec of modules) {
    const loaded = await import(spec);
    assert.ok(Object.keys(loaded).length > 0, `${spec} 应导出内容`);
  }
});

test('模块间的契约一致：provider 注册表引用的实现模块都存在', async () => {  const { PRESETS, getModule, getPreset, isConfigured, resolveChain } = await import('../src/providers/index.js');
  assert.ok(PRESETS.length >= 6, '至少应内置 6 个引擎预设');
  for (const preset of PRESETS) {
    if (preset.kind === 'on-device') {
      // 端上引擎（Chrome 内置翻译）刻意没有 service worker 实现模块：
      // Translator.create() 需要用户手势，只存在于 content script 里。
      assert.equal(getModule(preset.id), null, `${preset.id} 不应有远端实现模块`);
      assert.ok(getPreset(preset.id), `${preset.id} 应能按 id 取回预设`);
      continue;
    }
    const mod = getModule(preset.id);
    assert.ok(mod, `预设 ${preset.id} 找不到实现模块`);
    assert.equal(typeof mod.translate, 'function', `${preset.id} 缺少 translate 实现`);
    assert.ok(getPreset(preset.id), `${preset.id} 应能按 id 取回预设`);
  }

  // 免费引擎必须"开箱可用"
  assert.equal(isConfigured('microsoft', {}), true);
  assert.equal(isConfigured('google-free', {}), true);
  // 需要 Key 的引擎未配置时必须被判定为不可用
  assert.equal(isConfigured('deepl', {}), false);
  assert.equal(isConfigured('openai', { openai: { endpoint: 'https://x/v1', model: 'm' } }), true);

  // auto 链在零配置下至少要有免费通道
  const chain = resolveChain('auto', {}, []);
  assert.ok(chain.includes('microsoft'), `auto 链应包含免费通道，实际 ${chain.join(' → ')}`);
});

test('内置翻译：引擎 id 与语言表在共享层与注册表之间保持一致', async () => {
  const { ON_DEVICE_PROVIDER_ID, ON_DEVICE_LANGUAGES, normalizeOnDeviceLang } = await import(
    '../src/shared/onDevice.js'
  );
  const { PRESETS } = await import('../src/providers/index.js');
  const { normalizeLangFor, DEFAULT_SETTINGS } = await import('../src/shared/constants.js');

  // 两边写死的 id 必须一致，否则设置页选中的引擎在 content 侧认不出来
  assert.ok(
    PRESETS.some((preset) => preset.id === ON_DEVICE_PROVIDER_ID),
    `注册表里应有 ${ON_DEVICE_PROVIDER_ID}`
  );
  assert.equal(normalizeLangFor('on-device', 'zh-CN'), normalizeOnDeviceLang('zh-CN'));

  // 默认目标语言必须能落到内置翻译支持的语言表里（否则永远是"不可用→降级"）
  const supported = new Set(ON_DEVICE_LANGUAGES.map((lang) => lang.code));
  for (const code of [DEFAULT_SETTINGS.targetLang, 'zh-TW', 'en', 'ja']) {
    assert.ok(
      supported.has(normalizeOnDeviceLang(code)),
      `${code} 归一后应存在于内置翻译语言表（得到 ${normalizeOnDeviceLang(code)}）`
    );
  }
});

test('端到端（离线）：采集 → 分段 → 缓存 → 渲染 → 还原 全链路可用', async () => {
  installChromeStub();
  const { DomCollector } = await import('../src/content/collector.js');
  const { segmentRecords } = await import('../src/content/segmenter.js');
  const { TranslationRenderer } = await import('../src/content/renderer.js');
  const { TranslationCache } = await import('../src/shared/cache.js');
  const { createDocument } = await import('./helpers/dom.mjs');

  const doc = createDocument(`
    <article>
      <h1>Offline end-to-end check</h1>
      <p>First sentence here. Second sentence follows! Third one?</p>
      <pre><code>const ignored = true;</code></pre>
      <input placeholder="Search the docs" />
    </article>`);

  // 1) 采集
  const collector = new DomCollector({
    skipSelectors: [],
    onlySelectors: [],
    noiseSelectors: [],
    skipNoise: false,
    minTextLength: 2,
    maxNodeLength: 6000,
    translatePlaceholder: true,
    translateAriaLabel: false,
    translateImageAlt: false,
    translateTitle: false,
    translateShadowDom: true,
    isVisible: () => true
  });
  const records = collector.collect(doc);
  assert.ok(records.length >= 3, `应采集到标题/正文/占位符，实际 ${records.length}`);

  // 2) 分段：h1 一段、正文三句合并为一段（总长未超预算）、placeholder 一段
  const pieces = segmentRecords(
    records.map((record) => ({ recordId: record.id, text: record.text, target: record.target })),
    { minTextLength: 2, batchMaxChars: 1200 }
  );
  assert.equal(pieces.length, 3, `短句应被合并以减少请求，实际 ${pieces.length} 段`);
  assert.ok(
    pieces.some((piece) => piece.text.includes('First sentence here. Second sentence follows!')),
    '相邻短句应合并进同一分段'
  );

  // 3) 缓存：模拟"第二次访问同一页面"
  const cache = new TranslationCache({ storage: chrome.storage.local });
  const targetLang = 'zh-CN';
  const fakeTranslations = pieces.map((piece, index) => `${piece.text.length}字译文${index}`);
  pieces.forEach((piece, index) => cache.set(piece.text, targetLang, fakeTranslations[index]));
  await cache.flushNow();
  const warm = new TranslationCache({ storage: chrome.storage.local });
  await warm.warmup();
  const hits = pieces.filter((piece) => warm.get(piece.text, targetLang) !== undefined).length;
  assert.equal(hits, pieces.length, '所有分段都应命中持久化缓存');

  // 4) 渲染
  const renderer = new TranslationRenderer({
    displayMode: 'bilingual',
    color: '#4b7bec',
    fontScale: 0.95,
    markdown: true,
    originalTooltip: true,
    showFlag: false
  });
  const before = doc.body.textContent;
  for (const record of records) {
    if (record.target.kind !== 'text') continue;
    renderer.renderRecord({
      doc,
      record,
      translated: '【译文】'
    });
  }
  assert.ok(renderer.size >= 2, '应插入至少两个译文节点');
  assert.ok(doc.body.textContent.includes('【译文】'));

  // 5) 还原：原文一字不差
  renderer.clear();
  for (const record of records) {
    if (record.target?.kind !== 'attr') continue;
    const el = record.target.element;
    const original = el.getAttribute(`data-dsh-attr-orig-${record.target.attr}`);
    if (original !== null) el.setAttribute(record.target.attr, original);
  }
  assert.equal(doc.body.textContent, before, '还原后文本内容必须与翻译前完全一致');
  await cache.clear();
});
