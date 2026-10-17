/**
 * 自检控制台逻辑（扩展页面，可直接访问扩展自身模块）。
 *
 * 前四步完全离线：不需要任何 Key、不产生任何网络请求，纯粹验证核心算法；
 * 第五步才真的调用翻译引擎，用来排查 Key/网络/配额问题。
 *
 * 之所以值得做这个页面：翻译扩展最麻烦的 bug（译文错位、漏翻、段落被拆碎）
 * 都发生在"采集 + 分段 + 回填"这三步，而它们在正常浏览时几乎不可见。
 */

import { MSG } from '../shared/constants.js';
import { detectLanguage, isProbablyCode, isTranslatableText } from '../shared/lang.js';
import { parseMarkedSegments, formatMarkedSegments, extractJsonObject } from '../providers/base.js';
import { decodeGoogleResponse } from '../providers/googleFree.js';
import { parseJsonSegments, resolveEndpoint } from '../providers/openaiCompat.js';
import { DomCollector } from '../content/collector.js';
import { segmentRecords, splitText, assembleTranslated } from '../content/segmenter.js';
import { TranslationRenderer } from '../content/renderer.js';
import { TranslationCache } from '../shared/cache.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * 0. 环境信息
 * ------------------------------------------------------------------ */

async function renderEnv() {
  const manifest = chrome.runtime.getManifest();
  let settings = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS });
    settings = response?.settings ?? null;
  } catch (error) {
    settings = null;
  }
  const rows = [
    ['扩展版本', manifest.version],
    ['Manifest', `v${manifest.manifest_version}`],
    ['Chrome/Edge', navigator.userAgent.match(/(?:Chrome|Edg)\/[\d.]+/)?.[0] ?? '未知'],
    ['当前引擎', settings?.provider ?? '（后台未响应）'],
    ['目标语言', settings?.targetLang ?? '-'],
    ['显示模式', settings?.displayMode ?? '-'],
    ['缓存', settings?.enableCache === false ? '已关闭' : '已启用'],
    ['IndexedDB', typeof indexedDB === 'undefined' ? '不可用' : '可用'],
    ['Shadow DOM', typeof Element !== 'undefined' && 'attachShadow' in Element.prototype ? '可用' : '不可用']
  ];
  $('env').innerHTML = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join('');
}

/* ------------------------------------------------------------------ *
 * 1. 固定装置：构造一个"像真实网站"的 DOM
 * ------------------------------------------------------------------ */

function buildFixture() {
  // Shadow DOM 组件
  const host = document.querySelector('#fixture my-card');
  if (host && !host.shadowRoot) {
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = 'p{color:#333}';
    const p = document.createElement('p');
    p.textContent = 'This text lives inside a shadow root and is usually invisible to naive scrapers.';
    const btn = document.createElement('button');
    btn.setAttribute('title', 'Close the dialog');
    btn.textContent = 'Close';
    shadow.append(style, p, btn);
  }
  // 动态插入内容（模拟无限滚动 / 懒加载）
  const slot = document.getElementById('dynamicSlot');
  if (slot && !slot.dataset.filled) {
    const p = document.createElement('p');
    p.textContent = 'This paragraph was injected after page load, simulating lazy-loaded content.';
    slot.appendChild(p);
    slot.dataset.filled = '1';
  }
  // 整段正文塞进一个文本节点（真实新闻站的常见形态）
  const longText = document.getElementById('longText');
  if (longText && !longText.dataset.filled) {
    longText.textContent =
      'Artificial intelligence is transforming how software is built. ' +
      'Engineers now delegate repetitive work to automated agents, which frees them to focus on design. ' +
      'However, generated code still requires careful review before it reaches production.';
    longText.dataset.filled = '1';
  }
}

/* ------------------------------------------------------------------ *
 * 2. 采集 + 分段分析
 * ------------------------------------------------------------------ */

