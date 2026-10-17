/**
 * Chrome 内置 Translator API 适配器（端上 / 离线翻译）。
 *
 * 这是本扩展"零成本 + 隐私 + 轻量"路线的首选引擎：
 *  - 模型随 Chrome 分发，首次使用某个语言对时自动下载一个小语言包；
 *  - 推理完全在本机完成，文本不出设备，没有 API Key、没有服务端费用。
 *
 * ⚠️ 必须在**有用户手势的 DOM 上下文**里使用：
 *  `Translator.create()` 要求 transient activation（见 MDN），
 *  而 MV3 service worker 不仅没有 `Translator` 全局，也没有手势。
 *  因此本模块的实际宿主是 content script（点击悬浮球/快捷键/右键菜单那一刻
 *  天然带着手势），background 只负责把远端引擎作为兜底。
 *
 * 设计要点：
 *  1. **实例缓存**：一个 (source, target) 语言对对应一个 Translator 实例，
 *     创建一次反复使用，避免每次都重新加载模型；
 *  2. **同语言对串行**：同一个实例上的 translate 调用串行排队执行，
 *     防止并发调用把端上模型打爆（不同语言对之间是独立的）；
 *  3. **可回收**：destroyAll() 释放模型内存，用于"关闭端上翻译"时；
 *  4. **纯注入式宿主**：只读 globalThis.Translator，不碰 DOM，
 *     因此可以在 Node 里塞一个假的 Translator 做完整单测。
 */

import { createLogger } from './constants.js';
import { detectLanguage } from './lang.js';

/** 端上引擎在设置/统计里的标识 */
export const ON_DEVICE_PROVIDER_ID = 'on-device';

const log = createLogger('on-device', () => false);

/**
 * 类型化错误，便于上层决定"是彻底不支持"还是"只是这次失败"。
 *
 * code 取值：
 *  - 'unsupported'  当前环境没有该 API（非 Chrome / 版本过低）
 *  - 'unavailable'  该语言对在设备上不可用（没语言包且不能下载，或语种不支持）
 *  - 'downloadable' 语言包可按需下载（availability 探测结果，不是失败）
 *  - 'downloading'  语言包正在下载
 *  - 'not-allowed'  缺少用户手势 / 被策略或用户设置拦截
 *  - 'download-failed' 语言包下载失败（网络问题等）
 *  - 'same-language' 源语言与目标语言相同
 *  - 'aborted'      调用方主动取消
 *  - 'unknown'      其它
 */
export class OnDeviceError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, cause?: unknown, retryable?: boolean}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'OnDeviceError';
    this.code = info.code ?? 'unknown';
    this.retryable = info.retryable ?? false;
    if (info.cause) this.cause = info.cause;
  }
}

/** 永远不要重试的失败原因：重试只会浪费时间并拖慢降级 */
const PERMANENT_CODES = new Set(['unsupported', 'unavailable', 'not-allowed', 'same-language', 'aborted']);

/**
 * create()（含语言包下载）的上限。超时只影响本次调用，下载会在后台继续。
 * 60 秒足够下完几 MB 语言包，又不至于让用户对着"准备中"发呆太久。
 */
const CREATE_TIMEOUT_MS = 60_000;

/** @type {Map<string, {promise: Promise<any>, monitor: ((percent: number) => void) | null}>} */
const instancePromises = new Map();
/** @type {Map<string, Promise<unknown>>} */
const laneTails = new Map();
/** @type {Map<string, string>} */
const availabilityCache = new Map();

/** 测试与"关闭端上翻译"时用：清空全部缓存状态 */
export function resetCache() {
  instancePromises.clear();
  laneTails.clear();
  availabilityCache.clear();
}

/** 释放所有已创建的 Translator 实例（关闭端上引擎、或页面卸载时调用） */
export async function destroyAll() {
  const pending = [...instancePromises.values()];
  resetCache();
  await Promise.all(
    pending.map(async (entry) => {
      try {
        const translator = await entry.promise;
        await translator?.destroy?.();
      } catch {
        /* 创建本身就失败的实例，无可释放 */
      }
    })
  );
}

/** 当前宿主是否具备内置翻译能力（同步探测，零成本） */
export function isSupported() {
  const api = globalThis.Translator;
  return Boolean(api) && typeof api.create === 'function';
}

