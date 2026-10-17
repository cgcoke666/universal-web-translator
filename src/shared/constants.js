/**
 * 共享常量与纯函数工具层。
 *
 * 该文件被三类运行环境同时使用：
 *  - MV3 service worker（ESM 动态 import）
 *  - content script（esbuild 打成单文件经典脚本）
 *  - options / popup 页面
 * 因此这里禁止出现 `window` / `document` / `chrome` 之外的宿主假设，
 * 所有依赖注入式写法优先，便于在 Node 里做单元测试。
 */

/* ------------------------------------------------------------------ *
 * 消息协议
 * ------------------------------------------------------------------ */

export const MSG = {
  /** content -> background：翻译一批分段 */
  TRANSLATE: 'translator/translate',
  /** options：连通性测试 */
  TEST_PROVIDER: 'translator/testProvider',
  /** content（顶层框架）-> background：把命令转发给同标签页的其它 frame */
  RELAY_TO_FRAMES: 'translator/relayToFrames',
  /** content -> background：读写持久缓存 */
  CACHE_GET: 'translator/cacheGet',
  CACHE_PUT: 'translator/cachePut',
  CACHE_STATS: 'translator/cacheStats',
  CACHE_CLEAR: 'translator/cacheClear',
  /** 任意页面 <-> background：设置 */
  GET_SETTINGS: 'translator/getSettings',
  SET_SETTINGS: 'translator/setSettings',
  /** background -> content：命令（来自 popup / 快捷键 / 右键菜单） */
  CMD: 'translator/command',
  /** popup -> content：查询状态 */
  STATUS: 'translator/status'
};

export const CMD = {
  TRANSLATE_PAGE: 'translatePage',
  RESTORE_PAGE: 'restorePage',
  TOGGLE: 'toggle',
  SET_MODE: 'setMode',
  SET_TARGET: 'setTarget',
  PREVIEW: 'preview',
  CANCEL: 'cancel'
};

/* ------------------------------------------------------------------ *
 * 存储键
 * ------------------------------------------------------------------ */

export const STORAGE_KEYS = {
  settings: 'settings',
  cache: 'cache',
  stats: 'stats'
};

/** chrome.storage.local 分桶写入缓存，避免单键过大 */
export const CACHE_BUCKETS = 8;

/* ------------------------------------------------------------------ *
 * 语言
 * ------------------------------------------------------------------ */

export const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English 英语' },
  { code: 'ja', label: '日本語 日语' },
  { code: 'ko', label: '한국어 韩语' },
  { code: 'fr', label: 'Français 法语' },
  { code: 'de', label: 'Deutsch 德语' },
  { code: 'es', label: 'Español 西班牙语' },
  { code: 'pt', label: 'Português 葡萄牙语' },
  { code: 'it', label: 'Italiano 意大利语' },
  { code: 'ru', label: 'Русский 俄语' },
  { code: 'ar', label: 'العربية 阿拉伯语' },
  { code: 'hi', label: 'हिन्दी 印地语' },
  { code: 'th', label: 'ไทย 泰语' },
  { code: 'vi', label: 'Tiếng Việt 越南语' },
  { code: 'id', label: 'Bahasa Indonesia 印尼语' },
  { code: 'tr', label: 'Türkçe 土耳其语' },
  { code: 'pl', label: 'Polski 波兰语' },
  { code: 'nl', label: 'Nederlands 荷兰语' },
  { code: 'uk', label: 'Українська 乌克兰语' }
];

export const AUTO_DETECT = 'auto';

/** provider 语言码与 BCP-47 差异较大的做一次映射 */
export function normalizeLangFor(providerId, code) {
  if (!code || code === AUTO_DETECT) return 'auto';
  const lower = code.toLowerCase();
  if (providerId === 'deepl') {
    // DeepL 用大写目标码，且中文必须区分简繁
    if (lower === 'zh-cn' || lower === 'zh') return 'ZH';
    if (lower === 'zh-tw') return 'ZH-HANT';
    if (lower === 'pt') return 'PT-PT';
    return lower.toUpperCase();
  }
  if (providerId === 'microsoft' || providerId === 'edge') {
    if (lower === 'zh' || lower === 'zh-cn') return 'zh-Hans';
    if (lower === 'zh-tw') return 'zh-Hant';
    return lower;
  }
  if (providerId === 'google' || providerId === 'google-free') {
    if (lower === 'zh-cn' || lower === 'zh') return 'zh-CN';
    if (lower === 'zh-tw') return 'zh-TW';
    return lower;
  }
  if (providerId === 'on-device') {
    // Chrome 内置 Translator API 用 BCP-47，且中文只区分 zh / zh-Hant
    if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans' || lower === 'zh-sg') return 'zh';
    if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-Hant';
    if (lower === 'pt' || lower === 'pt-br' || lower === 'pt-pt') return 'pt-BR';
    return lower;
  }
  // OpenAI / Ollama 使用人类可读名称最稳
  return LANGUAGE_NAMES[code] ?? code;
}

