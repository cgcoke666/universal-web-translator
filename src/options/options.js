/**
 * 设置页逻辑。
 *
 * 设计原则：
 *  - 表单是"受控"的：任何改动都合并进内存中的 settings，再整体写回 storage，
 *    并由 background 广播给所有标签页（所以改设置不需要刷新页面）；
 *  - provider 表单按需渲染：只有选中的引擎和需要 Key 的引擎才展开；
 *  - 所有网络动作（连通性测试）都通过 background 代理，页面不直接发请求。
 */

import { AUTO_DETECT, LANGUAGES, MSG, mergeSettings } from '../shared/constants.js';
import { listProviders, PRESETS } from '../providers/index.js';
import {
  ON_DEVICE_PROVIDER_ID,
  isSupported as onDeviceSupported,
  probeAvailability,
  ensurePair,
  normalizeOnDeviceLang
} from '../shared/onDevice.js';

const $ = (id) => document.getElementById(id);

/** 引擎类型标签（on-device 没有远端实现，单独一档文案） */
const PROVIDER_KIND_TAG = {
  'on-device': '端上 / 离线',
  free: '免费',
  local: '本地',
  key: '需 Key'
};

/** @type {any} */
let settings = mergeSettings(null);
let currentHost = '';

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

async function init() {
  const response = await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS });
  settings = mergeSettings(response?.settings);
  currentHost = response?.host || '';

  const manifest = chrome.runtime.getManifest();
  $('version').textContent = `v${manifest.version}`;

  fillLanguageSelects();
  renderProviderSelect();
  renderFallbackList();
  renderProviderForms();
  bindGlobalInputs();
  bindEngineInputs();
  bindSiteInputs();
  bindStorageInputs();
  hydrate();
  showWelcomeIfNeeded();
  void refreshStats();
  void detectCurrentTab();
  void refreshOnDeviceStatus();

  document.querySelectorAll('.nav').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const id = link.getAttribute('href').slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function fillLanguageSelects() {
  const options = LANGUAGES.map((lang) => `<option value="${lang.code}">${lang.label}</option>`).join('');
  $('targetLang').innerHTML = options;
  $('siteTargetLang').innerHTML = `<option value="">（跟随全局）</option>${options}`;
  $('sourceLang').innerHTML = `<option value="${AUTO_DETECT}">自动检测</option>${options}`;
}

function renderProviderSelect() {
  const options = [
    `<option value="auto">自动（内置翻译优先 + 免费通道兜底）</option>`,
    ...listProviders().map(
      (provider) =>
        `<option value="${provider.id}">${escapeHtml(provider.label)}${
          provider.needsKey ? '（需 Key）' : ''
        }</option>`
    )
  ].join('');
  $('provider').innerHTML = options;
  $('testProvider').innerHTML = listProviders()
    .map((provider) => `<option value="${provider.id}">${escapeHtml(provider.label)}</option>`)
    .join('');
}

function renderFallbackList() {
  const others = listProviders();
  $('fallbackList').innerHTML = others
    .map(
      (provider) => `
      <label class="check">
        <input type="checkbox" data-fallback="${provider.id}" />
        <span>${escapeHtml(provider.label)}</span>
      </label>`
    )
    .join('');
}

