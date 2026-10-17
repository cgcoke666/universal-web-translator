/**
 * 端上翻译调度器（content script 专用）。
 *
 * 职责：把"Chrome 内置 Translator API"接进已有的整页翻译流程，
 * 并保证任何失败都能干净地降级到 background 的远端引擎链。
 *
 * 为什么需要它，而不是直接改 background 的 pipeline：
 *  1. `Translator` 不存在于 MV3 service worker，pipeline 在那里根本调不到；
 *  2. `Translator.create()` 要求 transient activation，只有 content script
 *     能借到用户点击悬浮球/快捷键/右键菜单那一刻的手势；
 *  3. 端上引擎没有配额、没有网络，应该**先于**远端被尝试，但不应该
 *     因为一次失败就让整页翻译失败——降级必须是无感的。
 *
 * 因此分工是：
 *  content script → 端上引擎（本文件）→ 失败的分段原样交给 background → 远端引擎链
 */

import {
  ON_DEVICE_PROVIDER_ID,
  ensurePair,
  isSupported,
  probeAvailability,
  translate as translateOnDevice,
  resolveSourceLang
} from '../shared/onDevice.js';
import { createLogger, normalizeLangFor } from '../shared/constants.js';
import { isTranslatableText } from '../shared/lang.js';

export class OnDeviceTranslator {
  /**
   * @param {{debug?: () => boolean}} [options]
   */
  constructor(options = {}) {
    this.debugRef = options.debug ?? (() => false);
    this.log = createLogger('on-device-loader', () => Boolean(this.debugRef()));
    /** 设置开关（由 content/index.js 同步） */
    this.enabled = true;
    /**
     * 已经确认"该语言对在端上不可用、且不值得重试"的语言对。
     * 没有这道缓存，每一批都会重试一次必然失败的语言对，白白拖慢降级。
     * @type {Set<string>}
     */
    this.blockedPairs = new Set();
    /** @type {{supported: boolean, targetLang: string, sourceLang: string, status: string, error: string}} */
    this.lastProbe = { supported: false, targetLang: '', sourceLang: '', status: 'unknown', error: '' };
  }

  /** 宿主是否具备内置翻译能力（不触发下载） */
  get supported() {
    return isSupported();
  }

  applySettings(settings) {
    this.enabled = settings?.enableOnDevice !== false;
  }

  /**
   * 探测用的源语言候选：显式设置优先，否则依次试几个常见原文语言（不含目标语言本身）。
   *
   * 为什么要多个候选：内置翻译要求显式源语言，而页面打开时我们还没采到文本，
   * 无法检测语言。按命中率排序逐个探测，能让"离线就绪"这个状态尽可能准确。
   * @param {string|undefined} sourceLang
   * @param {string} targetLang
   * @returns {string[]}
   */
  probeSourceCandidates(sourceLang, targetLang) {
    const target = normalizeLangFor(ON_DEVICE_PROVIDER_ID, targetLang);
    /** @type {string[]} */
    const list = [];
    const push = (code) => {
      const normalized = normalizeLangFor(ON_DEVICE_PROVIDER_ID, code);
      if (!normalized || normalized === 'auto' || normalized === target || list.includes(normalized)) return;
      list.push(normalized);
    };
    if (sourceLang && sourceLang !== 'auto') push(sourceLang);
    else for (const code of ['en', 'ja', 'fr', 'de']) push(code);
    return list;
  }

