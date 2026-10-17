/**
 * content script 入口：把采集 / 分段 / 翻译 / 渲染 / 观察串成一条流水线，
 * 并实现"整页翻译 / 还原 / 双语对照切换 / 划词翻译"四种交互。
 *
 * 本文件被打包成单文件经典脚本注入到每个 frame（manifest 里 all_frames: true），
 * 但它会主动避开 iframe 重复工作：只有顶层 frame 处理整页翻译，
 * 子 frame 仅在被父页显式要求时工作，避免同一篇文章被翻两遍。
 */

import { CMD, MSG, STORAGE_KEYS, createLogger, hostnameOf, mergeSettings, uniqCompact } from '../shared/constants.js';
import { COMMON_NOISE_SELECTORS } from '../shared/constants.js';
import { IS_TOP_FRAME, injectStyles, shouldHandleFrame } from './env.js';
import { DomCollector } from './collector.js';
import { segmentRecords, assembleTranslated } from './segmenter.js';
import { TranslationRenderer } from './renderer.js';
import { DomObserver } from './observer.js';
import { TranslationClient } from './client.js';
import { PageCache } from './cache.js';
import { TranslatorUi } from './ui.js';
import { OnDeviceTranslator, describeProbe } from './onDeviceLoader.js';
import { isSupported as onDeviceSupported } from '../shared/onDevice.js';
import { translateWithFallback } from './translateFlow.js';
import { resolveChain } from '../providers/index.js';

/* ------------------------------------------------------------------ *
 * 单例保护：SPA 反复注入或扩展重新加载时不要出现两套流水线
 * ------------------------------------------------------------------ */

if (globalThis.__DSH_TRANSLATOR_LOADED__) {
  // 已加载过，直接退出（热重载场景）
} else {
  globalThis.__DSH_TRANSLATOR_LOADED__ = true;
  main();
}