function runCollect() {
  buildFixture();
  const started = performance.now();
  const collector = new DomCollector({
    skipSelectors: [],
    onlySelectors: $('onlyArticle').checked ? ['article'] : [],
    noiseSelectors: ['nav', 'footer', '.ad-banner'],
    skipNoise: $('skipNoise').checked,
    minTextLength: 2,
    maxNodeLength: 6000,
    translatePlaceholder: true,
    translateAriaLabel: true,
    translateImageAlt: true,
    translateTitle: true,
    translateShadowDom: true
  });

  // 只扫描固定装置，避免把控制台自己的文字也算进去
  const scope = document.getElementById('fixture');
  const records = collector.collect(scope);
  const collectMs = performance.now() - started;

  const pieces = segmentRecords(
    records.map((record) => ({ recordId: record.id, text: record.text, target: record.target })),
    { minTextLength: 2, batchMaxChars: 1200 }
  );

  // 回填验证：把分段拼回去，检查是否与原文逐字一致
  const roundTripIssues = [];
  const byRecord = new Map();
  for (const piece of pieces) {
    if (!byRecord.has(piece.recordId)) byRecord.set(piece.recordId, []);
    byRecord.get(piece.recordId).push(piece);
  }
  for (const record of records) {
    const list = byRecord.get(record.id) ?? [];
    if (list.length === 0) continue;
    for (const piece of list) {
      const slice = record.text.slice(piece.start, piece.end);
      if (slice.trim() !== piece.text.trim()) {
        roundTripIssues.push(`记录 #${record.id}: offset 与文本不匹配 → "${slice}" vs "${piece.text}"`);
      }
    }
    const joined = assembleTranslated(
      record.text,
      list.map((piece) => ({ start: piece.start, end: piece.end, text: `【${piece.text.length}】` }))
    );
    if (!joined.includes('【')) {
      roundTripIssues.push(`记录 #${record.id}: 回填结果异常`);
    }
  }

  const rows = records.slice(0, 40).map((record, index) => {
    const kind = record.target.kind === 'attr' ? `属性 ${record.target.attr}` : '文本';
    const piecesOfRecord = (byRecord.get(record.id) ?? []).length;
    const language = detectLanguage(record.text)?.code ?? '?';
    return `<tr>
      <td class="idx">${index + 1}</td>
      <td>${escapeHtml(kind)}</td>
      <td>${escapeHtml(language)}</td>
      <td>${piecesOfRecord}</td>
      <td>${escapeHtml(truncate(record.text, 90))}</td>
    </tr>`;
  });

  const summary = [
    `<div class="line-ok">✔ 采集 ${records.length} 个文本目标，用时 ${collectMs.toFixed(1)}ms</div>`,
    `<div class="line-ok">✔ 切分为 ${pieces.length} 个请求分段（平均 ${(pieces.reduce((sum, p) => sum + p.text.length, 0) / Math.max(1, pieces.length)).toFixed(0)} 字符/段）</div>`,
    roundTripIssues.length === 0
      ? '<div class="line-ok">✔ offset 回填校验通过：所有分段都能在原文中精确还原</div>'
      : `<div class="line-bad">✖ 回填校验发现 ${roundTripIssues.length} 个问题：\n${roundTripIssues.slice(0, 5).map(escapeHtml).join('\n')}</div>`,
    checkExpectations(records)
  ];

  $('collectOut').innerHTML = `${summary.join('')}
    <table>
      <thead><tr><th>#</th><th>类型</th><th>语言</th><th>分段数</th><th>内容</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    ${records.length > 40 ? `<div class="line-muted">仅显示前 40 条，共 ${records.length} 条。</div>` : ''}`;
}

/** 把"应该出现/不应该出现"的预期写成可读结论，一眼就能看出适配是否退化 */
function checkExpectations(records) {
  const all = records.map((record) => record.text);
  const has = (needle) => all.some((text) => text.includes(needle));
  const checks = [
    ['段落正文被采集', has('Shadow DOM lets you attach')],
    ['行内 code 未被采集', !has('querySelector')],
    ['pre 代码块未被采集', !has('attachShadow({ mode')],
    ['输入框 placeholder 被采集', records.some((r) => r.target.attr === 'placeholder')],
    ['图片/元素 title 被采集', records.some((r) => r.target.attr === 'title')],
    ['Shadow DOM 内的文本被采集', has('inside a shadow root')],
    ['动态插入的段落被采集', has('injected after page load')],
    ['广告区域是否被跳过', $('skipNoise').checked ? !has('Sponsored') : true],
    ['article 之外的文字是否被排除', $('onlyArticle').checked ? !has('Sponsored') : true]
  ];
  return checks
    .map(([label, pass]) => `<div class="${pass ? 'line-ok' : 'line-bad'}">${pass ? '✔' : '✖'} ${escapeHtml(label)}</div>`)
    .join('');
}

/* ------------------------------------------------------------------ *
 * 3. Provider 解析用例（离线）
 * ------------------------------------------------------------------ */

