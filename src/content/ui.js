/**
 * 页面内 UI：悬浮球 / 控制面板 / 划词翻译卡片 / 进度提示。
 *
 * 全部挂在 Shadow DOM 里，做到：
 *  - 与站点样式完全隔离（站点样式改不到我们，我们也不影响站点）；
 *  - 只往页面塞 **一个** 宿主元素，DOM 污染最小，`MutationObserver` 也容易忽略；
 *  - 事件不冒泡到页面，避免触发站点的快捷键/点击逻辑。
 */

import { LANGUAGES } from '../shared/constants.js';
import { computeLaunchState, describeEngine } from './launchState.js';
import { injectStyles } from './env.js';

const HOST_ID = 'dsh-translator-root';

export class TranslatorUi {
  /**
   * @param {object} handlers
   * @param {() => void} handlers.onTranslate
   * @param {() => void} handlers.onRestore
   * @param {() => void} handlers.onToggleMode
   * @param {() => void} handlers.onOpenSettings
   * @param {(text: string) => void} handlers.onPreview
   * @param {() => object} handlers.getState
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.host = null;
    this.shadow = null;
    /** @type {Record<string, HTMLElement>} */
    this.refs = {};
    this.panelOpen = false;
    this.cardVisible = false;
    this.progress = { done: 0, total: 0 };
    this.status = '';
    this.busy = false;
    this.mounted = false;
    this.options = { showFloatingButton: true, translateOnSelection: true };
    /** 端上引擎的最近一次探测结果（由 content 侧注入，用于显示"离线就绪/需下载"） */
    this.probe = null;
    /** 语言包下载百分比（null = 当前没有在下载） */
    this.downloadPercent = null;
    /** 语言包下载完成后的短暂提示 */
    this.notice = '';
    /** @type {((event: MouseEvent) => void) | null} */
    this.selectionHandler = null;
  }

  mount(options = {}) {
    if (this.mounted) return;
    this.options = { ...this.options, ...options };
    if (!document.body) {
      // body 还没就绪时等 DOMContentLoaded
      document.addEventListener('DOMContentLoaded', () => this.mount(options), { once: true });
      return;
    }
    injectStyles((path) => chrome.runtime.getURL(path));

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.host.setAttribute('data-dsh-translator', 'ui');
    // 宿主本身不占位、不接收事件，避免影响站点布局
    this.host.style.cssText = 'all:initial;position:fixed;inset:auto;z-index:2147483600;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = this.template();
    document.documentElement.appendChild(this.host);

    this.cacheRefs();
    this.bindEvents();
    this.mounted = true;
    this.refresh();
  }

  /* ---------------------------------------------------------------- *
   * 模板
   * ---------------------------------------------------------------- */

  template() {
    const langOptions = LANGUAGES.map(
      (lang) => `<option value="${lang.code}">${lang.label}</option>`
    ).join('');
    return `
      <style>${SHADOW_CSS}</style>
      <div class="launcher" part="launcher">
        <button class="fab" title="网页翻译（Alt+Shift+T）" aria-label="网页翻译">
          <span class="fab__glyph">译</span>
          <i class="fab__dot" data-ref="fabDot" aria-hidden="true"></i>
        </button>
      </div>

      <section class="panel" hidden>
        <header class="panel__head">
          <span class="panel__title">
            <i class="dot" data-ref="indicator" aria-hidden="true"></i>
            网页翻译
          </span>
          <span class="panel__badge" data-ref="engine">内置翻译优先</span>
          <button class="icon-btn" data-act="close" title="收起">✕</button>
        </header>

        <div class="panel__body">
          <button class="primary" data-act="toggle">开启翻译</button>

          <div class="row">
            <label class="row__label">引擎</label>
            <span class="state" data-ref="stateLabel">待命</span>
          </div>

          <div class="row">
            <label class="row__label">显示</label>
            <div class="seg" data-act="mode">
              <button data-mode="bilingual" class="seg__btn">双语对照</button>
              <button data-mode="replace" class="seg__btn">仅译文</button>
            </div>
          </div>

          <div class="row">
            <label class="row__label">目标</label>
            <select class="select" data-act="target">${langOptions}</select>
          </div>

          <div class="status" data-ref="detail"></div>
          <div class="status status--sub" data-ref="status"></div>
          <div class="progress" data-ref="progress" hidden>
            <div class="progress__bar"><i></i></div>
            <span class="progress__text" data-ref="progressText">0/0</span>
          </div>

          <div class="row row--actions">
            <button class="link" data-act="restore">还原原文</button>
            <button class="link" data-act="download" data-ref="download" hidden>提前下载语言包</button>
            <button class="link" data-act="settings">设置</button>
          </div>
        </div>
      </section>

      <div class="card" hidden>
        <header class="card__head">
          <span>划词翻译</span>
          <button class="icon-btn" data-act="card-close" title="关闭">✕</button>
        </header>
        <div class="card__body">
          <p class="card__original" data-ref="cardOriginal"></p>
          <p class="card__translated" data-ref="cardTranslated"></p>
          <p class="card__error" data-ref="cardError" hidden></p>
        </div>
        <footer class="card__foot">
          <button class="link" data-act="card-copy">复制译文</button>
        </footer>
      </div>
    `;
  }

  cacheRefs() {
    const query = (name) => this.shadow.querySelector(`[data-ref="${name}"]`);
    const action = (name) => this.shadow.querySelector(`[data-act="${name}"]`);
    this.refs = {
      launcher: this.shadow.querySelector('.launcher'),
      fab: this.shadow.querySelector('.fab'),
      fabDot: query('fabDot'),
      panel: this.shadow.querySelector('.panel'),
      toggle: action('toggle'),
      restore: action('restore'),
      settings: action('settings'),
      close: action('close'),
      download: action('download'),
      target: action('target'),
      mode: action('mode'),
      indicator: query('indicator'),
      engine: query('engine'),
      stateLabel: query('stateLabel'),
      detail: query('detail'),
      status: query('status'),
      progress: query('progress'),
      progressBar: this.shadow.querySelector('.progress__bar i'),
      progressText: query('progressText'),
      card: this.shadow.querySelector('.card'),
      cardOriginal: query('cardOriginal'),
      cardTranslated: query('cardTranslated'),
      cardError: query('cardError'),
      cardClose: action('card-close'),
      cardCopy: action('card-copy')
    };
  }

  /* ---------------------------------------------------------------- *
   * 事件
   * ---------------------------------------------------------------- */

  bindEvents() {
    // 所有 UI 事件都不冒泡到页面
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'keydown']) {
      this.host.addEventListener(type, (event) => {
        event.stopPropagation();
      });
    }

    this.refs.fab?.addEventListener('click', (event) => {
      event.preventDefault();
      this.togglePanel();
    });

    this.refs.close?.addEventListener('click', () => this.togglePanel(false));
    // 主按钮是"加速器开关"：具体做什么由状态机决定（翻译 / 还原 / 下载语言包 / 打开设置）
    this.refs.toggle?.addEventListener('click', () => {
      switch (this.launchState().action) {
        case 'download-and-translate':
          // 必须在这里同步触发下载（onDownload 内部第一件事就是 Translator.create()），
          // 借用本次点击的 transient activation；下载完再翻译。
          Promise.resolve(this.handlers.onDownload?.({ thenTranslate: true })).catch(() => {});
          break;
        case 'settings':
          this.handlers.onOpenSettings();
          break;
        case 'translate':
        default:
          // 'restore' 也交给 content 侧：translatePage 对"已翻译"是幂等的，
          // 由它统一决定翻译还是还原，避免 UI 与页面状态各执一词。
          this.handlers.onTranslate();
          break;
      }
    });
    this.refs.download?.addEventListener('click', () => {
      Promise.resolve(this.handlers.onDownload?.({ thenTranslate: false })).catch(() => {});
    });
    this.refs.restore?.addEventListener('click', () => this.handlers.onRestore());
    this.refs.settings?.addEventListener('click', () => this.handlers.onOpenSettings());
    this.refs.mode?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      const state = this.handlers.getState();
      if (button.dataset.mode === state.displayMode) return;
      this.handlers.onToggleMode();
    });
    this.refs.target?.addEventListener('change', (event) => {
      const value = event.target.value;
      this.handlers.onTargetLang?.(value);
    });
    this.refs.cardClose?.addEventListener('click', () => this.hideCard());
    this.refs.cardCopy?.addEventListener('click', async () => {
      const text = this.refs.cardTranslated?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        this.setStatus('译文已复制');
      } catch {
        this.setStatus('复制失败，请手动选择');
      }
    });

    // 划词翻译：mouseup 后判断是否有选中文本
    if (this.options.translateOnSelection) {
      this.selectionHandler = (event) => {
        if (event.target === this.host || this.host.contains(event.target)) return;
        const selection = window.getSelection?.();
        const text = selection?.toString().trim() ?? '';
        if (!text || text.length < 2 || text.length > 3000) {
          return;
        }
        this.selectionText = text;
        this.showSelectionTrigger();
      };
      document.addEventListener('mouseup', this.selectionHandler, true);
    }

    // Esc 关闭
    this.escapeHandler = (event) => {
      if (event.key !== 'Escape') return;
      if (this.cardVisible) this.hideCard();
      else if (this.panelOpen) this.togglePanel(false);
    };
    document.addEventListener('keydown', this.escapeHandler, true);

    this.makeDraggable();
  }

  /** 悬浮球可拖动，位置记忆在 localStorage（按 origin） */
  makeDraggable() {
    const fab = this.refs.fab;
    if (!fab) return;
    const stored = readPosition();
    if (stored) applyPosition(this.refs.launcher, stored);
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    fab.addEventListener('pointerdown', (event) => {
      dragging = true;
      moved = false;
      const rect = this.refs.launcher.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      originX = rect.left;
      originY = rect.top;
      fab.setPointerCapture?.(event.pointerId);
    });

    fab.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const next = {
        left: clamp(originX + dx, 8, window.innerWidth - 56),
        top: clamp(originY + dy, 8, window.innerHeight - 56)
      };
      applyPosition(this.refs.launcher, next);
    });

    const end = (event) => {
      if (!dragging) return;
      dragging = false;
      fab.releasePointerCapture?.(event.pointerId);
      if (moved) {
        const rect = this.refs.launcher.getBoundingClientRect();
        writePosition({ left: rect.left, top: rect.top });
        this.suppressNextClick = true;
        setTimeout(() => {
          this.suppressNextClick = false;
        }, 0);
      }
    };
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);
    fab.addEventListener('click', (event) => {
      if (this.suppressNextClick) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    }, true);
  }

  /* ---------------------------------------------------------------- *
   * 交互
   * ---------------------------------------------------------------- */

  togglePanel(force) {
    this.panelOpen = force === undefined ? !this.panelOpen : force;
    if (this.refs.panel) this.refs.panel.hidden = !this.panelOpen;
    if (this.panelOpen) {
      this.refresh();
      // 面板打开时才去探测端上能力（不下载、不创建实例），
      // 这样"离线就绪 / 需下载语言包"是准的，同时又不必在每次页面加载时打扰浏览器。
      Promise.resolve(this.handlers.onPanelOpen?.()).catch(() => {});
    }
  }

  showSelectionTrigger() {
    if (!this.refs.card || this.cardVisible) return;
    // 选中后自动弹卡片：比多一次点击更省事，符合"划词即译"的预期
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      if (this.selectionText) this.handlers.onPreview(this.selectionText);
    }, 260);
  }

  /**
   * @param {{loading: boolean, original: string, translated: string, error?: string}} payload
   */
  showSelectionCard(payload) {
    if (!this.refs.card) return;
    this.cardVisible = true;
    this.refs.card.hidden = false;
    this.refs.cardOriginal.textContent = truncate(payload.original, 600);
    this.refs.cardTranslated.textContent = payload.loading ? '翻译中…' : payload.translated;
    this.refs.cardTranslated.classList.toggle('is-loading', Boolean(payload.loading));
    if (payload.error) {
      this.refs.cardError.hidden = false;
      this.refs.cardError.textContent = payload.error;
    } else {
      this.refs.cardError.hidden = true;
      this.refs.cardError.textContent = '';
    }
  }

  hideCard() {
    this.cardVisible = false;
    this.selectionText = '';
    if (this.refs.card) this.refs.card.hidden = true;
  }

  /* ---------------------------------------------------------------- *
   * 启动状态（"加速器"式开关）
   * ---------------------------------------------------------------- */

  /** 把 content 侧的探测结果注入 UI（打开面板前由 content 异步刷新） */
  setProbe(probe) {
    this.probe = probe ?? null;
    this.refresh();
  }

  /** 语言包下载进度；传 null 表示结束 */
  setDownloadProgress(percent) {
    this.downloadPercent = percent === null || percent === undefined ? null : percent;
    this.refresh();
  }

  /** 一次性提示（例如"语言包已就绪"），显示在状态行 */
  setNotice(text) {
    this.notice = text || '';
    if (this.notice) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => {
        this.notice = '';
        this.refresh();
      }, 4000);
    }
    this.refresh();
  }

  /** 当前应该展示的启动状态（纯函数推导，见 launchState.js） */
  launchState() {
    const state = this.handlers.getState();
    return computeLaunchState({
      translated: state.translated,
      translating: state.translating,
      busy: this.busy,
      enableOnDevice: state.enableOnDevice !== false,
      remoteFallback: state.remoteFallback !== false,
      probe: this.probe,
      downloadPercent: this.downloadPercent
    });
  }

  /* ---------------------------------------------------------------- *
   * 状态渲染
   * ---------------------------------------------------------------- */

  setStatus(text) {
    this.status = text;
    if (this.refs.status) this.refs.status.textContent = text;
  }

  /** 新一轮翻译开始时清掉上一轮的提示，避免旧文案误导读到的状态 */
  clearStatus() {
    this.status = '';
    this.notice = '';
    clearTimeout(this.noticeTimer);
    if (this.refs.status) this.refs.status.textContent = '';
  }

  setBusy(busy) {
    this.busy = busy;
    this.refresh();
  }

  setProgress(done, total) {
    this.progress = { done, total };
    if (!this.refs.progress) return;
    if (total <= 0 || done >= total) {
      this.refs.progress.hidden = true;
      return;
    }
    this.refs.progress.hidden = false;
    const percent = Math.round((done / total) * 100);
    if (this.refs.progressBar) this.refs.progressBar.style.width = `${percent}%`;
    if (this.refs.progressText) this.refs.progressText.textContent = `${done}/${total}`;
  }

  /** 根据当前页面状态刷新面板文案与"加速器"状态 */
  refresh() {
    if (!this.mounted) return;
    const state = this.handlers.getState();
    const launch = this.launchState();
    const translated = Boolean(state.translated);

    if (this.refs.launcher) this.refs.launcher.hidden = !this.options.showFloatingButton;

    // 悬浮球指示灯：未翻译时也要让用户一眼看出"能不能离线用"
    const fabTone = translated ? 'ok' : launch.indicator;
    if (this.refs.fab) {
      this.refs.fab.dataset.state = fabTone;
      this.refs.fab.title = `网页翻译（Alt+Shift+T）· ${launch.label}`;
    }

    // 主按钮（文案与可用性全部来自状态机，"已翻译 → 还原原文"也在其中）
    if (this.refs.toggle) {
      this.refs.toggle.textContent = launch.buttonText;
      this.refs.toggle.disabled = launch.buttonDisabled;
    }

    // 状态指示灯 + 状态名 + 引擎标识
    if (this.refs.indicator) this.refs.indicator.dataset.tone = launch.indicator;
    if (this.refs.stateLabel) this.refs.stateLabel.textContent = launch.label;
    if (this.refs.engine) {
      this.refs.engine.textContent = describeEngine({
        provider: state.stats?.provider,
        enableOnDevice: state.enableOnDevice
      });
    }

    // 显示模式 / 目标语言
    for (const button of this.shadow.querySelectorAll('[data-mode]')) {
      button.classList.toggle('is-active', button.dataset.mode === state.displayMode);
    }
    if (this.refs.target && this.refs.target.value !== state.targetLang) {
      this.refs.target.value = state.targetLang;
    }

    // "提前下载语言包"只在确实缺语言包时出现
    if (this.refs.download) {
      const canDownload = launch.status === 'needs-pack' && !this.busy;
      this.refs.download.hidden = !canDownload;
      this.refs.download.textContent =
        this.downloadPercent === null || this.downloadPercent === undefined
          ? '提前下载语言包'
          : `下载中 ${this.downloadPercent}%`;
    }

    // 细节行：优先展示错误与临时提示；否则只清空，
    // 因为上方的 launch.detail 已经说明了当前状态，无需再把 this.status 回显一遍。
    if (this.refs.detail) this.refs.detail.textContent = launch.detail;
    if (state.errors?.length > 0) this.setStatus(`注意：${state.errors[0]}`);
    else if (this.notice) this.setStatus(this.notice);
    else if (this.refs.status) this.refs.status.textContent = '';
  }

  destroy() {
    if (this.selectionHandler) document.removeEventListener('mouseup', this.selectionHandler, true);
    if (this.escapeHandler) document.removeEventListener('keydown', this.escapeHandler, true);
    this.host?.remove();
    this.mounted = false;
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readPosition() {
  try {
    const raw = localStorage.getItem('dsh-translator:fab');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.left === 'number' && typeof parsed?.top === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writePosition(position) {
  try {
    localStorage.setItem('dsh-translator:fab', JSON.stringify(position));
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
}

function applyPosition(el, position) {
  if (!el) return;
  el.style.left = `${Math.round(position.left)}px`;
  el.style.top = `${Math.round(position.top)}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
}

/* ------------------------------------------------------------------ *
 * Shadow DOM 样式
 * ------------------------------------------------------------------ */

const SHADOW_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483600; }
.fab {
  width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer;
  background: linear-gradient(160deg, #4f6ef7, #2942b0); color: #fff;
  font-size: 15px; font-weight: 700; box-shadow: 0 4px 14px rgba(20,30,80,.35);
  display: flex; align-items: center; justify-content: center; padding: 0;
  transition: transform .15s ease, box-shadow .15s ease;
}
.fab:hover { transform: translateY(-1px) scale(1.04); box-shadow: 0 6px 18px rgba(20,30,80,.45); }
.fab:active { transform: scale(.97); }
.fab__glyph { line-height: 1; }
/* 悬浮球状态灯：待命 / 离线就绪 / 需下载 / 翻译中 / 不可用 */
.fab__dot {
  position: absolute; right: 2px; bottom: 2px; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid #fff; background: #9aa1b1; transition: background .2s ease;
}
.fab { position: relative; }
.fab[data-state="ok"] .fab__dot { background: #1f9d55; }
.fab[data-state="warn"] .fab__dot { background: #e8a33d; }
.fab[data-state="busy"] .fab__dot { background: #3b5bfd; animation: dsh-pulse 1.1s ease-in-out infinite; }
.fab[data-state="off"] .fab__dot { background: #c0392b; }
.fab[data-state="idle"] .fab__dot { background: #9aa1b1; }
@keyframes dsh-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

.panel {
  position: fixed; right: 20px; bottom: 74px; width: 288px; z-index: 2147483600;
  background: #fff; color: #1c2333; border-radius: 14px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(15,22,50,.28); border: 1px solid rgba(15,22,50,.08);
}
.panel__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #f6f7fb; border-bottom: 1px solid rgba(15,22,50,.06); }
.panel__title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.panel__badge {
  margin-left: auto; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10.5px; color: #4a5266; background: rgba(15,22,50,.06); border-radius: 999px; padding: 2px 8px;
}
/* 状态指示灯：颜色即语义 */
.dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa1b1; flex: none; }
.dot[data-tone="ok"] { background: #1f9d55; }
.dot[data-tone="warn"] { background: #e8a33d; }
.dot[data-tone="busy"] { background: #3b5bfd; animation: dsh-pulse 1.1s ease-in-out infinite; }
.dot[data-tone="off"] { background: #c0392b; }
.dot[data-tone="idle"] { background: #9aa1b1; }
.state { font-size: 12px; font-weight: 600; color: #1c2333; }
.panel__body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.primary {
  width: 100%; padding: 9px 12px; border-radius: 9px; border: none; cursor: pointer;
  background: #3b5bfd; color: #fff; font-size: 13px; font-weight: 600;
}
.primary:hover:not(:disabled) { background: #2b49e0; }
.primary:disabled { opacity: .6; cursor: default; }
.row { display: flex; align-items: center; gap: 8px; }
.row__label { font-size: 12px; color: #6b7385; width: 36px; flex: none; }
.row--actions { justify-content: space-between; margin-top: 2px; }
.seg { display: flex; background: #eef0f6; border-radius: 8px; padding: 2px; flex: 1; }
.seg__btn { flex: 1; border: none; background: transparent; padding: 5px 6px; border-radius: 6px; font-size: 12px; cursor: pointer; color: #4a5266; }
.seg__btn.is-active { background: #fff; color: #1c2333; font-weight: 600; box-shadow: 0 1px 3px rgba(15,22,50,.14); }
.select { flex: 1; padding: 5px 6px; border-radius: 8px; border: 1px solid rgba(15,22,50,.14); font-size: 12px; background: #fff; color: #1c2333; }
.status { font-size: 11px; color: #4a5266; line-height: 1.5; word-break: break-word; }
.status--sub { color: #6b7385; }
.link { border: none; background: none; color: #3b5bfd; font-size: 12px; cursor: pointer; padding: 2px 0; }
.link:hover { text-decoration: underline; }
.icon-btn { border: none; background: none; cursor: pointer; color: #6b7385; font-size: 13px; padding: 2px 4px; border-radius: 6px; }
.icon-btn:hover { background: rgba(15,22,50,.06); }
.progress { display: flex; align-items: center; gap: 8px; }
.progress__bar { flex: 1; height: 4px; background: #eef0f6; border-radius: 3px; overflow: hidden; }
.progress__bar i { display: block; height: 100%; width: 0; background: #3b5bfd; transition: width .25s ease; }
.progress__text { font-size: 11px; color: #6b7385; }

.card {
  position: fixed; right: 20px; bottom: 74px; width: 320px; z-index: 2147483600;
  background: #fff; color: #1c2333; border-radius: 14px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(15,22,50,.28); border: 1px solid rgba(15,22,50,.08);
}
.card__head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #f6f7fb; border-bottom: 1px solid rgba(15,22,50,.06); font-size: 12px; font-weight: 600; }
.card__body { padding: 10px 12px; max-height: 320px; overflow: auto; }
.card__original { margin: 0 0 8px; font-size: 12px; color: #6b7385; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.card__translated { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.card__translated.is-loading { color: #99a0b0; }
.card__error { margin: 8px 0 0; font-size: 11px; color: #c0392b; }
.card__foot { padding: 8px 12px; border-top: 1px solid rgba(15,22,50,.06); display: flex; justify-content: flex-end; }
`;