function main() {
  /** @type {ReturnType<typeof mergeSettings>} */
  let settings = mergeSettings(null);
  const pageHost = (() => {
    try {
      return hostnameOf(location.href);
    } catch {
      return '';
    }
  })();

  const log = createLogger('content', () => settings.debug);
  const pageCache = new PageCache();
  const client = new TranslationClient();
  /** Chrome 内置 Translator API 的宿主适配器（端上翻译，零成本） */
  const onDevice = new OnDeviceTranslator({ debug: () => settings.debug });
  /** 上一次同步给端上引擎的目标语言，用于判断是否需要清空"不可用语言对"黑名单 */
  let lastOnDeviceTarget = '';
  /**
   * 端上引擎的最近一次探测结果，供悬浮球/面板显示"离线就绪 / 需下载语言包"。
   * @type {{supported: boolean, status: string, sourceLang: string, targetLang: string, error: string} | null}
   */
  let onDeviceStatus = null;
  /** 远端兜底链是否可用（进页面时算一次，设置变更后重算），供面板区分"远端就绪/不可用" */
  let remoteFallbackOk = true;
  /** 正在进行的语言包准备 Promise，避免重复触发下载 */
  /** @type {Promise<boolean> | null} */
  let packPromise = null;
  /** 最近一次采集到的文本样本，供"提前下载语言包"推断源语言 */
  let lastCollectedSample = '';
  /** 上次向子 frame 广播命令的时间，用于防抖 */
  let lastRelayAt = 0;

  /** 当前页面状态 */
  const state = {
    translated: false,
    translating: false,
    /** @type {Map<number, {record: object, pieces: object[], translated: Map<number, string>}>} */
    pending: new Map(),
    /** @type {Map<number, object>} */
    records: new Map(),
    /** @type {Array<string>} */
    errors: [],
    stats: { records: 0, pieces: 0, translated: 0, fromCache: 0, provider: '', elapsedMs: 0 }
  };

  /* ---------------------------------------------------------------- *
   * UI 与观察器
   * ---------------------------------------------------------------- */

  const ui = new TranslatorUi({
    onTranslate: () => void translatePage(),
    onRestore: () => restorePage(),
    /**
     * 一键准备语言包。必须**同步**创建 create() 调用（本函数体内第一件事就是
     * 调用 onDevice.prewarm），否则会错过点击带来的 transient activation。
     * @param {{thenTranslate?: boolean}} [options]
     */
    onDownload: (options) => {
      const thenTranslate = Boolean(options?.thenTranslate);
      const promise = prepareOnDevicePack();
      if (thenTranslate) {
        void promise.then((ready) => {
          if (ready) void translatePage();
          else ui.setNotice('语言包准备失败，已改用远端通道');
        });
      }
      return promise;
    },
    onToggleMode: () => {
      const next = settings.displayMode === 'bilingual' ? 'replace' : 'bilingual';
      void saveSettings({ displayMode: next });
      applyDisplayMode();
    },
    onOpenSettings: () => client.openOptionsPage(),
    onPanelOpen: () => refreshOnDeviceStatus(),
    onPreview: (text) => void previewSelection(text),
    onTargetLang: (lang) => {
      if (lang) void saveSettings({ targetLang: lang });
    },
    getState: () => ({
      translated: state.translated,
      translating: state.translating,
      displayMode: settings.displayMode,
      targetLang: settings.targetLang,
      stats: state.stats,
      errors: state.errors,
      // 供 launchState.js 推导"离线就绪 / 需下载 / 远端通道"
      enableOnDevice: settings.enableOnDevice !== false,
      remoteFallback: remoteFallbackOk
    })
  });

  const collector = new DomCollector(collectorConfig());
  collector.setDebug(() => settings.debug);

  const observer = new DomObserver({
    onDirty: () => {
      if (!state.translated || !settings.followDynamicContent) return;
      void translatePage({ incremental: true });
    },
    enabled: () => settings.followDynamicContent && state.translated,
    debounceMs: settings.mutationDebounceMs,
    onNavigate: () => {
      // SPA 换页：旧译文节点已经随 DOM 被移除，这里重置状态并按站点策略决定是否继续翻译
      if (state.translated) {
        state.translated = false;
        state.pending.clear();
        state.records.clear();
        collector.reset();
        if (siteDecision() !== 'never' && settings.autoTranslateOnLoad) {
          setTimeout(() => void translatePage(), 350);
        } else {
          ui.setStatus('页面已切换，点击翻译');
        }
      }
    },
    debug: () => settings.debug
  });

  const renderer = new TranslationRenderer({
    displayMode: settings.displayMode,
    color: settings.bilingualColor,
    fontScale: settings.bilingualFontScale,
    markdown: settings.markdownRendering,
    originalTooltip: settings.originalTooltip,
    showFlag: true
  });

  function collectorConfig() {
    return {
      skipSelectors: uniqCompact(settings.skipSelectors || []),
      onlySelectors: uniqCompact(settings.onlySelectors || []),
      noiseSelectors: [...COMMON_NOISE_SELECTORS],
      skipNoise: settings.skipNoise,
      minTextLength: settings.minTextLength,
      maxNodeLength: settings.maxNodeLength,
      translatePlaceholder: settings.translatePlaceholder,
      translateAriaLabel: settings.translateAriaLabel,
      translateImageAlt: settings.translateImageAlt,
      translateTitle: settings.translateTitle,
      translateShadowDom: settings.translateShadowDom,
      maxNodes: IS_TOP_FRAME ? 4000 : 1500
    };
  }

  function applyConfig() {
    Object.assign(collector.config, collectorConfig());
    renderer.setOptions({
      displayMode: settings.displayMode,
      color: settings.bilingualColor,
      fontScale: settings.bilingualFontScale,
      markdown: settings.markdownRendering,
      originalTooltip: settings.originalTooltip
    });
    observer.debounceMs = settings.mutationDebounceMs;
    onDevice.applySettings(settings);
    if (lastOnDeviceTarget && lastOnDeviceTarget !== settings.targetLang) {
      // 目标语言变了：上一轮判定"端上不支持"的结论不再适用
      onDevice.resetBlocklist();
      onDeviceStatus = null;
    }
    lastOnDeviceTarget = settings.targetLang;
    remoteFallbackOk = remoteFallbackAvailable();
    applyDisplayMode();
    // 目标语言/引擎设置可能变了，"离线就绪"之类的状态要跟着刷新
    void refreshOnDeviceStatus();
  }

  /**
   * 远端兜底链是否可用（仅用于 UI 展示"远端就绪 / 不可用"）。
   * 注意它**不再决定要不要尝试端上引擎**：远端全挂时端上才是唯一出路。
   */
  function remoteFallbackAvailable() {
    const chain = resolveChain(settings.provider || 'auto', settings.providerConfig || {}, settings.fallbackProviders || []);
    return chain.filter((id) => id !== 'on-device').length > 0;
  }

  /**
   * 端上引擎是否值得尝试。
   *
   * 关键在于**不要求**"有远端兜底"：反过来才对——远端全挂时，
   * 内置翻译正是唯一还能用的引擎。之前要求远端可用，导致远端失效时
   * 连端上都不试、直接报错（截图里的现象）。
   */
  function onDeviceEnabled() {
    return settings.enableOnDevice !== false && onDeviceSupported();
  }

  /**
   * 统一的翻译入口：端上优先，没翻好的分段交给 background 的远端链。
   * 整页翻译与划词翻译都走这里，避免两条路径行为不一致。
   * @param {string[]} texts
   * @param {{force?: boolean, onProgress?: (percent: number) => void, onPhase?: (phase: string) => void}} [options]
   */
  function translateTexts(texts, options = {}) {
    return translateWithFallback({
      segments: texts,
      targetLang: effectiveTargetLang(),
      sourceLang: settings.sourceLang,
      force: options.force,
      onDeviceEnabled: onDeviceEnabled(),
      onDevice: onDeviceEnabled() ? onDevice : null,
      client,
      onProgress: options.onProgress,
      onPhase: options.onPhase
    });
  }

  /**
   * 刷新端上状态用于 UI 展示（不下载、不创建实例，只读 availability）。
   * 命中 available 时共享层会缓存结果，所以打开面板时调用它几乎没有开销。
   */
  async function refreshOnDeviceStatus() {
    remoteFallbackOk = remoteFallbackAvailable();
    if (settings.enableOnDevice === false || !onDeviceSupported()) {
      onDeviceStatus = {
        supported: onDeviceSupported(),
        status: settings.enableOnDevice === false ? 'disabled' : 'unsupported',
        sourceLang: '',
        targetLang: settings.targetLang,
        error: ''
      };
      ui.setProbe(onDeviceStatus);
      return;
    }
    try {
      onDeviceStatus = await onDevice.probeForLaunch({
        targetLang: effectiveTargetLang(),
        sourceLang: settings.sourceLang
      });
    } catch (error) {
      onDeviceStatus = {
        supported: true,
        status: 'failed',
        sourceLang: '',
        targetLang: settings.targetLang,
        error: String(error?.message ?? error)
      };
    }
    ui.setProbe(onDeviceStatus);
  }

  /**
   * 准备（下载）语言包。
   *
   * ⚠️ 关键：`onDevice.prewarm(...)` 必须在**本函数的同步部分**调用。
   * 它内部立即执行 `Translator.create()`，从而借用调用方（一次真实点击）
   * 的 transient activation；任何先 await 的写法都会让浏览器以 NotAllowedError 拒绝。
   * @returns {Promise<boolean>} 语言包是否已就绪
   */
  function prepareOnDevicePack() {
    if (settings.enableOnDevice === false) {
      ui.setNotice('内置翻译已在设置中关闭');
      return Promise.resolve(false);
    }
    if (!onDeviceSupported()) {
      ui.setNotice('当前浏览器不支持内置翻译（需 Chrome 138+ 桌面版）');
      return Promise.resolve(false);
    }
    if (packPromise) return packPromise;

    const sample = lastCollectedSample;
    ui.setDownloadProgress(null);
    // 同步发起：这一行必须留在第一个 await 之前
    const promise = onDevice.prewarm(effectiveTargetLang(), sample, {
      sourceLang: settings.sourceLang,
      onProgress: (percent) => {
        ui.setDownloadProgress(percent);
      }
    });
    packPromise = promise
      .then((ready) => {
        ui.setNotice(ready ? '语言包已就绪，现在可以离线翻译' : '语言包准备失败，已改用远端通道');
        return ready;
      })
      .catch(() => {
        ui.setNotice('语言包准备失败，已改用远端通道');
        return false;
      })
      .finally(() => {
        packPromise = null;
        ui.setDownloadProgress(null);
        void refreshOnDeviceStatus();
      });
    // 面板立即进入"下载中"观感，而不是等第一个进度事件
    ui.setProbe({ supported: true, status: 'downloading', sourceLang: '', targetLang: settings.targetLang, error: '' });
    return packPromise;
  }

  /**
   * 在用户手势还"新鲜"的时候就把语言包准备好。
   *
   * 这是整个端上路径最关键的一步：`Translator.create()` 要求 transient activation，
   * 而 collect() + 逐条查缓存会把几百毫秒的手势窗口耗光。所以采集一结束
   * （此时还没有任何 await）就立刻发起创建，后续所有批次复用的是同一个实例。
   *
   * 只等一小会儿：首次使用要下载语言包（可能几秒到几十秒），不应该让整页
   * 翻译干等。超时后立即转入后面的流程，下载在后台继续；用户的批次会沿用
   * 这个实例，等它就绪后继续翻译。
   *
   * @param {string} targetLang
   * @param {string} sample 页面前若干条文本，用于推断源语言
   */
  async function prewarmOnDevice(targetLang, sample) {
    if (!onDeviceEnabled()) return;
    const ready = onDevice.prewarm(targetLang, sample, {
      sourceLang: settings.sourceLang,
      onProgress: (percent) => {
        ui.setDownloadProgress(percent);
        ui.setStatus(percent > 0 ? `正在下载语言包 ${percent}%` : '正在下载语言包…');
      }
    });
    // 让 create() 在本次任务里先真正发起，再给下载留出最多 2.5s 的等待
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 2500))]);
    ui.setDownloadProgress(null);
    void refreshOnDeviceStatus();
  }

  /* ---------------------------------------------------------------- *
   * 站点策略
   * ---------------------------------------------------------------- */

  function siteDecision() {
    const mode = settings.siteMode?.[pageHost];
    if (mode === 'never') return 'never';
    if (mode === 'always') return 'always';
    return 'auto';
  }

  function effectiveTargetLang() {
    return settings.siteTargetLang?.[pageHost] || settings.targetLang;
  }

  /* ---------------------------------------------------------------- *
   * 主流程：整页翻译
   * ---------------------------------------------------------------- */

  async function translatePage(options = {}) {
    if (state.translating) return;
    // 主按钮在"已翻译"时显示为还原：这里保持与 popup 一致的行为，
    // 由本函数统一裁决，UI 不需要自己判断该翻译还是该还原。
    if (state.translated && !options.incremental) {
      restorePage();
      return;
    }
    if (siteDecision() === 'never') {
      ui.setStatus('该站点已设为不翻译');
      return;
    }
    state.translating = true;
    state.errors = [];
    ui.clearStatus();
    const startedAt = Date.now();
    ui.setBusy(true);

    try {
      const roots = options.incremental ? observer.takeDirtyRoots() : [document];
      const records = [];
      for (const root of roots) {
        if (!root || (root.nodeType === 1 && !root.isConnected)) continue;
        try {
          records.push(...collector.collect(root, { limit: options.incremental ? 1200 : undefined }));
        } catch (error) {
          log.warn('采集失败，跳过该子树', error);
        }
      }
      if (records.length === 0) {
        if (!state.translated) ui.setStatus('未找到可翻译的文本');
        state.translating = false;
        ui.setBusy(false);
        return;
      }

      // 记录表：recordId -> record
      const recordById = new Map();
      for (const record of records) {
        recordById.set(record.id, record);
        state.records.set(record.id, record);
      }

      const pieces = segmentRecords(
        records.map((record) => ({ recordId: record.id, text: record.text, target: record.target })),
        {
          minTextLength: settings.minTextLength,
          batchMaxChars: settings.batchMaxChars
        }
      );
      state.stats.records = state.records.size;
      state.stats.pieces = pieces.length;
      ui.setProgress(0, pieces.length);
      // 留一份样本：用户稍后点"提前下载语言包"时用它推断源语言
      lastCollectedSample = pieces
        .slice(0, 8)
        .map((piece) => piece.text)
        .join(' ');

      // ⚠️ 关键时机：此刻尚未 await 过任何慢操作，用户手势（点击悬浮球/快捷键/
      // 右键菜单）仍然"新鲜"。内置 Translator API 的 create() 需要 transient
      // activation，所以必须在这里就把语言包/实例准备好；后面逐条查缓存会
      // 轻易耗光这个窗口。失败无所谓，远端链会兜底。
      await prewarmOnDevice(effectiveTargetLang(), lastCollectedSample);
      // 先查本地缓存（跨会话），命中就不进入请求队列
      /** @type {Array<{index: number, text: string}>} */
      const toTranslate = [];
      /** @type {Map<string, string>} */
      const localHits = new Map();
      for (let i = 0; i < pieces.length; i += 1) {
        const piece = pieces[i];
        const cached = settings.enableCache ? await pageCache.get(piece.text, effectiveTargetLang()) : null;
        if (cached) {
          localHits.set(pieceKey(piece), cached);
          state.stats.fromCache += 1;
        } else {
          toTranslate.push({ index: i, text: piece.text });
        }
      }

      // 分组：同一采集记录的多个分段要一起渲染，因此按 recordId 聚合
      /** @type {Map<number, Array<{piece: object, text: string}>>} */
      const perRecord = new Map();
      for (let i = 0; i < pieces.length; i += 1) {
        const piece = pieces[i];
        const hit = localHits.get(pieceKey(piece));
        if (!hit) continue;
        pushPerRecord(perRecord, piece, hit);
      }

      let done = pieces.length - toTranslate.length;
      const batches = chunkRequests(toTranslate, settings.batchMaxChars, 1200 * 8);
      for (const batch of batches) {
        const texts = batch.map((item) => item.text);
        // 端上优先 + 远端兜底，全部由 translateWithFallback 统一裁决，
        // 与划词翻译共用同一条策略，避免两条路径行为不一致。
        const outcome = await translateTexts(texts, {
          onProgress: (percent) => {
            ui.setStatus(percent > 0 ? `正在下载语言包 ${percent}%` : '正在下载语言包…');
          },
          onPhase: (phase) => {
            if (phase === 'preparing') ui.setStatus('内置翻译（离线）准备中…');
            if (phase === 'translating') ui.setStatus('内置翻译中…');
          }
        });
        const translations = outcome.translations;
        if (outcome.provider) state.stats.provider = outcome.provider;
        if (outcome.errors.length > 0) {
          state.errors.push(...outcome.errors);
          log.warn('批次提示', outcome.errors.join('；'));
        }

        translations.forEach((translated, k) => {
          const item = batch[k];
          if (!item || typeof translated !== 'string' || !translated) return;
          const piece = pieces[item.index];
          if (settings.enableCache) void pageCache.set(piece.text, effectiveTargetLang(), translated);
          pushPerRecord(perRecord, piece, translated);
          done += 1;
        });
        ui.setProgress(done, pieces.length);
      }

      // 渲染：按记录聚合，全部分段都有译文才用完整译文替换该节点
      /** @type {Map<number, object[]>} */
      const piecesByRecord = new Map();
      for (const piece of pieces) {
        const list = piecesByRecord.get(piece.recordId);
        if (list) list.push(piece);
        else piecesByRecord.set(piece.recordId, [piece]);
      }

      for (const [recordId, entry] of perRecord) {
        const record = recordById.get(recordId) ?? state.records.get(recordId);
        if (!record) continue;
        const piecesOfRecord = piecesByRecord.get(recordId) ?? [];
        const allCovered = piecesOfRecord.every((piece) => entry.pieces.has(pieceKey(piece)));
        const translated = allCovered
          ? assembleTranslated(record.text, piecesOfRecord.map((piece) => ({
              start: piece.start,
              end: piece.end,
              text: entry.pieces.get(pieceKey(piece)) ?? ''
            })))
          : joinTranslated(piecesOfRecord, entry.pieces);
        renderer.renderRecord({
          doc: document,
          record,
          translated,
          partial: !allCovered
        });
        state.stats.translated += 1;
      }

      state.translated = true;
      applyDisplayMode();
      state.stats.elapsedMs = Date.now() - startedAt;
      const failed = pieces.length - state.stats.translated;
      ui.setStatus(
        state.errors.length > 0
          ? `已翻译，${state.errors.length} 处失败：${state.errors[0]}`
          : `完成：${state.stats.translated} 段 · ${state.stats.provider} · ${state.stats.elapsedMs}ms`
      );
      if (failed > 0) log.debug(`${failed} 个分段未能翻译`);
      if (!settings.followDynamicContent) observer.stop();
      else observer.start();
      if (!options.incremental) relayToChildFrames(CMD.TRANSLATE_PAGE);
    } catch (error) {
      log.error('整页翻译失败', error);
      state.errors.push(String(error?.message ?? error));
      ui.setStatus(`翻译失败：${String(error?.message ?? error)}`);
    } finally {
      state.translating = false;
      ui.setBusy(false);
      ui.refresh();
    }
  }

  function pushPerRecord(map, piece, translated) {
    let entry = map.get(piece.recordId);
    if (!entry) {
      entry = { pieces: new Map() };
      map.set(piece.recordId, entry);
    }
    entry.pieces.set(pieceKey(piece), translated);
  }

  function pieceKey(piece) {
    return `${piece.recordId}:${piece.start}-${piece.end}`;
  }

  function joinTranslated(piecesOfRecord, hits) {
    return piecesOfRecord
      .map((piece) => hits.get(pieceKey(piece)))
      .filter(Boolean)
      .join(' ');
  }

  /** 把待翻译项按总字符预算切成若干请求批 */
  function chunkRequests(items, perRequestBudget, totalBudget) {
    const batches = [];
    let current = [];
    let used = 0;
    let total = 0;
    for (const item of items) {
      const size = item.text.length + 12;
      if (current.length > 0 && (used + size > perRequestBudget * 4 || total + size > totalBudget)) {
        batches.push(current);
        current = [];
        used = 0;
      }
      current.push(item);
      used += size;
      total += size;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  /* ---------------------------------------------------------------- *
   * 还原
   * ---------------------------------------------------------------- */

  function restorePage() {
    renderer.clear();
    // 还原属性文本
    for (const record of state.records.values()) {
      const target = record.target;
      if (target?.kind !== 'attr') continue;
      const el = target.element;
      const attr = target.attr;
      if (!el || !attr || !el.isConnected) continue;
      const original = el.getAttribute(`data-dsh-attr-orig-${attr}`);
      if (original !== null) el.setAttribute(attr, original);
      el.removeAttribute(`data-dsh-attr-orig-${attr}`);
      el.removeAttribute(`data-dsh-attr-${attr}`);
    }
    // 还原仅译文模式下的隐藏标记
    for (const el of document.querySelectorAll('[data-dsh-orig]')) el.removeAttribute('data-dsh-orig');
    collector.reset();
    state.records.clear();
    state.pending.clear();
    state.translated = false;
    state.stats = { records: 0, pieces: 0, translated: 0, fromCache: 0, provider: '', elapsedMs: 0 };
    document.documentElement.classList.remove('dsh-mode-replace', 'dsh-translating');
    observer.stop();
    ui.setStatus('已还原原文');
    ui.refresh();
    relayToChildFrames(CMD.RESTORE_PAGE);
  }

  /**
   * 让同标签页的子 frame 一起翻译/还原。
   *
   * content script 之间不能直接通信，也无法跨域操作 iframe 的 DOM，
   * 所以由顶层 frame 通过 background 广播命令，每个 frame 各自处理自己的 document。
   * 这样既覆盖了内嵌正文（新闻站、论坛、文档站很常见），又不会让子 frame
   * 在页面打开时就自作主张地翻译。
   */
  function relayToChildFrames(command) {
    if (!IS_TOP_FRAME || !settings.translateIframes) return;
    const now = Date.now();
    if (now - lastRelayAt < 400) return; // 防抖，避免 SPA 频繁触发时反复广播
    lastRelayAt = now;
    void client.relayToFrames(command, { targetLang: effectiveTargetLang() }).catch(() => {});
  }

  /* ---------------------------------------------------------------- *
   * 展示模式
   * ---------------------------------------------------------------- */

  function applyDisplayMode() {
    const root = document.documentElement;
    root.classList.toggle('dsh-mode-replace', settings.displayMode === 'replace');
    root.classList.toggle('dsh-mode-bilingual', settings.displayMode !== 'replace');
    root.style.setProperty('--dsh-translation-color', settings.bilingualColor);
    root.style.setProperty('--dsh-font-scale', String(settings.bilingualFontScale));
  }

  /* ---------------------------------------------------------------- *
   * 划词翻译
   * ---------------------------------------------------------------- */

  async function previewSelection(text) {
    const value = (text || window.getSelection?.()?.toString() || '').trim();
    if (!value) return;
    ui.showSelectionCard({ loading: true, original: value, translated: '' });
    const cached = await pageCache.get(value, effectiveTargetLang());
    if (cached) {
      ui.showSelectionCard({ loading: false, original: value, translated: cached });
      return;
    }
    // 划词同样走"端上优先 + 远端兜底"：用户刚做过选择，手势是新鲜的，
    // 内置翻译在这里可以直接创建/下载语言包，不必依赖远端通道是否可用。
    const outcome = await translateTexts([value], {
      force: true,
      onProgress: (percent) => {
        ui.showSelectionCard({
          loading: true,
          original: value,
          translated: percent > 0 ? `正在下载语言包 ${percent}%` : '正在下载语言包…'
        });
      }
    });
    const translated = outcome.translations[0] || '';
    if (!translated) {
      ui.showSelectionCard({
        loading: false,
        original: value,
        translated: '',
        error: outcome.errors[0] || '翻译失败'
      });
      return;
    }
    if (outcome.provider) state.stats.provider = outcome.provider;
    void pageCache.set(value, effectiveTargetLang(), translated);
    ui.showSelectionCard({ loading: false, original: value, translated });
  }

  /* ---------------------------------------------------------------- *
   * 设置同步
   * ---------------------------------------------------------------- */

  async function saveSettings(patch) {
    settings = mergeSettings({ ...settings, ...patch });
    applyConfig();
    await client.setSettings(patch);
  }

  client.onSettings((next) => {
    settings = mergeSettings(next);
    applyConfig();
  });

  /* ---------------------------------------------------------------- *
   * 命令（来自 popup / 右键菜单 / 快捷键）
   * ---------------------------------------------------------------- */

  client.onCommand((message) => {
    switch (message.command) {
      case CMD.TRANSLATE_PAGE:
        void translatePage();
        break;
      case CMD.RESTORE_PAGE:
        restorePage();
        break;
      case CMD.TOGGLE:
        if (state.translated) restorePage();
        else void translatePage();
        break;
      case CMD.SET_MODE: {
        const next = settings.displayMode === 'bilingual' ? 'replace' : 'bilingual';
        void saveSettings({ displayMode: next });
        ui.setStatus(next === 'replace' ? '已切换为仅译文' : '已切换为双语对照');
        break;
      }
      case CMD.SET_TARGET:
        if (message.targetLang) void saveSettings({ targetLang: message.targetLang });
        break;
      case CMD.PREVIEW:
        void previewSelection(message.text);
        break;
      default:
        break;
    }
  });

  client.onStatusRequest(() => ({
    translated: state.translated,
    translating: state.translating,
    displayMode: settings.displayMode,
    targetLang: effectiveTargetLang(),
    host: pageHost,
    siteMode: siteDecision(),
    stats: state.stats,
    errors: state.errors.slice(0, 3),
    isTopFrame: IS_TOP_FRAME
  }));

  /* ---------------------------------------------------------------- *
   * 启动
   * ---------------------------------------------------------------- */

  void (async () => {
    try {
      const initial = await client.getSettings();
      if (initial?.settings) settings = mergeSettings(initial.settings);
    } catch (error) {
      log.warn('读取设置失败，使用默认设置', error);
    }
    applyConfig();
    injectStyles((path) => chrome.runtime.getURL(path));
    if (!shouldHandleFrame()) {
      // 广告位/统计挂件这类小 iframe 不翻译，避免重复请求与视觉噪音
      log.debug('跳过该 frame（尺寸过小或不可访问）');
      return;
    }
    ui.mount({ showFloatingButton: settings.showFloatingButton, translateOnSelection: settings.translateOnSelection });
    document.documentElement.classList.add('dsh-translator-ready');
    log.debug('content script 就绪', { host: pageHost, top: IS_TOP_FRAME });

    if (!settings.enabled) return;
    if (siteDecision() === 'never') return;
    // 只有顶层 frame 会在打开页面时自动翻译；子 frame 一律等顶层广播，
    // 避免同一篇内容被翻译两次、配额被吃两遍。
    if (IS_TOP_FRAME && settings.autoTranslateOnLoad) {
      // 稍等页面稳定再翻译，避免与首屏渲染抢资源
      setTimeout(() => void translatePage(), 800);
    }
  })();

  // 供调试：控制台里 __DSH_TRANSLATOR__ 可手动触发
  globalThis.__DSH_TRANSLATOR__ = {
    translate: translatePage,
    restore: restorePage,
    state,
    settings: () => settings
  };

  void STORAGE_KEYS;
}