  /**
   * 面板打开时用的轻量探测：只关心"能不能马上离线翻译"。
   * 不创建实例、不触发下载，命中 available 时会被缓存，因此可以放心调用。
   * @param {{targetLang: string, sourceLang?: string}} request
   * @returns {Promise<{supported: boolean, status: string, sourceLang: string, targetLang: string, error: string}>}
   */
  async probeForLaunch(request) {
    const targetLang = normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.targetLang);
    if (!this.enabled || !isSupported()) {
      return {
        supported: isSupported(),
        status: this.enabled ? 'unsupported' : 'disabled',
        sourceLang: '',
        targetLang,
        error: ''
      };
    }
    const candidates = this.probeSourceCandidates(request.sourceLang, request.targetLang);
    for (const sourceLang of candidates) {
      const status = await probeAvailability({ sourceLang, targetLang: request.targetLang });
      if (status === 'available' || status === 'downloadable' || status === 'downloading') {
        return { supported: true, status, sourceLang, targetLang, error: '' };
      }
    }
    return { supported: true, status: 'unavailable', sourceLang: '', targetLang, error: '' };
  }

  /** 目标语言切换后清空黑名单，否则换了语种会一直被跳过 */
  resetBlocklist() {
    this.blockedPairs.clear();
  }

  /**
   * 提前把某个语言对的 Translator 实例建好（含语言包下载）。
   *
   * 必须在用户手势刚发生、尚未 await 过慢操作时调用，否则 `create()` 会因
   * 缺少 transient activation 被拒。调用后 onProgress/onPhase 会通报下载进度。
   *
   * @param {string} targetLang
   * @param {string} sample 页面前若干条文本
   * @param {{onProgress?: (percent: number) => void, onPhase?: (phase: string) => void, sourceLang?: string}} [hooks]
   * @returns {Promise<boolean>} 是否已就绪；失败不抛错，交给 translateBatch 的统一降级
   */
  async prewarm(targetLang, sample, hooks = {}) {
    if (!this.enabled || !isSupported()) return false;
    const normalizedTarget = normalizeLangFor(ON_DEVICE_PROVIDER_ID, targetLang);
    const sourceLang = resolveSourceLang(hooks.sourceLang, normalizedTarget, sample);
    if (!sourceLang || normalizedTarget === 'auto') return false;
    const pairKey = `${sourceLang}>${normalizedTarget}`;
    if (this.blockedPairs.has(pairKey)) return false;
    try {
      await ensurePair({
        sourceLang,
        targetLang: normalizedTarget,
        onProgress: hooks.onProgress,
        onPhase: hooks.onPhase
      });
      return true;
    } catch (error) {
      const code = error?.code ?? 'unknown';
      if (code === 'unsupported' || code === 'unavailable' || code === 'not-allowed') {
        this.blockedPairs.add(pairKey);
      }
      this.log.debug('预热失败', pairKey, String(error?.message ?? error));
      return false;
    }
  }

  /**
   * 探测某个语言对当前能否走端上（供 UI 展示与翻译前预判）。
   *
   * 与 probeForLaunch 的区别：这里只探测**一个**语言对并原样回传状态，
   * 适合已知源语言的场景（例如设置页让用户显式指定源语言后检测）。
   * @param {{targetLang: string, sourceLang?: string}} request
   * @returns {Promise<{supported: boolean, status: string, sourceLang: string, targetLang: string, error: string}>}
   */
  async probe(request) {
    const targetLang = normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.targetLang);
    if (!this.enabled) {
      return { supported: isSupported(), status: 'disabled', sourceLang: request.sourceLang ?? '', targetLang, error: '' };
    }
    const status = await probeAvailability(request);
    const probe = {
      supported: isSupported(),
      status,
      sourceLang: request.sourceLang && request.sourceLang !== 'auto' ? request.sourceLang : 'auto',
      targetLang,
      error: ''
    };
    this.lastProbe = probe;
    return probe;
  }

  /**
   * 尝试用端上引擎翻译一批分段。
   *
   * 返回结构刻意设计成"部分成功"：
   *  - results 里非 null 的位置表示端上已经翻译好了；
   *  - remaining 是需要继续送给远端兜底的分段下标；
   *  - blocked 表示这个语言对本次会话里已被判定为不可用。
   *
   * @param {{segments: string[], targetLang: string, sourceLang?: string,
   *          onProgress?: (percent: number) => void,
   *          onPhase?: (phase: 'preparing'|'downloading'|'translating') => void}} request
   * @returns {Promise<{attempted: boolean, results: Array<string|null>, remaining: number[], provider: string, error: string, blocked: boolean}>}
   */
  async translateBatch(request) {
    const segments = Array.isArray(request.segments) ? request.segments : [];
    /** @type {Array<string|null>} */
    const results = new Array(segments.length).fill(null);
    const remaining = segments.map((_, index) => index);
    if (segments.length === 0) {
      return { attempted: false, results, remaining, provider: '', error: '', blocked: false };
    }
    if (!this.enabled) {
      return { attempted: false, results, remaining, provider: '', error: '', blocked: false };
    }
    if (!isSupported()) {
      return {
        attempted: false,
        results,
        remaining,
        provider: '',
        error: '',
        blocked: false
      };
    }

    // 只有语言检测能给出确定结论的分段才交给端上引擎：
    // 端上 API 不接受 auto，而把 URL/短标识符之类硬塞进去只会换来噪音。
    const targetLang = normalizeLangFor(ON_DEVICE_PROVIDER_ID, request.targetLang);
    const sample = segments.filter(Boolean).slice(0, 8).join(' ');
    const sourceLang = resolveSourceLang(request.sourceLang, targetLang, sample);
    const pairKey = `${sourceLang || 'auto'}>${targetLang}`;

    if (!sourceLang || targetLang === 'auto') {
      this.log.debug('端上引擎无法确定语言对，跳过', pairKey);
      return { attempted: false, results, remaining, provider: '', error: '', blocked: false };
    }
    if (this.blockedPairs.has(pairKey)) {
      return { attempted: false, results, remaining, provider: '', error: '', blocked: true };
    }

    const status = await probeAvailability({ sourceLang: request.sourceLang, targetLang: request.targetLang });
    this.lastProbe = { supported: true, targetLang, sourceLang, status, error: '' };
    if (status === 'unsupported') {
      return { attempted: false, results, remaining, provider: '', error: '', blocked: false };
    }
    if (status === 'unavailable') {
      // 该语言对在端上确实没有模型：记入黑名单，本会话不再尝试
      this.blockedPairs.add(pairKey);
      const error = `内置翻译不支持 ${sourceLang} → ${targetLang}`;
      this.log.debug('端上引擎语言对不可用', pairKey);
      return { attempted: false, results, remaining, provider: '', error, blocked: true };
    }

    // 只把"看起来值得翻译"的分段交给端上模型，其余直接留给远端/跳过
    const indices = remaining.filter((index) => isTranslatableText(segments[index], 1));
    if (indices.length === 0) {
      return { attempted: false, results, remaining, provider: '', error: '', blocked: false };
    }
    const texts = indices.map((index) => segments[index]);

    try {
      this.log.debug('end-on-device', pairKey, texts.length);
      const translated = await translateOnDevice({
        segments: texts,
        targetLang: request.targetLang,
        sourceLang: request.sourceLang,
        concurrency: 2,
        onProgress: request.onProgress,
        onPhase: request.onPhase
      });

      /** @type {number[]} */
      const left = [];
      translated.forEach((value, k) => {
        const index = indices[k];
        if (typeof value === 'string' && value.length > 0) results[index] = value;
        else left.push(index);
      });
      // 未被端上引擎覆盖的分段（含被 isTranslatableText 排除的）一律交给远端兜底
      const covered = new Set(indices);
      const leftSet = new Set(left);
      const stillRemaining = remaining.filter((index) => !covered.has(index) || leftSet.has(index));
      const error = left.length > 0 ? `内置翻译有 ${left.length} 段未返回` : '';
      return { attempted: true, results, remaining: stillRemaining, provider: ON_DEVICE_PROVIDER_ID, error, blocked: false };
    } catch (error) {
      const code = error?.code ?? 'unknown';
      const message = String(error?.message ?? error);
      this.lastProbe = { supported: true, targetLang, sourceLang, status: 'failed', error: message };
      // 永久性失败 → 拉黑该语言对，后续批次直接走远端，不再反复付失败成本
      if (code === 'unsupported' || code === 'unavailable' || code === 'not-allowed') {
        this.blockedPairs.add(pairKey);
        return { attempted: true, results, remaining, provider: '', error: message, blocked: true };
      }
      this.log.warn('端上翻译失败，降级远端', message);
      return { attempted: true, results, remaining, provider: '', error: message, blocked: false };
    }
  }
}

/** 供调试/埋点用：把探测结果翻译成一句人话 */
export function describeProbe(probe) {
  if (!probe) return '未知';
  if (!probe.supported) return '浏览器不支持内置翻译';
  if (probe.status === 'available') return `可用（${probe.sourceLang} → ${probe.targetLang}）`;
  if (probe.status === 'downloadable') return '需要先下载语言包';
  if (probe.status === 'downloading') return '语言包下载中';
  if (probe.status === 'unavailable') return `该语言对不可用（${probe.sourceLang} → ${probe.targetLang}）`;
  if (probe.status === 'failed') return `失败：${probe.error}`;
  if (probe.status === 'disabled') return '已在设置中关闭';
  return probe.status;
}
