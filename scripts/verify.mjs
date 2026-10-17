/**
 * 产物校验：在**同一进程内**解析 dist/ 里每个脚本，并做一致性断言。
 *
 * 为什么自己写：本机沙箱禁止 spawn 子进程，`node --check` 与任何外部 linter
 * 都跑不起来。好在 Node 内置的 `node:vm` 可以直接编译源码——`new vm.Script(code)`
 * 会在不执行代码的前提下完成解析，语法错误会抛出 SyntaxError。
 *
 * 检查项：
 *  1. 经典脚本（background.js / content.js）可被解析为 Script；
 *  2. ESM 模块（页面与共享层）语法可解析——先剥掉 import/export 再解析，
 *     因为 vm.Script 不认模块语法，而语法错误本身与 import 位置无关；
 *  3. manifest.json 里引用的每个文件真实存在；
 *  4. 入口产物不应残留未内联的 import；
 *  5. 页面 ESM 的相对 import 都能在 dist 里找到目标。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

/** @type {string[]} */
const problems = [];
let parsedCount = 0;
let esmSkipped = 0;

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {string[]} */
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/* ---------- 1 & 2. 语法解析 ---------- */

/**
 * 把 ESM 源码"降级"成等价的可解析脚本：
 * 只移除 import/export 关键字本身，保留所有其它语法结构。
 * 目的仅仅是让 vm 能检查语法，不用于执行。
 * @param {string} code
 */
function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^\s*export\s+(async\s+function|function|class|const|let|var)\s+/gm, '$1 ');
}

const files = await listFiles(distDir);
for (const rel of files.filter((file) => file.endsWith('.js'))) {
  const code = await readFile(path.join(distDir, rel), 'utf8');
  const isEntry = rel === 'background.js' || rel === 'content.js';
  const source = isEntry ? code : stripModuleSyntax(code);
  try {
    // 只编译不执行：捕获语法错误，避免任何副作用
    new vm.Script(source, { filename: rel });
    parsedCount += 1;
    if (!isEntry) esmSkipped += 1;
  } catch (error) {
    problems.push(`语法错误 ${rel}：${error.message}`);
  }
}

/* ---------- 3. manifest 引用完整性 ---------- */

const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
const referenced = new Set();
for (const value of Object.values(manifest.icons ?? {})) referenced.add(value);
for (const value of Object.values(manifest.action?.default_icon ?? {})) referenced.add(value);
if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
if (manifest.options_ui?.page) referenced.add(manifest.options_ui.page);
if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
for (const entry of manifest.content_scripts ?? []) {
  for (const script of entry.js ?? []) referenced.add(script);
  for (const css of entry.css ?? []) referenced.add(css);
}
for (const entry of manifest.web_accessible_resources ?? []) {
  for (const resource of entry.resources ?? []) if (!resource.includes('*')) referenced.add(resource);
}

for (const rel of referenced) {
  if (!rel) continue;
  try {
    await stat(path.join(distDir, rel));
  } catch {
    problems.push(`manifest 引用了不存在的文件：${rel}`);
  }
}

/* ---------- 3b. 本地化（default_locale / _locales） ---------- */

/**
 * 这一项是"加载扩展直接失败"的常见原因，而语法检查与单元测试都发现不了：
 * manifest 一旦声明 `default_locale`，Chrome 在加载清单阶段就要求
 * `_locales/<default_locale>/messages.json` 存在，缺了会报
 * "Default localesubtree is missing" 并拒绝加载整个扩展。
 * 此外每个 `__MSG_key__` 都必须能在该文件里找到，否则加载同样失败。
 */