/**
 * 探测某个语言对在该设备上的可用状态。
 *
 * 依赖宿主确认 Chrome 的真实取值；无法确认时（含 Node 测试环境的假实现）
 * 一律视为 'available'，把最终判断交给 create() —— 这样"探测不认识的状态"
 * 不会误判成不可用，只是少一次优化。
 *
 * @param {{sourceLang?: string, targetLang: string}} request
 * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'|'unsupported'>}
 */
export async function probeAvailability(request) {
  if (!isSupported()) return 'unsupported';
  const targetLang = normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.targetLang);
  if (!targetLang || targetLang === 'auto') return 'unavailable';
  const sourceLang = resolveSourceLang(request.sourceLang, targetLang);
  if (!sourceLang) return 'unavailable';
  if (sourceLang === targetLang) return 'unavailable';

  const cacheKey = `${sourceLang}>${targetLang}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached) return /** @type {any} */ (cached);

  const api = globalThis.Translator;
  let status = 'available';
  if (typeof api.availability === 'function') {
    try {
      const raw = String(await api.availability({ sourceLanguage: sourceLang, targetLanguage: targetLang }));
      status = mapAvailability(raw);
    } catch (error) {
      // 语言对不被支持时会在这里抛错，这就是明确的"不可用"
      log.debug('availability 探测失败', cacheKey, describe(error));
      status = isNotSupportedError(error) ? 'unavailable' : 'available';
    }
  }
  // 只有确定为 available 才缓存：downloadable 可能在下载完成后变成 available
  if (status === 'available') availabilityCache.set(cacheKey, status);
  return /** @type {any} */ (status);
}

/** 该语言对是否可以直接开始翻译（无需下载） */
export async function isReady(request) {
  return (await probeAvailability(request)) === 'available';
}

/**
 * 翻译一组分段（端上）。
 *
 * @param {{segments: string[], targetLang: string, sourceLang?: string,
 *          timeoutMs?: number, concurrency?: number,
 *          onProgress?: (percent: number) => void,
 *          onPhase?: (phase: 'preparing'|'downloading'|'translating') => void}} request
 * @returns {Promise<Array<string|null>>}
 */
export async function translate(request) {
  const segments = Array.isArray(request.segments) ? request.segments.map((s) => (typeof s === 'string' ? s : '')) : [];
  if (segments.length === 0) return [];
  if (!isSupported()) {
    throw new OnDeviceError('当前浏览器不支持内置翻译（需要 Chrome 138+ 桌面版）', { code: 'unsupported' });
  }

  const targetLang = normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.targetLang);
  if (!targetLang || targetLang === 'auto') {
    throw new OnDeviceError(`内置翻译不支持目标语言：${request.targetLang}`, { code: 'unavailable' });
  }
  // 用户显式指定了源语言时直接比对，给出准确的 same-language；
  // 传 'auto' 时才需要靠语言检测推断。
  const explicitSource =
    request.sourceLang && request.sourceLang !== 'auto' ? normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.sourceLang) : '';
  if (explicitSource && explicitSource === targetLang) {
    throw new OnDeviceError('源语言与目标语言相同，无需翻译', { code: 'same-language' });
  }
  const sourceLang = resolveSourceLang(request.sourceLang, targetLang, segments.join(' '));
  if (!sourceLang) {
    throw new OnDeviceError('无法为内置翻译确定源语言', { code: 'unavailable' });
  }
  if (sourceLang === targetLang) {
    throw new OnDeviceError('源语言与目标语言相同，无需翻译', { code: 'same-language' });
  }

  request.onPhase?.('preparing');
  const translator = await withDeadline(
    getOrCreate({ sourceLang, targetLang, monitor: buildMonitor(request) }),
    request.createTimeoutMs ?? CREATE_TIMEOUT_MS,
    `${sourceLang} → ${targetLang}`
  );
  request.onPhase?.('translating');

  const limit = Math.max(1, Math.min(request.concurrency ?? 2, segments.length));
  /** @type {Array<string|null>} */
  const out = new Array(segments.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= segments.length) return;
      const text = segments[index];
      if (!text) continue;
      try {
        // 同一实例上串行调用：端上模型扛不住并发，且这样能保证输出顺序稳定
        const value = await runSerialized(`${sourceLang}>${targetLang}`, () => translator.translate(text));
        out[index] = typeof value === 'string' && value ? value : null;
      } catch (error) {
        // 单条失败不拖垮整批：上层会把 null 位置交给兜底引擎
        log.warn('单条端上翻译失败', describe(error));
        out[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

/**
 * 提前建好某个语言对的实例（含语言包下载）。
 * 与 translate() 共用同一份实例缓存，因此预热过的语言对后续调用是零成本。
 * @param {{sourceLang: string, targetLang: string,
 *          onProgress?: (percent: number) => void,
 *          onPhase?: (phase: string) => void}} request
 * @returns {Promise<boolean>}
 */
export async function ensurePair(request) {
  if (!isSupported()) {
    throw new OnDeviceError('当前浏览器不支持内置翻译（需要 Chrome 138+ 桌面版）', { code: 'unsupported' });
  }
  const targetLang = normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.targetLang);
  const sourceLang = normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.sourceLang);
  if (!targetLang || targetLang === 'auto' || !sourceLang || sourceLang === 'auto') {
    throw new OnDeviceError('语言对无法归一化', { code: 'unavailable' });
  }
  if (sourceLang === targetLang) {
    throw new OnDeviceError('源语言与目标语言相同', { code: 'same-language' });
  }
  request.onPhase?.('preparing');
  await withDeadline(
    getOrCreate({ sourceLang, targetLang, monitor: buildMonitor(request) }),
    request.createTimeoutMs ?? CREATE_TIMEOUT_MS,
    `${sourceLang} → ${targetLang}`
  );
  return true;
}

/**
 * 给"创建实例 / 下载语言包"加一个上限。
 *
 * 为什么必须有：网络受限时 Chrome 的模型下载可能长时间不给结果也不报错，
 * 没有上限的话整页翻译会一直卡在"准备中"，界面毫无反馈，用户只能刷新。
 * 超时只是让**这一次调用**失败并降级；底层 create() 仍在后台继续，
 * 一旦完成会被实例缓存复用，后续批次不必重新下载。
 *
 * ⚠️ 必须 clearTimeout 收尾：否则每调用一次都会留下一个挂起的长定时器
 * （本项目已经踩过这个坑，见 content/client.js 的 withTimeout）。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} pair 语言对，用于错误信息
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, pair) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new OnDeviceError(
            `语言包准备超时（${Math.round(ms / 1000)}s，${pair}）：网络受限时内置翻译的模型下载可能无法完成`,
            { code: 'download-failed', retryable: true }
          )
        ),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * 把语言包下载进度接到 request.onProgress 上。
 * create() 的 monitor 回调形如 (monitor) => { monitor.addEventListener('downloadprogress', ...) }
 * @param {{onProgress?: (percent: number) => void, onPhase?: (phase: string) => void}} request
 */
function buildMonitor(request) {
  if (typeof request.onProgress !== 'function') return null;
  return (monitor) => {
    try {
      request.onPhase?.('downloading');
      if (typeof monitor?.addEventListener !== 'function') return;
      monitor.addEventListener('downloadprogress', (event) => {
        const loaded = Number(event?.loaded ?? 0);
        const total = Number(event?.total ?? 0);
        // total 为 0 表示服务端没给长度，只能给个"进行中"的提示
        request.onProgress?.(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0);
      });
    } catch (error) {
      log.debug('monitor 挂载失败', describe(error));
    }
  };
}

/**
 * 取（或创建）某个语言对的 Translator 实例。
 * 同一语言对共享同一个实例，这是省内存、省语言包重复校验的关键。
 * @param {{sourceLang: string, targetLang: string, monitor: ((m: any) => void) | null}} key
 */
function getOrCreate({ sourceLang, targetLang, monitor }) {
  const cacheKey = `${sourceLang}>${targetLang}`;
  const existing = instancePromises.get(cacheKey);
  if (existing) return existing.promise;

  const promise = (async () => {
    try {
      const translator = await globalThis.Translator.create({
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
        ...(monitor ? { monitor } : {})
      });
      return translator;
    } catch (error) {
      throw classifyCreateError(error, cacheKey);
    }
  })();

  const entry = { promise, monitor };
  instancePromises.set(cacheKey, entry);
  // 创建失败就立刻从缓存移除，避免后续所有批次都复用一个已失败的 Promise
  promise.catch(() => {
    if (instancePromises.get(cacheKey) === entry) instancePromises.delete(cacheKey);
  });
  return promise;
}

/**
 * 按语言对串行执行，保证同一个 Translator 实例上不会出现并发 translate。
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function runSerialized(key, task) {
  const previous = laneTails.get(key) ?? Promise.resolve();
  const current = previous.then(task, task);
  laneTails.set(
    key,
    current.then(
      () => undefined,
      () => undefined
    )
  );
  return current;
}

/* ------------------------------------------------------------------ *
 * 语言码处理
 * ------------------------------------------------------------------ */

/** 英语回退：短文本（几个按钮词）的语言检测往往不可靠，误判成冷门语种
 *  会导致"语言包不支持"从而白白降级；回退英语的命中率高得多。 */
const SOURCE_FALLBACK = 'en';

/**
 * 为端上翻译确定源语言。
 * 内置 API 不接受 'auto'，必须给出具体语言码。
 * @param {string|undefined} sourceLang
 * @param {string} targetLang 已归一化的目标语言
 * @param {string} [sample]
 * @returns {string} 无法确定时返回 ''，由调用方判为不可用
 */
export function resolveSourceLang(sourceLang, targetLang, sample = '') {
  const explicit = sourceLang && sourceLang !== 'auto' ? normalizeLangFor(ON_DEVICE_PROVIDER_ID, sourceLang) : '';
  if (explicit && explicit !== 'auto') return explicit === targetLang ? '' : explicit;

  const detected = detectLanguage(sample);
  const code = detected?.code ? normalizeLangFor(ON_DEVICE_PROVIDER_ID, detected.code) : '';
  if (code && code !== 'auto') return code === targetLang ? '' : code;

  // 检测不出来时按英语处理（网页语料里英语占比最高，且是支持的语种）
  return targetLang === SOURCE_FALLBACK ? '' : SOURCE_FALLBACK;
}

/**
 * 各引擎语言码归一。端上引擎走 BCP-47，但 Chrome 用的是主语言标签 + Hant 变体：
 * 简中 = zh、繁中 = zh-Hant、葡萄牙语 = pt-BR，其余与扩展内部码一致。
 *
 * 该函数由 shared/constants.js 的 normalizeLangFor 调用（见那里的引用），
 * 独立放在这里是为了让 on-device 的语言知识只存在于一个文件里。
 * @param {string} code
 * @returns {string}
 */
export function normalizeOnDeviceLang(code) {
  const lower = String(code || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!lower) return 'auto';
  if (lower === 'auto') return 'auto';
  switch (lower) {
    case 'zh':
    case 'zh-cn':
    case 'zh-hans':
    case 'zh-sg':
    case 'zh-my':
      return 'zh';
    case 'zh-tw':
    case 'zh-hk':
    case 'zh-mo':
    case 'zh-hant':
      return 'zh-Hant';
    case 'pt':
    case 'pt-br':
    case 'pt-pt':
      return 'pt-BR';
    case 'iw':
      return 'he';
    case 'in':
      return 'id';
    default:
      break;
  }
  // 已经是合法 BCP-47（en / ja / sr-Latn 之类）就保持原样，只规范大小写
  return lower
    .split('-')
    .map((part, index) => (index === 0 ? part : part.length === 4 ? part[0].toUpperCase() + part.slice(1) : part.toUpperCase()))
    .join('-');
}

/**
 * Chrome 内置翻译支持的语言（37 种，桌面版）。
 * 用于设置页提示与"目标语言是否可能在端上可用"的预判。
 * @type {ReadonlyArray<{code: string, label: string}>}
 */
export const ON_DEVICE_LANGUAGES = Object.freeze([
  { code: 'zh', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English 英语' },
  { code: 'ja', label: '日本語 日语' },
  { code: 'ko', label: '한국어 韩语' },
  { code: 'fr', label: 'Français 法语' },
  { code: 'de', label: 'Deutsch 德语' },
  { code: 'es', label: 'Español 西班牙语' },
  { code: 'pt-BR', label: 'Português 葡萄牙语' },
  { code: 'it', label: 'Italiano 意大利语' },
  { code: 'ru', label: 'Русский 俄语' },
  { code: 'pl', label: 'Polski 波兰语' },
  { code: 'nl', label: 'Nederlands 荷兰语' },
  { code: 'tr', label: 'Türkçe 土耳其语' },
  { code: 'ar', label: 'العربية 阿拉伯语' },
  { code: 'hi', label: 'हिन्दी 印地语' },
  { code: 'th', label: 'ไทย 泰语' },
  { code: 'vi', label: 'Tiếng Việt 越南语' },
  { code: 'id', label: 'Bahasa Indonesia 印尼语' },
  { code: 'uk', label: 'Українська 乌克兰语' },
  { code: 'cs', label: 'Čeština 捷克语' },
  { code: 'da', label: 'Dansk 丹麦语' },
  { code: 'el', label: 'Ελληνικά 希腊语' },
  { code: 'fi', label: 'Suomi 芬兰语' },
  { code: 'he', label: 'עברית 希伯来语' },
  { code: 'hu', label: 'Magyar 匈牙利语' },
  { code: 'no', label: 'Norsk 挪威语' },
  { code: 'ro', label: 'Română 罗马尼亚语' },
  { code: 'sk', label: 'Slovenčina 斯洛伐克语' },
  { code: 'sv', label: 'Svenska 瑞典语' },
  { code: 'bg', label: 'Български 保加利亚语' },
  { code: 'bn', label: 'বাংলা 孟加拉语' },
  { code: 'ca', label: 'Català 加泰罗尼亚语' },
  { code: 'et', label: 'Eesti 爱沙尼亚语' },
  { code: 'hr', label: 'Hrvatski 克罗地亚语' },
  { code: 'lt', label: 'Lietuvių 立陶宛语' },
  { code: 'lv', label: 'Latviešu 拉脱维亚语' },
  { code: 'sl', label: 'Slovenščina 斯洛文尼亚语' }
]);

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

// 从 constants.js import normalizeLangFor 会形成循环依赖（constants 的 normalizeLangFor
// 需要 on-device 的语言知识，而本文件又依赖 constants 的日志工具），
// 因此这里复用本文件自带的 normalizeOnDeviceLang，两边规则保持同步。
function normalizeLangFor(_providerId, code) {
  return normalizeOnDeviceLang(code);
}

function mapAvailability(raw) {
  const value = String(raw || '').toLowerCase();
  if (value === 'available' || value === 'readily') return 'available';
  if (value === 'downloadable' || value === 'after-download') return 'downloadable';
  if (value === 'downloading') return 'downloading';
  if (value === 'unavailable' || value === 'no') return 'unavailable';
  return 'available';
}

/** create() 抛出的错误 → 带语义 code 的 OnDeviceError */
function classifyCreateError(error, cacheKey) {
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? error);
  const detail = `${cacheKey}: ${name || 'Error'} ${message}`.trim();
  if (name === 'NotAllowedError') {
    return new OnDeviceError(`内置翻译需要用户手势或被浏览器策略拦截（${detail}）`, { code: 'not-allowed', cause: error });
  }
  if (name === 'NotSupportedError') {
    return new OnDeviceError(`该语言对没有可用的内置翻译模型（${detail}）`, { code: 'unavailable', cause: error });
  }
  if (name === 'NetworkError') {
    return new OnDeviceError(`语言包下载失败，请检查网络（${detail}）`, { code: 'download-failed', retryable: true, cause: error });
  }
  if (name === 'AbortError') {
    return new OnDeviceError(`内置翻译已取消（${detail}）`, { code: 'aborted', cause: error });
  }
  if (name === 'InvalidStateError') {
    return new OnDeviceError(`页面未激活，无法创建内置翻译（${detail}）`, { code: 'not-allowed', cause: error });
  }
  return new OnDeviceError(`内置翻译初始化失败（${detail}）`, { code: 'unknown', retryable: true, cause: error });
}

function isNotSupportedError(error) {
  const name = String(error?.name ?? '');
  return name === 'NotSupportedError' || name === 'TypeError';
}

/** 该错误是否值得重试（网络抖动值得，语种不支持不值得） */
export function isRetryable(error) {
  const code = error?.code ?? '';
  if (PERMANENT_CODES.has(code)) return false;
  return Boolean(error?.retryable) || code === 'download-failed' || code === 'unknown';
}

function describe(error) {
  if (!error) return 'unknown';
  return `${error.name ?? 'Error'}: ${error.message ?? error}`;
}

export default {
  ON_DEVICE_PROVIDER_ID,
  isSupported,
  probeAvailability,
  isReady,
  ensurePair,
  translate,
  destroyAll,
  resetCache,
  resolveSourceLang,
  normalizeOnDeviceLang
};
