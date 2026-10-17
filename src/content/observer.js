/**
 * 动态内容观察器：让翻译"跟上"现代网页。
 *
 * 现代站点的正文几乎都是异步出现的：
 *  - SPA 路由切换（history.pushState 无刷新换页）
 *  - 无限滚动 / 懒加载（IntersectionObserver 触发）
 *  - React/Vue 局部重渲染、评论区展开、弹窗
 *
 * 处理策略：
 *  1. MutationObserver 监听 childList/characterData，把变化位置收集起来，
 *     用 requestIdleCallback + 防抖节流后**只重新扫描变化子树**，不做全页重扫；
 *  2. 忽略我们自己的插入操作（译文容器带 data-dsh-translator），否则会自我循环；
 *  3. 记录 SPA 路由变化，路由改变时按站点策略决定是否自动翻译新页面。
 */

import { createLogger } from '../shared/constants.js';

export class DomObserver {
  /**
   * @param {object} options
   * @param {() => void} options.onDirty          发生变化时的回调（已防抖）
   * @param {() => boolean} [options.enabled]     是否启用（运行时开关）
   * @param {number} [options.debounceMs]
   * @param {(url: string) => void} [options.onNavigate]
   * @param {() => boolean} [options.debug]
   */
  constructor(options) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? 400;
    /** @type {Set<Node>} */
    this.dirtyRoots = new Set();
    this.timer = null;
    this.idleHandle = null;
    this.running = false;
    this.lastUrl = typeof location !== 'undefined' ? location.href : '';
    this.log = createLogger('observer', options.debug ?? (() => false));
    /** @type {MutationObserver | null} */
    this.mutation = null;
    /** @type {(() => void) | null} */
    this.unpatchHistory = null;
  }

  start() {
    if (this.running) return;
    if (typeof MutationObserver === 'undefined' || !document?.documentElement) return;
    this.running = true;

    this.mutation = new MutationObserver((mutations) => {
      if (!this.isEnabled()) return;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const parent = mutation.target.parentElement;
          if (parent && !this.isOurs(parent)) this.dirtyRoots.add(parent);
          continue;
        }
        if (mutation.type === 'childList') {
          if (this.isOurs(mutation.target)) continue;
          let added = 0;
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              if (this.isOurs(node)) continue;
              this.dirtyRoots.add(node);
              added += 1;
            } else if (node.nodeType === 3 && node.parentElement && !this.isOurs(node.parentElement)) {
              this.dirtyRoots.add(node.parentElement);
              added += 1;
            }
          }
          if (added > 0) this.dirtyRoots.add(mutation.target);
        }
      }
      if (this.dirtyRoots.size > 0) this.schedule();
    });

    this.mutation.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    this.patchHistory();
    this.log.debug('动态内容观察已启动');
  }

  stop() {
    this.running = false;
    this.mutation?.disconnect();
    this.mutation = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.idleHandle && typeof cancelIdleCallback === 'function') cancelIdleCallback(this.idleHandle);
    this.timer = null;
    this.idleHandle = null;
    this.dirtyRoots.clear();
    this.unpatchHistory?.();
    this.unpatchHistory = null;
  }

  isEnabled() {
    return this.options.enabled ? this.options.enabled() : true;
  }

  /** 是否是我们自己插入的节点（避免自我触发死循环） */
  isOurs(node) {
    if (!node) return false;
    if (node.nodeType === 3) return this.isOurs(node.parentElement);
    if (node.nodeType !== 1) return false;
    const el = /** @type {Element} */ (node);
    if (el.hasAttribute?.('data-dsh-translator')) return true;
    if (el.id === 'dsh-translator-root') return true;
    if (el.closest?.('[data-dsh-translator],#dsh-translator-root')) return true;
    return false;
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  flush() {
    if (this.dirtyRoots.size === 0) return;
    const run = () => {
      this.idleHandle = null;
      if (this.dirtyRoots.size === 0) return;
      this.dirtyRoots.clear();
      try {
        this.options.onDirty();
      } catch (error) {
        this.log.warn('onDirty 回调异常', error);
      }
    };
    if (typeof requestIdleCallback === 'function') {
      this.idleHandle = requestIdleCallback(run, { timeout: 1200 });
    } else {
      run();
    }
  }

  /** 取出并清空脏子树（调用方决定重扫范围） */
  takeDirtyRoots() {
    const roots = [...this.dirtyRoots];
    this.dirtyRoots.clear();
    return roots;
  }

  /** 监听 SPA 路由变化 */
  patchHistory() {
    const onChange = () => {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      this.log.debug('检测到路由变化', location.href);
      this.options.onNavigate?.(location.href);
    };
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const self = this;
    history.pushState = function patchedPushState(...args) {
      const result = originalPush.apply(this, args);
      setTimeout(() => self.handleUrlChange(onChange), 0);
      return result;
    };
    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplace.apply(this, args);
      setTimeout(() => self.handleUrlChange(onChange), 0);
      return result;
    };
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    this.unpatchHistory = () => {
      history.pushState = originalPush;
      history.replaceState = originalReplace;
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
    };
  }

  handleUrlChange(fn) {
    fn();
  }
}
