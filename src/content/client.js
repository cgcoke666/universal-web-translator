/**
 * content script ⟷ service worker 的通信客户端。
 *
 * 统一处理三件事：
 *  1. 消息发送 + 超时（SW 可能正在冷启动，不能无限等）；
 *  2. 失败重试一次（MV3 SW 唤醒 race 很常见）；
 *  3. 命令（popup/快捷键/右键菜单）与设置变更的订阅分发。
 */

import { CMD, MSG } from '../shared/constants.js';

const DEFAULT_TIMEOUT = 90_000;

export class TranslationClient {
  constructor() {
    /** @type {Set<(settings: object) => void>} */
    this.settingsListeners = new Set();
    /** @type {Set<(message: object) => void>} */
    this.commandListeners = new Set();
    /** @type {(() => object) | null} */
    this.statusProvider = null;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === MSG.SET_SETTINGS) {
        for (const listener of this.settingsListeners) listener(message.settings);
        sendResponse?.({ ok: true });
        return true;
      }
      if (message?.type === MSG.CMD) {
        for (const listener of this.commandListeners) listener(message);
        sendResponse?.({ ok: true });
        return true;
      }
      if (message?.type === MSG.STATUS) {
        sendResponse?.({ ok: true, status: this.statusProvider ? this.statusProvider() : null });
        return true;
      }
      return undefined;
    });
  }

  /**
   * 发送消息给 background。
   * @param {object} payload
   * @param {{timeout?: number, retries?: number}} [options]
   */
  async send(payload, options = {}) {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const retries = options.retries ?? 1;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await withTimeout(
          chrome.runtime.sendMessage({ ...payload }),
          timeout
        );
        if (!response) throw new Error('扩展后台无响应（可能刚被系统回收，请重试）');
        if (response.ok === false) throw new Error(response.error || '后台返回失败');
        return response;
      } catch (error) {
        lastError = error;
        // 扩展上下文失效（重新加载扩展）时不再重试
        if (/Extension context invalidated/i.test(String(error?.message))) throw error;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw lastError ?? new Error('消息发送失败');
  }

  translate({ segments, targetLang, sourceLang, force }) {
    return this.send(
      { type: MSG.TRANSLATE, segments, targetLang, sourceLang, force },
      { timeout: 180_000 }
    );
  }

  getSettings() {
    return this.send({ type: MSG.GET_SETTINGS });
  }

  setSettings(patch) {
    return this.send({ type: MSG.SET_SETTINGS, patch });
  }

  cacheStats() {
    return this.send({ type: MSG.CACHE_STATS });
  }

  /** 让同标签页的其它 frame 一起执行命令（整页翻译时带上内嵌页面） */
  relayToFrames(command, payload) {
    return this.send({ type: MSG.RELAY_TO_FRAMES, command, payload });
  }

  openOptionsPage() {
    try {
      chrome.runtime.openOptionsPage();
    } catch {
      /* ignore */
    }
  }

  onSettings(listener) {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  onCommand(listener) {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  onStatusRequest(provider) {
    this.statusProvider = provider;
  }
}

/**
 * 给 Promise 加超时。
 *
 * ⚠️ 必须显式 clearTimeout 收尾。
 * 直接 `Promise.race([p, new Promise(_, reject => setTimeout(...))])` 的写法有个隐蔽问题：
 * 正常返回时那个定时器**不会被清理**，会一直挂到超时才消失。
 * 本扩展里 `DEFAULT_TIMEOUT` 是 90 秒，意味着每发一条消息都会留下一个 90 秒的
 * pending 定时器——在浏览器里只是浪费一点内存，但在 Node 里跑"真正执行产物"的
 * 校验/测试时，事件循环要等它 90 秒才排空（实测就是这样被卡住的）。
 */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待后台响应超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

export { CMD };
