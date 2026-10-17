/**
 * Service worker 入口：消息路由 + 右键菜单 + 快捷键 + 设置持久化。
 *
 * 所有网络请求都收敛在这里，原因：
 *  1. content script 受页面 CSP 限制，且跨域请求会被 CORS 拦；
 *  2. 集中限速 / 去重 / 计费统计，避免同一页多个 iframe 重复请求；
 *  3. 浏览器重启后缓存仍在。
 */

import { CMD, MSG, STORAGE_KEYS, hostnameOf, mergeSettings } from '../shared/constants.js';
import { TranslationPipeline } from './pipeline.js';
import { getPreset } from '../providers/index.js';

/* ------------------------------------------------------------------ *
 * 设置装载
 * ------------------------------------------------------------------ */

/** @type {ReturnType<typeof mergeSettings>} */
let settings = mergeSettings(null);
let ready = null;

async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  settings = mergeSettings(data?.[STORAGE_KEYS.settings]);
  return settings;
}

/** 懒初始化，保证 SW 冷启动时也能正确响应 */
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await loadSettings();
      pipeline.applySettings(settings);
      await pipeline.warmup();
    })();
  }
  return ready;
}

const pipeline = new TranslationPipeline({ settings, storage: chrome.storage.local });

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;
  // 只处理本扩展协议前缀，避免和其它扩展/页面消息互相干扰
  if (!message.type.startsWith('translator/')) return undefined;

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.warn('[dsh-translator:background] handler error', message.type, error);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });
  return true; // 异步响应
});

async function handleMessage(message, sender) {
  await ensureReady();
  switch (message.type) {
    case MSG.TRANSLATE: {
      const result = await pipeline.translate({
        segments: message.segments,
        targetLang: message.targetLang,
        sourceLang: message.sourceLang,
        force: message.force,
        requestId: message.requestId
      });
      return { result };
    }
    case MSG.CACHE_GET: {
      const value = pipeline.cache.get(message.text, message.targetLang || settings.targetLang);
      return { value: value ?? null };
    }
    case MSG.CACHE_PUT: {
      pipeline.cache.set(message.text, message.targetLang || settings.targetLang, message.translated);
      return {};
    }
    case MSG.CACHE_STATS:
      return { stats: { ...pipeline.cache.stats(), ...pipeline.stats } };
    case MSG.CACHE_CLEAR:
      await pipeline.cache.clear();
      return {};
    case MSG.GET_SETTINGS:
      return { settings, host: sender?.url ? hostnameOf(sender.url) : '' };
    case MSG.SET_SETTINGS: {
      const next = mergeSettings({ ...settings, ...(message.patch || {}) });
      settings = next;
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
      pipeline.applySettings(next);
      broadcastSettings(next);
      return { settings: next };
    }
    case MSG.TEST_PROVIDER:
      return { result: await pipeline.testProvider(message.providerId, message.sample) };
    case MSG.RELAY_TO_FRAMES:
      return { delivered: relayToFrames(sender, message.command, message.payload) };
    default:
      return {};
  }
}

/**
 * 把命令转发给同标签页的所有 frame。
 *
 * 为什么必须经过 background：content script 之间无法直接通信，顶层页面也无权访问
 * 跨域 iframe 的 DOM。开启"翻译内嵌页面"时，顶层 frame 通过这里让子 frame
 * 各自翻译自己 document 里的内容（各自渲染、互不干扰）。
 *
 * 注意：不传 frameId 时 Chrome 会把消息发给该标签页的**所有** frame，
 * 包括发起方自己——这不构成死循环，因为 translatePage 对"翻译中/已翻译"
 * 的状态是幂等的（会直接返回）。
 *
 * @param {chrome.runtime.MessageSender} sender
 * @param {string} command
 * @param {object} [payload]
 * @returns {boolean} 是否已投递
 */
function relayToFrames(sender, command, payload) {
  const tabId = sender?.tab?.id;
  if (tabId === undefined || tabId === null) return false;
  chrome.tabs.sendMessage(tabId, { type: MSG.CMD, command, ...(payload || {}) }, () => {
    void chrome.runtime.lastError;
  });
  return true;
}

/** 设置变更后通知所有已打开的标签页即时生效 */
function broadcastSettings(next) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: MSG.SET_SETTINGS, settings: next }, () => void chrome.runtime.lastError);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

const MENU = {
  page: 'dsh-translate-page',
  selection: 'dsh-translate-selection',
  restore: 'dsh-restore-page'
};

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.page,
      title: '翻译此页面（双语对照）',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: MENU.selection,
      title: '翻译选中文字',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU.restore,
      title: '还原原文',
      contexts: ['page', 'frame']
    });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  buildMenus();
  if (details.reason === 'install') {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup?.addListener(() => {
  buildMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU.page) {
    sendToTab(tab.id, { type: MSG.CMD, command: CMD.TRANSLATE_PAGE, targetLang: settings.targetLang });
  } else if (info.menuItemId === MENU.restore) {
    sendToTab(tab.id, { type: MSG.CMD, command: CMD.RESTORE_PAGE });
  } else if (info.menuItemId === MENU.selection) {
    sendToTab(tab.id, { type: MSG.CMD, command: CMD.PREVIEW, text: info.selectionText || '' });
  }
});

function sendToTab(tabId, payload, frameId) {
  chrome.tabs.sendMessage(tabId, payload, frameId === undefined ? {} : { frameId }, () => {
    if (chrome.runtime.lastError) {
      // 内容脚本未注入（例如 chrome:// 页面）时静默忽略
    }
  });
}

/* ------------------------------------------------------------------ *
 * 快捷键
 * ------------------------------------------------------------------ */

chrome.commands?.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    if (command === 'toggle-translate') {
      sendToTab(tab.id, { type: MSG.CMD, command: CMD.TOGGLE });
    } else if (command === 'toggle-mode') {
      sendToTab(tab.id, { type: MSG.CMD, command: CMD.SET_MODE });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

chrome.runtime.onSuspend?.addListener(() => {
  void pipeline.flush();
});

// 早期 SW 版本在无事件时会随时终止；这里主动预热一次，让首次翻译更快
void ensureReady();

export { pipeline, settings };
