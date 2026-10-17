/**
 * 弹出面板逻辑。
 *
 * 它自己不做任何翻译，只做两件事：
 *  1. 向当前标签页的 content script 要"页面翻译状态"，把按钮文案与显示模式对齐；
 *  2. 把用户点击翻译成命令消息发过去。
 *
 * 这样 popup 永远是"薄"的：所有状态都来自页面本身，不会出现 popup 显示"已翻译"
 * 但页面其实没翻译的不一致。
 */

import { CMD, LANGUAGES, MSG } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);

/** @type {number | null} */
let tabId = null;
/** @type {object} */
let settings = {};
/** @type {object | null} */
let status = null;

async function init() {
  fillLanguages();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  const response = await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS });
  settings = response?.settings ?? {};
  if (tab?.url) {
    try {
      $('host').textContent = new URL(tab.url).hostname;
    } catch {
      $('host').textContent = '';
    }
  }
  $('engineInfo').textContent = describeEngine(settings);

  bind();
  await refreshStatus();
}

function fillLanguages() {
  $('targetLang').innerHTML = LANGUAGES.map(
    (lang) => `<option value="${lang.code}">${lang.label}</option>`
  ).join('');
}

function describeEngine(current) {
  const onDevice = current.enableOnDevice !== false ? '内置翻译（离线）' : '';
  const remote = (current.fallbackProviders || []).join(' → ') || 'Microsoft/Edge → Google';
  if (current.provider === 'auto') {
    return `引擎：${onDevice ? `${onDevice} → ${remote}` : remote}`;
  }
  if (current.provider === 'on-device') {
    return `引擎：${onDevice || '内置翻译'}（失败自动降级到 ${remote}）`;
  }
  return `引擎：${onDevice ? `${onDevice} → ` : ''}${current.provider}`;
}

function bind() {
  $('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $('toggle').addEventListener('click', async () => {
    const translated = Boolean(status?.translated);
    await send({ command: translated ? CMD.RESTORE_PAGE : CMD.TRANSLATE_PAGE });
    window.close();
  });

  $('retranslate').addEventListener('click', async () => {
    await send({ command: CMD.RESTORE_PAGE });
    await send({ command: CMD.TRANSLATE_PAGE });
    window.close();
  });

  $('restore').addEventListener('click', async () => {
    await send({ command: CMD.RESTORE_PAGE });
    window.close();
  });

  $('modeSeg').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    const mode = button.dataset.mode;
    if (mode === status?.displayMode) return;
    await chrome.runtime.sendMessage({ type: MSG.SET_SETTINGS, patch: { displayMode: mode } });
    await send({ command: CMD.SET_MODE });
    await refreshStatus();
  });

  $('targetLang').addEventListener('change', async () => {
    const targetLang = $('targetLang').value;
    await chrome.runtime.sendMessage({ type: MSG.SET_SETTINGS, patch: { targetLang } });
    await send({ command: CMD.SET_TARGET, targetLang });
    window.close();
  });

  $('siteMode').addEventListener('change', async () => {
    const host = $('host').textContent.trim();
    if (!host) return;
    const siteMode = { ...(settings.siteMode || {}) };
    const value = $('siteMode').value;
    if (value === 'auto') delete siteMode[host];
    else siteMode[host] = value;
    await chrome.runtime.sendMessage({ type: MSG.SET_SETTINGS, patch: { siteMode } });
    settings.siteMode = siteMode;
  });
}

async function send(message) {
  if (tabId === null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.CMD, ...message });
  } catch {
    // 页面没有内容脚本（chrome:// 或扩展未注入），静默失败并由状态区提示
    $('status').textContent = '当前页面无法注入翻译脚本';
  }
}

async function refreshStatus() {
  if (tabId === null) {
    $('status').textContent = '没有活动标签页';
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.STATUS });
    status = response?.status ?? null;
  } catch {
    status = null;
  }
  render();
}

function render() {
  const translated = Boolean(status?.translated);
  $('toggle').textContent = status?.translating ? '翻译中…' : translated ? '还原原文' : '翻译此页面';
  $('toggle').disabled = Boolean(status?.translating);

  const mode = status?.displayMode ?? settings.displayMode ?? 'bilingual';
  for (const button of document.querySelectorAll('#modeSeg [data-mode]')) {
    button.classList.toggle('is-active', button.dataset.mode === mode);
  }
  $('targetLang').value = status?.targetLang ?? settings.targetLang ?? 'zh-CN';
  $('siteMode').value = status?.siteMode ?? settings.siteMode?.[$('host').textContent.trim()] ?? 'auto';

  const stats = status?.stats;
  if (stats?.translated) {
    $('status').textContent = `已翻译 ${stats.translated} 段 · ${stats.provider || '缓存'} · ${stats.elapsedMs || 0}ms`;
  } else if (status?.errors?.length) {
    $('status').textContent = `错误：${status.errors[0]}`;
  } else {
    $('status').textContent = status ? '就绪' : '当前页面不支持翻译（如浏览器内置页面）';
  }
}

void init();