function runParse() {
  const cases = [
    {
      name: '标记协议：标准返回',
      expect: '["你好","世界"]',
      run: () => JSON.stringify(parseMarkedSegments('<1> 你好\n<2> 世界', 2))
    },
    {
      name: '标记协议：模型加粗标记并包代码块',
      expect: '["你好","世界"]',
      run: () => JSON.stringify(parseMarkedSegments('```\n**<1>** 你好\n**<2>** 世界\n```', 2))
    },
    {
      name: '标记协议：漏掉第 2 条 → null 占位',
      expect: '["甲",null,"丙"]',
      run: () => JSON.stringify(parseMarkedSegments('<1> 甲\n<3> 丙', 3))
    },
    {
      name: '标记协议：无标记输出 → 触发降级',
      expect: 'null',
      run: () => JSON.stringify(parseMarkedSegments('这是没有标记的译文', 3))
    },
    {
      name: 'JSON 协议：乱序键',
      expect: '["甲","乙"]',
      run: () => JSON.stringify(parseJsonSegments('{"2":"乙","1":"甲"}', 2))
    },
    {
      name: 'JSON 抽取：解释文字 + 代码块',
      expect: '{"1":"你好"}',
      run: () => JSON.stringify(extractJsonObject('好的：\n```json\n{"1":"你好"}\n```'))
    },
    {
      name: 'Google 响应：转义还原',
      expect: '[["你好"]]',
      run: () => JSON.stringify(decodeGoogleResponse('[["\\u4f60\\u597d"]]'))
    },
    {
      name: '端点归一化：只填域名',
      expect: 'https://api.openai.com/v1/chat/completions',
      run: () => resolveEndpoint({ endpoint: 'https://api.openai.com' })
    },
    {
      name: '端点归一化：已经是完整地址',
      expect: 'https://api.deepseek.com/v1/chat/completions',
      run: () => resolveEndpoint({ endpoint: 'https://api.deepseek.com/v1/chat/completions' })
    },
    {
      name: '分段标记拼装：多段',
      expect: '<1> a\n<2> b',
      run: () => formatMarkedSegments(['a', 'b'])
    },
    {
      name: '语言检测：英文长句',
      expect: 'en',
      run: () => detectLanguage('This is a long enough English sentence to detect.')?.code
    },
    {
      name: '语言检测：日文（含汉字）',
      expect: 'ja',
      run: () => detectLanguage('これは日本語のテストです。')?.code
    },
    {
      name: '代码识别：应拦住',
      expect: 'true',
      run: () => String(isProbablyCode('const x = () => 1;'))
    },
    {
      name: '代码识别：应放行',
      expect: 'false',
      run: () => String(isProbablyCode('Cloud computing enables on-demand delivery.'))
    },
    {
      name: '可翻译性：纯符号应拒绝',
      expect: 'false',
      run: () => String(isTranslatableText('+++ --- $$$', 2))
    },
    {
      name: '句子切分：中文无空格也能切开',
      expect: '3',
      run: () => String(splitText('第一句。第二句！第三句？').length)
    }
  ];

  const rows = cases.map((testCase) => {
    let actual;
    let error = null;
    try {
      actual = String(testCase.run());
    } catch (caught) {
      actual = `抛出异常：${caught.message}`;
      error = caught;
    }
    const pass = !error && actual === testCase.expect;
    return `<tr>
      <td>${pass ? '<span class="line-ok">✔</span>' : '<span class="line-bad">✖</span>'}</td>
      <td>${escapeHtml(testCase.name)}</td>
      <td>${escapeHtml(actual)}</td>
      <td class="line-muted">${escapeHtml(testCase.expect)}</td>
    </tr>`;
  });
  const failed = rows.filter((row) => row.includes('line-bad')).length;
  $('parseOut').innerHTML = `<div class="${failed === 0 ? 'line-ok' : 'line-bad'}">${
    failed === 0 ? `✔ ${cases.length} 个解析用例全部通过` : `✖ ${failed}/${cases.length} 个用例失败`
  }</div>
    <table>
      <thead><tr><th></th><th>用例</th><th>实际</th><th>期望</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

/* ------------------------------------------------------------------ *
 * 4. 缓存自检
 * ------------------------------------------------------------------ */

async function runCache() {
  const lines = [];
  const memoryOnly = new TranslationCache({ storage: null, maxMemory: 5 });
  try {
    memoryOnly.set('Hello world', 'zh-CN', '你好，世界');
    const hit = memoryOnly.get('Hello   world', 'zh-CN');
    lines.push(result(hit === '你好，世界', '空白折叠后命中同一缓存'));
    lines.push(result(memoryOnly.get('Hello world', 'ja') === undefined, '不同目标语言互不串味'));
    lines.push(result(memoryOnly.get('Nothing here', 'zh-CN') === undefined, '未缓存内容返回 undefined'));

    for (let i = 0; i < 20; i += 1) memoryOnly.set(`text-${i}`, 'zh-CN', `译文${i}`);
    lines.push(result(memoryOnly.memory.size <= 5, `LRU 上限生效（当前 ${memoryOnly.memory.size} 条）`));

    const stats = memoryOnly.stats();
    lines.push(
      `<div class="line-muted">命中 ${stats.hits} 次 / 未命中 ${stats.misses} 次 / 写入 ${stats.writes} 次 / 命中率 ${(stats.hitRate * 100).toFixed(1)}%</div>`
    );
  } catch (error) {
    lines.push(`<div class="line-bad">✖ 内存缓存异常：${escapeHtml(error.message)}</div>`);
  }

  if ($('offlineCache').checked) {
    try {
      const cache = new TranslationCache({ storage: chrome.storage.local });
      const marker = `自检-${Date.now()}`;
      cache.set(marker, 'zh-CN', '持久化测试译文');
      await cache.flushNow();
      const fresh = new TranslationCache({ storage: chrome.storage.local });
      await fresh.warmup();
      lines.push(result(fresh.get(marker, 'zh-CN') === '持久化测试译文', 'chrome.storage 持久化跨实例生效'));
      await cache.clear();
      const cleared = new TranslationCache({ storage: chrome.storage.local });
      await cleared.warmup();
      lines.push(result(cleared.get(marker, 'zh-CN') === undefined, 'clear 后持久层已清空'));
    } catch (error) {
      lines.push(`<div class="line-bad">✖ 持久化缓存异常：${escapeHtml(error.message)}</div>`);
    }
  }

  // 顺便验证渲染器能不能干干净净地还原
  try {
    const container = document.createElement('div');
    container.innerHTML = '<p>Hello <strong>bold</strong> world</p>';
    document.body.appendChild(container);
    const renderer = new TranslationRenderer({
      displayMode: 'bilingual',
      color: '#4b7bec',
      fontScale: 0.95,
      markdown: true,
      originalTooltip: true,
      showFlag: false
    });
    const before = container.innerHTML;
    for (const textNode of collectTextNodes(container)) {
      renderer.renderRecord({
        doc: document,
        record: { id: 1, text: textNode.nodeValue, target: { kind: 'text', node: textNode, element: textNode.parentElement, text: textNode.nodeValue } },
        translated: '【译文】'
      });
    }
    const inserted = renderer.size;
    renderer.clear();
    lines.push(result(inserted > 0, `渲染器插入了 ${inserted} 个译文节点`));
    lines.push(result(container.innerHTML === before, 'clear() 后 DOM 与原始 innerHTML 完全一致'));
    container.remove();
  } catch (error) {
    lines.push(`<div class="line-bad">✖ 渲染/还原异常：${escapeHtml(error.message)}</div>`);
  }

  $('cacheOut').innerHTML = lines.join('');
}

/** 收集元素下所有文本节点（自检用） */
function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.trim()) out.push(walker.currentNode);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. 真实翻译
 * ------------------------------------------------------------------ */

async function runLive() {
  const text = $('sample').value.trim();
  if (!text) {
    $('liveOut').textContent = '请先输入要翻译的文字。';
    return;
  }
  $('liveOut').innerHTML = '<div class="line-muted">请求中…</div>';
  const started = performance.now();
  try {
    const response = await chrome.runtime.sendMessage({
      type: MSG.TRANSLATE,
      segments: [text],
      force: true
    });
    const elapsed = Math.round(performance.now() - started);
    if (!response?.ok) throw new Error(response?.error || '后台返回失败');
    const result = response.result;
    const translated = result?.translations?.[0];
    const lines = [
      translated
        ? `<div class="line-ok">✔ 翻译成功（${elapsed}ms，引擎：${escapeHtml(result.provider)}）</div>`
        : `<div class="line-bad">✖ 未得到译文（${elapsed}ms）</div>`,
      translated ? `<div><strong>译文：</strong>${escapeHtml(translated)}</div>` : '',
      result?.errors?.length ? `<div class="line-bad">错误：${result.errors.map(escapeHtml).join('；')}</div>` : '',
      `<div class="line-muted">耗时明细：引擎处理 ${result?.elapsedMs ?? '?'}ms，缓存命中 ${result?.fromCache ?? 0} 条</div>`
    ];
    $('liveOut').innerHTML = lines.filter(Boolean).join('');
  } catch (error) {
    $('liveOut').innerHTML = `<div class="line-bad">✖ ${escapeHtml(error.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function result(pass, label) {
  return `<div class="${pass ? 'line-ok' : 'line-bad'}">${pass ? '✔' : '✖'} ${escapeHtml(label)}</div>`;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

$('runCollect').addEventListener('click', runCollect);
$('runParse').addEventListener('click', runParse);
$('runCache').addEventListener('click', () => void runCache());
$('runLive').addEventListener('click', () => void runLive());

buildFixture();
void renderEnv();
runParse();
