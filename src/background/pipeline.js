/**
 * 翻译流水线：缓存 → 分段切块 → provider 链（含降级）→ 写回缓存。
 *
 * 这里是唯一发网络请求的地方，content script 只负责采集与渲染。
 * 设计要点：
 *  - 严格保序：返回数组与入参 segments 一一对应，缺失位置为 null；
 *  - 单块失败不拖垮整页：块内失败降级为逐条，逐条也失败才留 null；
 *  - provider 链降级：链上第一个成功返回非空结果的引擎即被采用；
 *  - 相同分块请求会被 TaskQueue 按 key 去重，避免同页多帧重复计费。
 */

import { chunkBySize, createLogger, normalizeText } from '../shared/constants.js';
import { TranslationCache } from '../shared/cache.js';
import { TaskQueue, describeError } from '../shared/queue.js';
import { detectLanguage, isAlreadyTarget, isTranslatableText } from '../shared/lang.js';
import { getModule, getPreset, resolveChain } from '../providers/index.js';

export class TranslationPipeline {
  /**
   * @param {{settings: object, storage?: object, debug?: boolean}} options
   */
  constructor(options) {
    this.settings = options.settings;
    this.cache = new TranslationCache({ storage: options.storage, maxMemory: 4000 });
    this.cache.setEnabled(this.settings.enableCache !== false);
    this.queue = new TaskQueue({
      minIntervalMs: 45,
      maxConcurrent: Math.max(1, this.settings.concurrency || 3),
      retries: 2
    });
    this.log = createLogger('pipeline', () => Boolean(this.settings.debug));
    /** @type {{segments: number, requests: number, cacheHits: number, errors: number, lastError: string}} */
    this.stats = { segments: 0, requests: 0, cacheHits: 0, errors: 0, lastError: '' };
  }

  /** SW 启动时调用一次 */
  async warmup() {
    await this.cache.warmup();
  }

  applySettings(settings) {
    this.settings = settings;
    this.cache.setEnabled(settings.enableCache !== false);
    this.queue.setConcurrency(Math.max(1, settings.concurrency || 3));
    this.queue.setDebug(Boolean(settings.debug));
  }

  /**
   * 翻译一组分段。
   * @param {{segments: string[], targetLang?: string, sourceLang?: string, force?: boolean, requestId?: string}} request
   * @returns {Promise<{ok: boolean, translations: Array<string|null>, provider: string, skipped: number, errors: string[], fromCache: number, elapsedMs: number}>}
   */
  async translate(request) {
    const started = Date.now();
    const segments = Array.isArray(request.segments) ? request.segments : [];
    const targetLang = request.targetLang || this.settings.targetLang || 'zh-CN';
    const sourceLang = request.sourceLang || this.settings.sourceLang || 'auto';
    /** @type {Array<string|null>} */
    const translations = new Array(segments.length).fill(null);
    /** @type {string[]} */
    const errors = [];
    if (segments.length === 0) {
      return { ok: true, translations, provider: 'none', skipped: 0, errors, fromCache: 0, elapsedMs: 0 };
    }

    this.stats.segments += segments.length;

    /* ---------- 1. 缓存与"已经是目标语言"的短路 ---------- */
    /** @type {Array<number>} */
    const pending = [];
    let skipped = 0;
    let fromCache = 0;
    segments.forEach((segment, index) => {
      const text = typeof segment === 'string' ? segment : '';
      if (!text) {
        skipped += 1;
        return;
      }
      const cached = this.cache.get(text, targetLang);
      if (cached !== undefined) {
        translations[index] = cached;
        fromCache += 1;
        return;
      }
      if (!request.force) {
        if (!isTranslatableText(text, this.settings.minTextLength ?? 2)) {
          translations[index] = text; // 原样保留，避免页面出现空洞
          skipped += 1;
          return;
        }
        if (sourceLang === 'auto' && isAlreadyTarget(text, targetLang)) {
          translations[index] = text;
          skipped += 1;
          return;
        }
      }
      pending.push(index);
    });
    this.stats.cacheHits += fromCache;

    if (pending.length === 0) {
      return {
        ok: true,
        translations,
        provider: 'cache',
        skipped,
        errors,
        fromCache,
        elapsedMs: Date.now() - started
      };
    }

    /* ---------- 2. 切块：同一块内共享上下文，能显著提升连贯性 ---------- */
    const budget = Math.max(200, this.settings.batchMaxChars || 1200);
    const blocks = chunkBySize(pending, budget, (index) => normalizeText(segments[index]).length + 12);

    /* ---------- 3. provider 链 + 分块并发 ---------- */
    const chain = resolveChain(this.settings.provider || 'auto', this.settings.providerConfig || {}, this.settings.fallbackProviders || []);
    if (chain.length === 0) {
      const message = '没有可用的翻译引擎：请到设置页填写 DeepL/OpenAI Key，或确认 Ollama 已启动。';
      this.stats.errors += 1;
      this.stats.lastError = message;
      errors.push(message);
      return { ok: false, translations, provider: 'none', skipped, errors, fromCache, elapsedMs: Date.now() - started };
    }

    let usedProvider = '';
    /** 以"块"为最小调度单位：块内文本共享同一次请求，天然保住上下文 */
    let nextBlock = 0;
    const takeBlock = () => {
      if (nextBlock >= blocks.length) return null;
      const block = blocks[nextBlock];
      nextBlock += 1;
      return block;
    };

    const worker = async () => {
      for (;;) {
        const block = takeBlock();
        if (!block) return;
        const texts = block.map((index) => segments[index]);
        const outcome = await this.translateBlock(texts, { targetLang, sourceLang, chain });
        if (outcome.provider) usedProvider = outcome.provider;
        if (outcome.error) {
          errors.push(outcome.error);
          this.stats.errors += 1;
          this.stats.lastError = outcome.error;
        }
        outcome.results.forEach((value, k) => {
          const index = block[k];
          if (typeof value === 'string' && value.length > 0) {
            translations[index] = value;
            this.cache.set(segments[index], targetLang, value);
          }
        });
      }
    };

    const workerCount = Math.max(1, Math.min(this.settings.concurrency || 3, blocks.length));
    await Promise.all(Array.from({ length: workerCount }, worker));
    void this.cache.flush();

    const ok = translations.some((value) => typeof value === 'string' && value.length > 0);

    return {
      ok,
      translations,
      provider: usedProvider || chain[0] || 'unknown',
      skipped,
      errors: errors.slice(0, 3),
      fromCache,
      elapsedMs: Date.now() - started
    };
  }