/** 只渲染"当前主引擎 + 已配置 Key 的引擎"的表单，避免设置页过长 */
function renderProviderForms() {
  const interested = new Set([settings.provider, ...Object.keys(settings.providerConfig || {})]);
  const blocks = [];
  for (const preset of PRESETS) {
    if (!interested.has(preset.id) && preset.id !== settings.provider) continue;
    // 端上引擎的配置/下载在它自己的卡片里，这里不重复渲染表单
    if (preset.kind === 'on-device') continue;
    if (preset.module !== 'openai-compat' && preset.kind === 'free') continue;
    const config = settings.providerConfig?.[preset.id] ?? {};
    const rows = [];
    if (preset.module === 'openai-compat' || preset.id === 'custom') {
      rows.push(field('接口地址', `<input type="text" data-cfg="${preset.id}:endpoint" value="${escapeAttr(config.endpoint ?? preset.defaults.endpoint ?? '')}" placeholder="${escapeAttr(preset.defaults.endpoint || 'https://api.example.com/v1/chat/completions')}" />`));
      rows.push(field('模型名', `<input type="text" data-cfg="${preset.id}:model" value="${escapeAttr(config.model ?? preset.defaults.model ?? '')}" placeholder="${escapeAttr(preset.defaults.model || 'model-name')}" />`));
    }
    if (preset.needsKey) {
      rows.push(
        field(
          'API Key',
          `<div class="key-row">
             <input type="password" data-cfg="${preset.id}:apiKey" value="${escapeAttr(config.apiKey ?? '')}" placeholder="sk-..." autocomplete="off" />
             <button class="btn ghost" data-toggle-key="${preset.id}">显示</button>
           </div>`
        )
      );
    }
    if (preset.id === 'deepl') {
      rows.push(
        field('接口域名', `<input type="text" data-cfg="${preset.id}:endpoint" value="${escapeAttr(config.endpoint ?? preset.defaults.endpoint ?? '')}" placeholder="https://api-free.deepl.com" />`)
      );
    }
    if (preset.id === 'microsoft') {
      rows.push(field('区域（可选）', `<input type="text" data-cfg="${preset.id}:region" value="${escapeAttr(config.region ?? '')}" placeholder="留空即可" />`));
    }
    if (preset.module === 'openai-compat') {
      rows.push(
        field(
          '额外系统提示词（可选）',
          `<textarea rows="2" data-cfg="${preset.id}:systemPrompt" placeholder="例如：专有名词保留英文原文">${escapeHtml(config.systemPrompt ?? '')}</textarea>`
        )
      );
    }
    blocks.push(`
      <details class="provider-block" ${settings.provider === preset.id ? 'open' : ''} data-block="${preset.id}">
        <summary>${escapeHtml(preset.label)} <span class="tag">${PROVIDER_KIND_TAG[preset.kind] ?? '需 Key'}</span></summary>
        <p class="hint">${escapeHtml(preset.description)}${preset.docsUrl ? ` · <a href="${preset.docsUrl}" target="_blank" rel="noopener">获取方式</a>` : ''}</p>
        ${rows.join('')}
      </details>`);
  }
  $('providerForms').innerHTML = blocks.join('');
}

function field(label, control, hint) {
  return `<div class="field"><label>${escapeHtml(label)}</label>${control}${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}</div>`;
}

/* ------------------------------------------------------------------ *
 * 数据 → 表单
 * ------------------------------------------------------------------ */

function hydrate() {
  const map = {
    provider: 'value',
    displayMode: 'value',
    targetLang: 'value',
    sourceLang: 'value',
    bilingualColor: 'value',
    bilingualFontScale: 'value',
    minTextLength: 'value',
    maxNodeLength: 'value',
    concurrency: 'value',
    batchMaxChars: 'value',
    mutationDebounceMs: 'value',
    skipSelectors: 'value',
    onlySelectors: 'value',
    enabled: 'checked',
    autoTranslateOnLoad: 'checked',
    followDynamicContent: 'checked',
    translateOnSelection: 'checked',
    enableCache: 'checked',
    enableOnDevice: 'checked',
    debug: 'checked',
    markdownRendering: 'checked',
    originalTooltip: 'checked',
    showFloatingButton: 'checked',
    translatePlaceholder: 'checked',
    translateAriaLabel: 'checked',
    translateImageAlt: 'checked',
    translateTitle: 'checked',
    skipNoise: 'checked',
    translateShadowDom: 'checked',
    translateIframes: 'checked'
  };
  for (const [key, prop] of Object.entries(map)) {
    const el = $(key);
    if (!el) continue;
    if (key === 'skipSelectors' || key === 'onlySelectors') el.value = (settings[key] || []).join('\n');
    else el[prop] = settings[key];
  }
  $('fontScaleValue').textContent = `${Math.round(settings.bilingualFontScale * 100)}%`;
  for (const checkbox of document.querySelectorAll('[data-fallback]')) {
    checkbox.checked = (settings.fallbackProviders || []).includes(checkbox.dataset.fallback);
  }
  $('siteHost').value = currentHost || '';
  applySiteRule();
}