if (manifest.default_locale) {
  const localeFile = path.join(distDir, '_locales', manifest.default_locale, 'messages.json');
  let messages = null;
  try {
    messages = JSON.parse(await readFile(localeFile, 'utf8'));
  } catch {
    problems.push(
      `manifest 声明了 default_locale="${manifest.default_locale}"，但 ` +
        `_locales/${manifest.default_locale}/messages.json 缺失或不是合法 JSON`
    );
  }

  if (messages) {
    // 找出 manifest 里所有 __MSG_key__ 占位符
    const raw = await readFile(path.join(distDir, 'manifest.json'), 'utf8');
    const keys = new Set([...raw.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((match) => match[1]));
    for (const key of keys) {
      if (!messages[key] || typeof messages[key].message !== 'string') {
        problems.push(`manifest 用到 __MSG_${key}__，但 _locales/${manifest.default_locale}/messages.json 里没有该条目`);
      }
    }
    // 反向检查未使用的条目会让维护者困惑
    for (const key of Object.keys(messages)) {
      if (!keys.has(key)) problems.push(`_locales 里的 ${key} 没有被 manifest 引用（冗余条目）`);
    }
  }
}

/* ---------- 4. 入口产物不应残留裸 import ---------- */

for (const entry of ['background.js', 'content.js']) {
  const code = await readFile(path.join(distDir, entry), 'utf8');
  const bareImports = [...code.matchAll(/^\s*import\s.+from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  if (bareImports.length > 0) {
    problems.push(`${entry} 里仍有未内联的 import：${bareImports.join(', ')}`);
  }
  if (!code.includes("'use strict'")) {
    problems.push(`${entry} 缺少 'use strict'（打包器输出异常）`);
  }
}

/* ---------- 5. 页面 ESM 的相对引用 ---------- */

for (const rel of files.filter((file) => file.endsWith('.js') && file !== 'background.js' && file !== 'content.js')) {
  const full = path.join(distDir, rel);
  const code = await readFile(full, 'utf8');
  for (const match of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    try {
      await stat(path.resolve(path.dirname(full), match[1]));
    } catch {
      problems.push(`${rel} 引用了 dist 中不存在的模块：${match[1]}`);
    }
  }
}

/* ---------- 6. 入口产物必须能真正执行 ---------- */

/**
 * 为什么需要这一步：`new vm.Script()` 只做语法检查，之前正是它"全部通过"
 * 却让一个 TDZ 缺陷（跨模块初始化顺序）和一处重复 const 声明溜进了产物——
 * 前者语法完全合法，后者是解析错误但当时没有检查重复绑定。
 * 两个缺陷都只在**真正执行**时才会暴露，Chrome 里就是
 * "Service worker registration failed" 加上一堆 Uncaught ReferenceError。
 *
 * 这里用最小的宿主替身把两个入口跑一遍，只要能在初始化阶段不抛异常就算通过。
 */
function makeChromeStub() {
  return {
    runtime: {
      id: 'verify',
      lastError: null,
      getManifest: () => ({ version: '0.0.0', manifest_version: 3 }),
      getURL: (p) => `chrome-extension://verify/${p}`,
      sendMessage: async () => ({ ok: true, settings: {} }),
      onMessage: { addListener() {}, removeListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onSuspend: { addListener() {} },
      openOptionsPage() {}
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    contextMenus: { removeAll: (cb) => cb?.(), create() {}, onClicked: { addListener() {} } },
    tabs: { query: async () => [], sendMessage() {} },
    commands: { onCommand: { addListener() {} } }
  };
}

function makeDocumentStub(windowRef) {
  return {
    readyState: 'loading',
    body: null,
    head: null,
    defaultView: windowRef,
    documentElement: {
      classList: { add() {}, remove() {}, toggle() {} },
      style: { setProperty() {} },
      getBoundingClientRect: () => ({ width: 1000, height: 800 }),
      appendChild() {}
    },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} } }),
    createTextNode: () => ({}),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

for (const entry of ['background.js', 'content.js']) {
  const code = await readFile(path.join(distDir, entry), 'utf8');
  const context = {
    chrome: makeChromeStub(),
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    Promise,
    Date,
    Math,
    JSON,
    URL
  };
  if (entry === 'content.js') {
    context.location = { href: 'https://example.com/' };
    context.navigator = { userAgent: 'verify', clipboard: { writeText: async () => {} } };
    context.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    context.window = context;
    context.window.addEventListener = () => {};
    context.window.getSelection = () => ({ toString: () => '' });
    context.window.innerWidth = 1000;
    context.window.innerHeight = 800;
    context.window.top = context.window;
    context.window.self = context.window;
    context.document = makeDocumentStub(context.window);
  }
  context.globalThis = context;
  try {
    vm.runInContext(code, vm.createContext(context), { filename: entry });
  } catch (error) {
    problems.push(
      `${entry} 无法执行（构建产物在浏览器里会直接报错）：${error.name}: ${error.message}`
    );
  }
}

/* ---------- 结果 ---------- */

if (problems.length > 0) {
  console.error(`\n产物校验失败：`);
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  // 显式退出：执行检查可能已经让产物排了定时器/重试，不能等事件循环自然清空
  process.exit(1);
}
console.log(
  `✔ 产物校验通过：${parsedCount} 个脚本语法正常（其中 ${esmSkipped} 个模块按降级方式解析），` +
    `manifest 引用完整，页面模块可解析，两个入口可执行。`
);
/**
 * 显式 exit(0)。
 * content.js 的启动流程会在 800ms 后自动翻译，失败重试还会排新的定时器，
 * 所以不能指望事件循环自己排空——不显式退出的话，校验可能一直挂着不返回。
 * （顺带修掉的一个真实泄漏：client.js 的 withTimeout 原先在正常返回时
 *   不清理自己的 setTimeout，每发一条消息就留一个 90 秒的挂起定时器，
 *   正好把这里卡满 90 秒。）
 */
process.exit(0);