  /**
   * 翻译一个块，按 provider 链依次尝试。
   * @param {string[]} texts
   * @param {{targetLang: string, sourceLang: string, chain: string[]}} ctx
   */
  async translateBlock(texts, ctx) {
    /** @type {string[]} */
    const errors = [];
    for (const providerId of ctx.chain) {
      const mod = getModule(providerId);
      const preset = getPreset(providerId);
      if (!mod || !preset) continue;
      const config = { ...(this.settings.providerConfig?.[providerId] ?? {}) };
      const key = `${providerId}:${texts.length}:${texts[0]?.slice(0, 24) ?? ''}`;
      try {
        this.stats.requests += 1;
        const results = await this.queue.push(key, () =>
          mod.translate({
            segments: texts,
            targetLang: ctx.targetLang,
            sourceLang: ctx.sourceLang,
            config,
            region: config.region,
            timeoutMs: preset.kind === 'local' ? 120000 : 30000
          })
        );
        const usable = Array.isArray(results) ? results : [];
        const filled = usable.filter((v) => typeof v === 'string' && v.length > 0).length;
        if (filled === 0) {
          errors.push(`[${providerId}] 返回空结果`);
          continue;
        }
        if (filled < texts.length) {
          errors.push(`[${providerId}] 部分分段未返回（${filled}/${texts.length}）`);
        }
        this.log.debug(`provider=${providerId} ok ${filled}/${texts.length}`);
        return { provider: providerId, results: usable, error: null };
      } catch (error) {
        const message = `[${providerId}] ${describeError(error)}`;
        errors.push(message);
        this.log.warn('provider 失败，尝试下一个', providerId, describeError(error));
      }
    }
    return { provider: '', results: texts.map(() => null), error: errors.join('；') || '全部引擎失败' };
  }

  /** 供设置页"测试连接"直接调用某个 provider */
  async testProvider(providerId, sample) {
    if (providerId === 'on-device') {
      // 端上引擎不在 SW 里运行（Translator.create() 需要用户手势），
      // 连通性测试由设置页自己在页面上下文里完成。
      return {
        ok: false,
        message: '内置翻译只能在网页/设置页里测试：请在设置页点击"检测本机内置翻译"按钮。'
      };
    }
    const mod = getModule(providerId);
    const preset = getPreset(providerId);
    if (!mod || !preset) return { ok: false, message: `未知引擎：${providerId}` };
    const config = { ...(this.settings.providerConfig?.[providerId] ?? {}) };
    if (typeof mod.selftest === 'function') {
      try {
        const result = await mod.selftest(config);
        return { ok: Boolean(result.ok), message: result.text || '（空结果）', ms: result.ms };
      } catch (error) {
        return { ok: false, message: describeError(error) };
      }
    }
    const text = sample || 'Hello, world.';
    try {
      const started = Date.now();
      const out = await mod.translate({
        segments: [text],
        targetLang: this.settings.targetLang || 'zh-CN',
        sourceLang: 'auto',
        config,
        region: config.region,
        timeoutMs: 20000
      });
      const value = Array.isArray(out) ? out[0] : out;
      return { ok: Boolean(value), message: value || '（空结果）', ms: Date.now() - started };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  /** 站点语言预判：给 content script 判断"这页要不要翻"用 */
  sniff(segments) {
    const sample = segments.filter(Boolean).slice(0, 12).join(' ');
    return detectLanguage(sample);
  }

  async flush() {
    await this.cache.flushNow();
  }
}

export default TranslationPipeline;