/* ------------------------------------------------------------------ *
 * 交互绑定
 * ------------------------------------------------------------------ */

function bindGlobalInputs() {
  const textKeys = [
    'minTextLength',
    'maxNodeLength',
    'concurrency',
    'batchMaxChars',
    'mutationDebounceMs'
  ];
  for (const key of textKeys) {
    $(key).addEventListener('change', () => patch({ [key]: Number($(key).value) }));
  }
  for (const key of [
    'enabled',
    'autoTranslateOnLoad',
    'followDynamicContent',
    'translateOnSelection',
    'enableCache',
    'debug',
    'markdownRendering',
    'originalTooltip',
    'showFloatingButton',
    'translatePlaceholder',
    'translateAriaLabel',
    'translateImageAlt',
    'translateTitle',
    'skipNoise',
    'translateShadowDom',
    'translateIframes'
  ]) {
    $(key).addEventListener('change', () => patch({ [key]: $(key).checked }));
  }
  $('displayMode').addEventListener('change', () => patch({ displayMode: $('displayMode').value }));
  $('enableOnDevice').addEventListener('change', () => {
    void patch({ enableOnDevice: $('enableOnDevice').checked }).then(() => refreshOnDeviceStatus());
  });
  $('targetLang').addEventListener('change', () => patch({ targetLang: $('targetLang').value }));
  $('sourceLang').addEventListener('change', () => patch({ sourceLang: $('sourceLang').value }));
  $('bilingualColor').addEventListener('change', () => patch({ bilingualColor: $('bilingualColor').value }));
  $('bilingualFontScale').addEventListener('input', () => {
    $('fontScaleValue').textContent = `${Math.round(Number($('bilingualFontScale').value) * 100)}%`;
  });
  $('bilingualFontScale').addEventListener('change', () =>
    patch({ bilingualFontScale: Number($('bilingualFontScale').value) })
  );
  for (const key of ['skipSelectors', 'onlySelectors']) {
    $(key).addEventListener('change', () =>
      patch({ [key]: $(key).value.split('\n').map((line) => line.trim()).filter(Boolean) })
    );
  }
}

function bindEngineInputs() {
  $('provider').addEventListener('change', () => {
    void patch({ provider: $('provider').value }).then(() => renderProviderForms());
  });

  $('fallbackList').addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-fallback]');
    if (!checkbox) return;
    const current = new Set(settings.fallbackProviders || []);
    if (checkbox.checked) current.add(checkbox.dataset.fallback);
    else current.delete(checkbox.dataset.fallback);
    void patch({ fallbackProviders: [...current] });
  });

  // provider 配置输入（事件委托，因为表单是动态渲染的）
  $('providerForms').addEventListener('change', (event) => {
    const input = event.target.closest('[data-cfg]');
    if (!input) return;
    const [providerId, key] = input.dataset.cfg.split(':');
    const value = key === 'temperature' ? Number(input.value) : input.value;
    const providerConfig = {
      ...settings.providerConfig,
      [providerId]: { ...(settings.providerConfig?.[providerId] ?? {}), [key]: value }
    };
    void patch({ providerConfig });
  });

  $('providerForms').addEventListener('click', (event) => {
    const button = event.target.closest('[data-toggle-key]');
    if (!button) return;
    const input = $('providerForms').querySelector(`[data-cfg="${button.dataset.toggleKey}:apiKey"]`);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? '隐藏' : '显示';
  });

  $('runTest').addEventListener('click', async () => {
    const providerId = $('testProvider').value;
    if (providerId === ON_DEVICE_PROVIDER_ID) {
      await probeOnDevice();
      return;
    }
    $('testResult').textContent = '测试中…';
    $('testResult').className = 'test-result';
    try {
      const response = await chrome.runtime.sendMessage({
        type: MSG.TEST_PROVIDER,
        providerId
      });
      const result = response?.result;
      if (result?.ok) {
        $('testResult').textContent = `成功：${result.message}（${result.ms ?? '?'}ms）`;
        $('testResult').className = 'test-result ok';
      } else {
        $('testResult').textContent = `失败：${result?.message ?? response?.error ?? '未知错误'}`;
        $('testResult').className = 'test-result bad';
      }
    } catch (error) {
      $('testResult').textContent = `失败：${error.message}`;
      $('testResult').className = 'test-result bad';
    }
  });

  $('probeOnDevice').addEventListener('click', () => void probeOnDevice());
  $('downloadOnDevice').addEventListener('click', () => void downloadOnDevicePack());
}