/**
 * 某个内部语言码在端上引擎里的 BCP-47 写法。
 * 设置页用它判断"目标语言能不能走内置翻译"，避免给出错误承诺。
 * 注意不要 import shared/onDevice.js：那里反过来要 import 本文件的工具。
 * @param {string} code
 */
export function toOnDeviceLang(code) {
  return normalizeLangFor('on-device', code);
}

export const LANGUAGE_NAMES = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  tr: 'Turkish',
  pl: 'Polish',
  nl: 'Dutch',
  uk: 'Ukrainian'
};

/* ------------------------------------------------------------------ *
 * 站点适配：默认跳过选择器
 * ------------------------------------------------------------------ */

export const DEFAULT_SKIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'textarea',
  'input',
  'select',
  'option',
  'optgroup',
  'code',
  'pre',
  'kbd',
  'samp',
  'var',
  'math',
  'syntax-highlight',
  'shiki',
  '[contenteditable="true"]',
  '[data-dsh-translator]',
  '[data-dsh-block]',
  '[aria-hidden="true"]',
  '[role="textbox"]',
  '.CodeMirror',
  '.cm-editor',
  '.monaco-editor',
  '.ace_editor',
  '.highlight',
  '.hljs',
  '.katex',
  '.MathJax',
  '.mjx-container',
  '#dsh-translator-root'
];

/** 常见站点噪音（导航/侧栏/页脚/评论框），默认关闭以免过度翻译 */
export const COMMON_NOISE_SELECTORS = [
  'nav',
  'footer',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[role="menu"]',
  '[role="toolbar"]',
  '[role="tablist"]'
];

/* ------------------------------------------------------------------ *
 * 可见性
 * ------------------------------------------------------------------ */

const HIDDEN_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);

/**
 * 元素是否可见。这是"该不该翻译这段文字"的第一道闸门：
 * 隐藏的模板、预加载内容、折叠菜单都不应该浪费翻译配额。
 *
 * 优先用 Element.checkVisibility（Chrome 105+，能一次性考虑 display/visibility/
 * content-visibility），退化到 computedStyle + getClientRects。
 * @param {Element} el
 */
export function defaultIsVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  if (HIDDEN_TAGS.has(el.tagName)) return false;
  if (el.hasAttribute('hidden')) return false;
  if (typeof el.closest === 'function' && el.closest('[hidden]')) return false;

  if (typeof el.checkVisibility === 'function') {
    try {
      return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true, contentVisibilityAuto: true });
    } catch {
      /* 参数不被支持时退回下面的判断 */
    }
  }
  const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 默认设置
 * ------------------------------------------------------------------ */

