/**
 * Provider 注册表：设置页与流水线共用的唯一事实来源。
 *
 * 两种配置方式：
 *  - 独立 provider：一个 id 对应一个实现（Google 免费 / Edge 免费 / DeepL）
 *  - 预设 provider：共用同一实现，只是默认端点与模型不同（OpenAI / DeepSeek / Ollama / 自定义）
 *
 * 这样"引擎很多"不会带来代码重复，用户也能只填一个模型名就换来一个引擎。
 */

import * as googleFree from './googleFree.js';
import * as microsoft from './microsoft.js';
import * as deepl from './deepl.js';
import * as openaiCompat from './openaiCompat.js';

/**
 * @typedef {object} ProviderPreset
 * @property {string} id              设置里存储的 id
 * @property {string} label
 * @property {'free'|'key'|'local'|'on-device'} kind
 * @property {boolean} needsKey
 * @property {string} module         实现的 provider id
 * @property {string} description
 * @property {{endpoint?: string, model?: string}} defaults
 * @property {string} [docsUrl]
 */

/**
 * 端上引擎（Chrome 内置 Translator API）的特殊性：
 *  - kind 为 'on-device'，没有实现模块——它不在 service worker 里跑，
 *    而是由 content script 直接调用（见 content/onDeviceLoader.js），
 *    因为 Translator.create() 需要用户手势，SW 里连全局都没有；
 *  - 因此它**不进** AUTO_CHAIN（AUTO_CHAIN 是 background 的远端链），
 *    它的优先级由 content 侧的 OnDeviceTranslator 保证"永远排在最前"；
 *  - 出现在这里的目的：设置页能列出它、用户能选它、popup 能显示它。
 */
export const ON_DEVICE_PRESET_ID = 'on-device';

/** @type {ProviderPreset[]} */
export const PRESETS = [
  {
    id: ON_DEVICE_PRESET_ID,
    label: 'Chrome 内置翻译（端上 / 离线）',
    kind: 'on-device',
    needsKey: false,
    module: 'on-device',
    description:
      '完全免费、无需 Key、文本不出设备。需要 Chrome 138+ 桌面版；首次翻译某个语言时会自动下载小语言包（几 MB）。',
    defaults: {},
    docsUrl: 'https://developer.chrome.com/docs/ai/translator-api'
  },
  {
    id: 'microsoft',
    label: 'Microsoft / Edge 免费通道',
    kind: 'free',
    needsKey: false,
    module: 'microsoft',
    description: 'Edge 内置翻译同源服务，无需 Key，支持一次多段，稳定推荐。',
    defaults: {}
  },
  {
    id: 'google-free',
    label: 'Google 免费通道',
    kind: 'free',
    needsKey: false,
    module: 'google-free',
    description: '公开 web 端点，无需 Key，配额较紧，长文翻译可能触发限流。',
    defaults: {}
  },
  {
    id: 'deepl',
    label: 'DeepL API',
    kind: 'key',
    needsKey: true,
    module: 'deepl',
    description: '质量最好，需 API Key（免费版 Key 以 :fx 结尾，每月 50 万字符）。',
    defaults: { endpoint: 'https://api-free.deepl.com' },
    docsUrl: 'https://www.deepl.com/pro-api'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'key',
    needsKey: true,
    module: 'openai-compat',
    description: 'gpt-4o-mini 性价比高，长段落语境最好。',
    defaults: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'key',
    needsKey: true,
    module: 'openai-compat',
    description: 'deepseek-chat，中文语境佳、价格低。',
    defaults: { endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    docsUrl: 'https://platform.deepseek.com'
  },
  {
    id: 'ollama',
    label: 'Ollama / LM Studio（本地）',
    kind: 'local',
    needsKey: false,
    module: 'openai-compat',
    description: '本机推理，数据不出内网。需要先 ollama pull 一个模型。',
    defaults: { endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen2.5:7b' },
    docsUrl: 'https://ollama.com'
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容网关',
    kind: 'key',
    needsKey: false,
    module: 'openai-compat',
    description: 'one-api / new-api / vLLM / 任意兼容 /v1/chat/completions 的服务。',
    defaults: { endpoint: '', model: '' }
  }
];

/** 实现模块表 */
const MODULES = {
  'google-free': googleFree,
  microsoft,
  deepl,
  'openai-compat': openaiCompat
};

/** 'auto' 的尝试顺序：免费通道优先，够快且零配置。
 *  注意这里只列**远端**引擎：端上引擎（on-device）在 content script 里
 *  先于整条远端链执行，不可能也不需要在 service worker 的 pipeline 里出现。 */
export const AUTO_CHAIN = ['microsoft', 'google-free'];

/** 端上引擎的标识与判定（供 content 侧与设置页共用） */
export function isOnDeviceProvider(providerId) {
  return providerId === ON_DEVICE_PRESET_ID;
}

/** @type {Map<string, ProviderPreset>} */
const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

/** 取某个 id 的实现模块（'auto' 需要上层展开成具体链） */
export function getModule(providerId) {
  const preset = PRESET_BY_ID.get(providerId);
  if (!preset) return null;
  return MODULES[preset.module] ?? null;
}

export function getPreset(providerId) {
  return PRESET_BY_ID.get(providerId) ?? null;
}

export function isKnownProvider(providerId) {
  return providerId === 'auto' || PRESET_BY_ID.has(providerId);
}

/** 该 provider 是否已具备可运行配置 */
export function isConfigured(providerId, providerConfig = {}) {
  const preset = getPreset(providerId);
  if (!preset) return false;
  if (!preset.needsKey) return true;
  const cfg = providerConfig[providerId] ?? {};
  if (preset.module === 'openai-compat') return Boolean((cfg.model || '').trim()) && Boolean((cfg.endpoint || '').trim());
  return Boolean((cfg.apiKey || '').trim());
}

/**
 * 把 'auto' 展开成具体尝试顺序：
 * 用户自定义的 fallback 链 → 默认链，过滤掉不可用的。
 * @param {string} providerId
 * @param {Record<string, object>} providerConfig
 * @param {string[]} fallbackChain
 */
export function resolveChain(providerId, providerConfig = {}, fallbackChain = []) {
  // 端上引擎不参与远端链：它由 content script 直接执行（见 onDeviceLoader.js）。
  // 用户显式选了它时，这里返回的就是纯远端兜底链。
  const remoteFallbacks = fallbackChain.filter((id) => id !== providerId && id !== ON_DEVICE_PRESET_ID && id !== 'auto');
  if (providerId !== 'auto' && providerId !== ON_DEVICE_PRESET_ID) {
    const chain = [providerId];
    for (const id of remoteFallbacks) {
      if (isKnownProvider(id)) chain.push(id);
    }
    return chain.filter((id) => isConfigured(id, providerConfig));
  }
  const chain = [];
  for (const id of [...remoteFallbacks, ...AUTO_CHAIN]) {
    if (isKnownProvider(id) && id !== 'auto' && isConfigured(id, providerConfig) && !chain.includes(id)) chain.push(id);
  }
  return chain;
}

/** 供设置页展示的实现信息（端点等） */
export function listProviders() {
  return PRESETS.map((preset) => {
    const mod = MODULES[preset.module];
    return {
      ...preset,
      /** 端上引擎没有远端实现模块，UI 需要据此调整文案与状态展示 */
      remote: Boolean(mod),
      moduleEndpoints: mod?.meta?.endpoints ?? [],
      note: mod?.meta?.note ?? ''
    };
  });
}

export { googleFree, microsoft, deepl, openaiCompat };