/* ------------------------------------------------------------------ *
 * Chrome 内置翻译（端上引擎）
 *
 * 这一段必须在设置页（有用户手势的页面上下文）里跑，不能交给 background：
 * Translator.create() 要求 transient activation，MV3 service worker 既没有
 * Translator 全局也没有手势。
 * ------------------------------------------------------------------ */

/** 探测用的源语言：只有显式指定了源语言才用它，否则试英语（最常见的原文） */
function probeSourceCandidates() {
  const explicit = settings.sourceLang && settings.sourceLang !== AUTO_DETECT ? [settings.sourceLang] : [];
  const target = toOnDeviceLang(settings.targetLang || 'zh-CN');
  const candidates = [...explicit, 'en', 'ja', 'fr', 'de'];
  const seen = new Set();
  return candidates
    .map((code) => normalizeOnDeviceLang(code))
    .filter((code) => {
      if (!code || code === 'auto' || code === target || seen.has(code)) return false;
      seen.add(code);
      return true;
    });
}

function setOnDeviceStatus(text, kind = '') {
  const el = $('onDeviceStatus');
  el.textContent = text;
  el.className = `test-result${kind ? ` ${kind}` : ''}`;
}

/** 把探测结果讲成人话，并顺带说明"现在到底走哪个引擎" */
function describeOnDeviceStatus(status, sourceLang, targetLang) {
  switch (status) {
    case 'unsupported':
      return { text: '当前浏览器不支持内置翻译（需 Chrome 138+ 桌面版），将使用下面的远端引擎。', kind: 'bad' };
    case 'available':
      return { text: `可用：${sourceLang} → ${targetLang}，翻译完全在本机完成。`, kind: 'ok' };
    case 'downloadable':
      return { text: `需要先下载 ${sourceLang} → ${targetLang} 的语言包，点"下载语言包"即可。`, kind: '' };
    case 'downloading':
      return { text: `语言包正在下载（${sourceLang} → ${targetLang}）…`, kind: '' };
    case 'unavailable':
      return { text: `该语言对在端上不可用（${sourceLang} → ${targetLang}），将自动使用远端引擎。`, kind: 'bad' };
    default:
      return { text: `未知状态：${status}`, kind: '' };
  }
}