/**
 * 设置项形状（JSDoc 形式，工程不使用 TypeScript 编译）：
 *
 * @typedef {object} ProviderConfig
 * @property {string} [apiKey]
 * @property {string} [endpoint]
 * @property {string} [model]
 * @property {string} [region]
 * @property {number} [temperature]
 * @property {string} [systemPrompt]
 *
 * @typedef {object} Settings
 * @property {number} version
 * @property {boolean} enabled
 * @property {string} targetLang
 * @property {string} sourceLang
 * @property {'bilingual'|'replace'} displayMode
 * @property {string} provider
 * @property {string[]} fallbackProviders
 * @property {Record<string, ProviderConfig>} providerConfig
 * @property {boolean} autoTranslateOnLoad
 * @property {boolean} translateTitle
 * @property {boolean} translatePlaceholder
 * @property {boolean} translateAriaLabel
 * @property {boolean} translateImageAlt
 * @property {boolean} skipNoise
 * @property {boolean} translateShadowDom
 * @property {boolean} translateIframes
 * @property {number} minTextLength
 * @property {number} maxNodeLength
 * @property {number} batchMaxChars
 * @property {number} concurrency
 * @property {Record<string, 'auto'|'always'|'never'>} siteMode
 * @property {Record<string, string>} siteTargetLang
 * @property {string[]} skipSelectors
 * @property {string[]} onlySelectors
 * @property {boolean} followDynamicContent
 * @property {number} mutationDebounceMs
 * @property {number} bilingualFontScale
 * @property {string} bilingualColor
 * @property {boolean} showFloatingButton
 * @property {boolean} translateOnSelection
 * @property {boolean} markdownRendering
 * @property {boolean} originalTooltip
 * @property {boolean} enableCache
 * @property {boolean} enableOnDevice
 * @property {boolean} debug
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,
  targetLang: 'zh-CN',
  sourceLang: AUTO_DETECT,
  displayMode: 'bilingual',
  provider: 'auto',
  fallbackProviders: ['microsoft', 'google-free'],
  providerConfig: {
    deepl: { endpoint: 'https://api-free.deepl.com' },
    openai: {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      temperature: 0
    },
    deepseek: {
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      temperature: 0
    },
    ollama: {
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen2.5:7b',
      temperature: 0
    },
    microsoft: { region: '' }
  },

  autoTranslateOnLoad: false,
  translateTitle: true,
  translatePlaceholder: true,
  translateAriaLabel: false,
  translateImageAlt: false,
  skipNoise: false,
  translateShadowDom: true,
  translateIframes: true,
  minTextLength: 2,
  maxNodeLength: 6000,
  batchMaxChars: 1200,
  concurrency: 3,

  siteMode: {},
  siteTargetLang: {},
  skipSelectors: [],
  onlySelectors: [],

  followDynamicContent: true,
  mutationDebounceMs: 400,
  bilingualFontScale: 0.95,
  bilingualColor: '#4b7bec',
  showFloatingButton: true,
  translateOnSelection: true,
  markdownRendering: true,
  originalTooltip: true,
  enableCache: true,
  /**
   * 是否优先使用 Chrome 内置 Translator API（端上翻译）。
   * 默认开启：零成本、无需 Key、文本不出设备；不可用时自动降级到远端引擎。
   */
  enableOnDevice: true,
  debug: false
};

/** 深合并用户设置，保证新增字段始终有默认值 */
export function mergeSettings(raw) {
  const out = structuredCloneSafe(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return out;
  const src = raw;
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined || value === null) continue;
    if (key === 'providerConfig' && typeof value === 'object') {
      for (const [pid, pv] of Object.entries(value)) {
        out.providerConfig[pid] = { ...(out.providerConfig[pid] ?? {}), ...pv };
      }
      continue;
    }
    if (key === 'siteMode' || key === 'siteTargetLang') {
      if (typeof value === 'object') out[key] = { ...value };
      continue;
    }
    if (Array.isArray(value) || typeof value !== 'object') {
      out[key] = value;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 纯函数工具
 * ------------------------------------------------------------------ */

/** 深拷贝；structuredClone 不可用时退回 JSON（设置对象是纯数据，够用） */
export function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fallthrough */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/** 折叠空白，用于缓存键与语言检测 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 稳定 32 位 hash（FNV-1a），用于缓存键与埋点计数 */
export function hash32(input) {
  let h = 0x811c9dc5;
  const text = String(input ?? '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cacheKey(target, text) {
  return `${target}|${hash32(normalizeText(text))}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 去掉数组里重复/空白项 */
export function uniqCompact(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const v = typeof item === 'string' ? item.trim() : '';
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * 按字符预算把数组切块。
 * @param {readonly unknown[]} items 待切分元素
 * @param {number} budget 每块字符预算
 * @param {(item: unknown, index: number) => number} sizeOf 计算单个元素字符数
 */
export function chunkBySize(items, budget, sizeOf) {
  const chunks = [];
  let current = [];
  let used = 0;
  items.forEach((item, index) => {
    const size = sizeOf(item, index);
    if (current.length > 0 && used + size > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 通配符匹配：`*.example.com`、`example.com`、`*` */
export function matchHostPattern(hostname, pattern) {
  const p = String(pattern ?? '').trim().toLowerCase();
  if (!p) return false;
  if (p === '*' || p === '*/*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  if (p.startsWith('.')) return hostname.endsWith(p);
  return hostname === p || hostname.endsWith(`.${p}`);
}

export function isProbablyUrl(text) {
  return /^(https?:\/\/|www\.)\S+$/i.test(String(text).trim());
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 简易日志开关 */
export function createLogger(scope, debugRef) {
  const prefix = `[dsh-translator:${scope}]`;
  return {
    debug: (...args) => {
      if (debugRef()) console.log(prefix, ...args);
    },
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args)
  };
}