async function refreshOnDeviceStatus() {
  if (!onDeviceSupported()) {
    setOnDeviceStatus('当前浏览器不支持内置翻译（需 Chrome 138+ 桌面版）', 'bad');
    return;
  }
  if (settings.enableOnDevice === false) {
    setOnDeviceStatus('已关闭：翻译将全部走远端引擎', '');
    return;
  }
  const targetLang = toOnDeviceLang(settings.targetLang || 'zh-CN');
  setOnDeviceStatus('检测中…');
  for (const sourceLang of probeSourceCandidates()) {
    let status;
    try {
      status = await probeAvailability({ sourceLang, targetLang });
    } catch (error) {
      setOnDeviceStatus(`检测失败：${error?.message ?? error}`, 'bad');
      return;
    }
    if (status === 'available' || status === 'downloadable' || status === 'downloading') {
      const described = describeOnDeviceStatus(status, sourceLang, targetLang);
      setOnDeviceStatus(described.text, described.kind);
      return;
    }
  }
  setOnDeviceStatus(`该语言对在端上不可用（目标 ${targetLang}），将自动使用远端引擎。`, 'bad');
}

async function probeOnDevice() {
  await refreshOnDeviceStatus();
  const text = $('onDeviceStatus').textContent;
  $('testResult').textContent = text;
  $('testResult').className = $('onDeviceStatus').className.replace('test-result', 'test-result').trim();
}

/** 主动下载语言包：必须在用户点击的这次任务里发起，否则没有 transient activation */
async function downloadOnDevicePack() {
  if (!onDeviceSupported()) {
    setOnDeviceStatus('当前浏览器不支持内置翻译（需 Chrome 138+ 桌面版）', 'bad');
    return;
  }
  const targetLang = toOnDeviceLang(settings.targetLang || 'zh-CN');
  const sourceLang = probeSourceCandidates()[0];
  if (!sourceLang) {
    setOnDeviceStatus(`无法确定源语言，请先在"显示方式"里指定原文语言。`, 'bad');
    return;
  }
  setOnDeviceStatus(`正在准备 ${sourceLang} → ${targetLang} 的语言包…`);
  try {
    await ensurePair({
      sourceLang,
      targetLang,
      onProgress: (percent) => {
        setOnDeviceStatus(percent > 0 ? `正在下载语言包 ${percent}%` : '正在下载语言包…');
      }
    });
    setOnDeviceStatus(`语言包就绪：${sourceLang} → ${targetLang} 现在可离线翻译。`, 'ok');
  } catch (error) {
    const hint =
      error?.code === 'not-allowed'
        ? '（浏览器要求由点击触发；请重新点击"下载语言包"，不要用脚本调用）'
        : '';
    setOnDeviceStatus(`下载失败：${error?.message ?? error}${hint}`, 'bad');
  }
}

function bindSiteInputs() {
  $('loadSite').addEventListener('click', () => void detectCurrentTab());
  $('siteHost').addEventListener('change', applySiteRule);
  for (const radio of document.querySelectorAll('input[name="siteMode"]')) {
    radio.addEventListener('change', () => {
      const host = $('siteHost').value.trim();
      if (!host) return;
      const next = { ...settings.siteMode };
      if (radio.value === 'auto') delete next[host];
      else next[host] = radio.value;
      void patch({ siteMode: next }).then(renderSiteRules);
    });
  }
  $('siteTargetLang').addEventListener('change', () => {
    const host = $('siteHost').value.trim();
    if (!host) return;
    const next = { ...settings.siteTargetLang };
    const value = $('siteTargetLang').value;
    if (!value) delete next[host];
    else next[host] = value;
    void patch({ siteTargetLang: next }).then(renderSiteRules);
  });
}

function bindStorageInputs() {
  $('refreshStats').addEventListener('click', () => void refreshStats());
  $('clearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: MSG.CACHE_CLEAR });
    setSaveStatus('缓存已清空');
    void refreshStats();
  });
  $('exportSettings').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `web-translator-settings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  $('importSettings').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      settings = mergeSettings(parsed);
      await chrome.runtime.sendMessage({ type: MSG.SET_SETTINGS, patch: settings });
      hydrate();
      renderProviderForms();
      setSaveStatus('已导入设置');
    } catch (error) {
      setSaveStatus(`导入失败：${error.message}`);
    } finally {
      $('importFile').value = '';
    }
  });
  $('resetSettings').addEventListener('click', async () => {
    settings = mergeSettings(null);
    await chrome.runtime.sendMessage({ type: MSG.SET_SETTINGS, patch: settings });
    hydrate();
    renderProviderForms();
    setSaveStatus('已恢复默认设置');
  });
  $('dismissWelcome').addEventListener('click', () => {
    $('welcomeBanner').hidden = true;
    try {
      localStorage.setItem('dsh-translator:welcome', '1');
    } catch {
      /* ignore */
    }
  });
}

/* ------------------------------------------------------------------ *
 * 站点规则渲染
 * ------------------------------------------------------------------ */

async function detectCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const url = new URL(tab.url);
      if (/^https?:$/.test(url.protocol)) {
        currentHost = url.hostname;
        $('siteHost').value = currentHost;
        applySiteRule();
      }
    }
  } catch {
    /* 无权限或非网页标签 */
  }
}

function applySiteRule() {
  const host = $('siteHost').value.trim();
  const mode = settings.siteMode?.[host] ?? 'auto';
  for (const radio of document.querySelectorAll('input[name="siteMode"]')) {
    radio.checked = radio.value === mode;
  }
  $('siteTargetLang').value = settings.siteTargetLang?.[host] ?? '';
}

function renderSiteRules() {
  const hosts = new Set([...Object.keys(settings.siteMode || {}), ...Object.keys(settings.siteTargetLang || {})]);
  if (hosts.size === 0) {
    $('siteRules').innerHTML = '<p class="hint">暂无站点专属规则。</p>';
    return;
  }
  $('siteRules').innerHTML = [...hosts]
    .map((host) => {
      const mode = settings.siteMode?.[host] ?? 'auto';
      const lang = settings.siteTargetLang?.[host];
      const label = mode === 'never' ? '永不翻译' : mode === 'always' ? '自动翻译' : '跟随全局';
      return `<div class="rule"><code>${escapeHtml(host)}</code><span>${label}${lang ? ` · ${escapeHtml(lang)}` : ''}</span>
        <button class="link" data-remove-site="${escapeAttr(host)}">移除</button></div>`;
    })
    .join('');
}

$('siteRules').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-site]');
  if (!button) return;
  const host = button.dataset.removeSite;
  const siteMode = { ...settings.siteMode };
  const siteTargetLang = { ...settings.siteTargetLang };
  delete siteMode[host];
  delete siteTargetLang[host];
  void patch({ siteMode, siteTargetLang }).then(() => {
    applySiteRule();
    renderSiteRules();
  });
});

/* ------------------------------------------------------------------ *
 * 保存与状态
 * ------------------------------------------------------------------ */

async function patch(partial) {
  settings = mergeSettings({ ...settings, ...partial });
  await chrome.runtime.sendMessage({ type: MSG.SET_SETTINGS, patch: partial });
  setSaveStatus('已保存');
}

function setSaveStatus(text) {
  const el = $('saveStatus');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(setSaveStatus.timer);
  setSaveStatus.timer = setTimeout(() => el.classList.remove('show'), 1800);
}

async function refreshStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.CACHE_STATS });
    const stats = response?.stats ?? {};
    $('cacheStats').textContent =
      `缓存 ${stats.entries ?? 0} 条 · 命中率 ${Math.round((stats.hitRate ?? 0) * 100)}% · ` +
      `请求 ${stats.requests ?? 0} 次 · 错误 ${stats.errors ?? 0} 次`;
  } catch {
    $('cacheStats').textContent = '无法读取缓存统计';
  }
}

function showWelcomeIfNeeded() {
  const params = new URLSearchParams(location.search);
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('dsh-translator:welcome') === '1';
  } catch {
    /* ignore */
  }
  if (params.get('welcome') === '1' && !dismissed) $('welcomeBanner').hidden = false;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text) {
  return escapeHtml(text);
}

void init();
