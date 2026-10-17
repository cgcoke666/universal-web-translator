/**
 * 打包器行为测试：重点验证**产物能真正执行**，而不只是语法正确。
 *
 * 为什么必须有这一层：
 *   真实事故——打包器早期把所有模块的依赖解构集中声明在 bundle 最顶部，
 *   语法检查、单元测试全绿，但 Chrome 加载 service worker 时报
 *   "Uncaught ReferenceError: Cannot access '__mod_constants_xxx' before initialization"。
 *   原因是模块 IIFE 里的函数声明被提升，在依赖模块初始化之前就被调用，撞上 const 的 TDZ。
 *   这类"跨模块初始化顺序"缺陷只有真正跑一遍产物才能发现，`new vm.Script()` 是抓不到的。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { bundleToScript, collectModules } from '../scripts/lib/bundler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];

/** 造一个临时模块目录，返回写入文件与打包的辅助函数 */
async function makeFixture(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bundler-'));
  tempDirs.push(dir);
  for (const [name, code] of Object.entries(files)) {
    await writeFile(path.join(dir, name), code, 'utf8');
  }
  return {
    dir,
    async bundle(entry) {
      const modules = await collectModules(path.join(dir, entry));
      return bundleToScript(modules);
    }
  };
}

/**
 * 执行产物并取出某个模块的导出。
 *
 * 注意不能在 bundle 之后用 `return __mod_x` 去取：模块变量是 IIFE 内部的 `const`，
 * 不会泄漏到外层作用域。正确做法是在最外层 IIFE 闭合前插一行探针，把它挂到 globalThis 上。
 */
function probeExports(bundle, entryIdPrefix) {
  const match = bundle.match(new RegExp(`const (${entryIdPrefix}\\w+) = \\(\\(\\) => \\{`));
  assert.ok(match, `产物里应存在入口模块 ${entryIdPrefix}*`);
  const id = match[1];
  // 在最外层 IIFE 的收尾处插入探针（末尾固定是 "})();"）
  const instrumented = bundle.replace(/\}\)\(\);\s*$/, `globalThis.__exports__ = ${id};\n})();`);
  const context = { globalThis: undefined };
  context.globalThis = context;
  vm.runInContext(instrumented, vm.createContext(context), { filename: 'bundle.js' });
  return context.__exports__;
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 跨模块初始化顺序（真实事故的回归测试）
 * ------------------------------------------------------------------ */

test('依赖在模块初始化阶段就被使用：不会撞上 TDZ（真实事故回归）', async () => {
  const fixture = await makeFixture({
    // dep 里的常量必须在本模块初始化时立刻可用
    'dep.js': `export const GREETING = 'hello';
export function shout(text) { return GREETING + ' ' + text; }`,
    // 关键：在一个立即执行的 IIFE 里调用依赖的函数。
    // 旧实现把 `const { shout } = __mod_dep;` 放在 __mod_entry 初始化之前，
    // 函数声明被提升后先于该 const 执行，于是抛
    // "Cannot access '__mod_dep_xxx' before initialization"。
    'entry.js': `import { shout, GREETING } from './dep.js';
const eager = (() => shout('world'))();
export const result = eager + '|' + GREETING;`
  });
  const bundle = await fixture.bundle('entry.js');
  let exports;
  assert.doesNotThrow(() => {
    exports = probeExports(bundle, '__mod_entry_');
  }, '模块初始化阶段不应抛 TDZ');
  assert.equal(exports.result, 'hello world|hello');
});

test('多个模块导入同一绑定：外层作用域只声明一次（重复声明会直接语法错误）', async () => {
  const fixture = await makeFixture({
    'shared.js': `export const normalizeText = (t) => String(t).trim();`,
    // 两个模块各自 import 同一个名字：旧实现会生成两条同名的 const 解构，
    // 属于同一个函数作用域 → "Identifier 'normalizeText' has already been declared"
    'a.js': `import { normalizeText } from './shared.js';
export const a = normalizeText('  a  ');`,
    'b.js': `import { normalizeText } from './shared.js';
export const b = normalizeText('  b  ');`,
    'entry.js': `import { a } from './a.js';
import { b } from './b.js';
export const out = a + b;`
  });
  const bundle = await fixture.bundle('entry.js');
  // 先确认产物本身是可解析的脚本（重复 const 会在这一步就失败）
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle.js' }), '产物必须是合法脚本');
  const occurrences = bundle.match(/const \{ normalizeText \} = /g) ?? [];
  assert.equal(occurrences.length, 1, `normalizeText 应只声明一次，实际 ${occurrences.length} 次`);
  assert.equal(probeExports(bundle, '__mod_entry_').out, 'ab');
});

test('行内 import 会让打包器明确报错，而不是静默产出坏产物', async () => {
  const fixture = await makeFixture({
    'dep.js': `export const value = 'v';`,
    // import 与 export 写在同一行：行锚定的 IMPORT_RE 匹配不到，
    // 旧实现会产出"带 import 的非法脚本 + 空导出对象"这种最糟糕的静默失败
    'entry.js': `import { value } from './dep.js'; export const out = value;`
  });
  await assert.rejects(() => fixture.bundle('entry.js'), /无法内联的 import/);
});

test('依赖解构位于模块 IIFE 内部，而不是集中在 bundle 顶部', async () => {
  const fixture = await makeFixture({
    'dep.js': `export const VALUE = 42;`,
    'entry.js': `import { VALUE } from './dep.js';
export const out = VALUE;`
  });
  const bundle = await fixture.bundle('entry.js');
  const depDeclaration = bundle.split('\n').find((line) => line.includes('const { VALUE }'));
  assert.ok(depDeclaration, '应生成 VALUE 的解构');
  // 关键断言：解构行有缩进，说明它在某个 IIFE 内部（顶层语句不会缩进）
  assert.match(depDeclaration, /^\s+/, '依赖解构必须缩进在模块 IIFE 内');
  // 并且它出现在依赖模块定义之后，而不是文件顶部
  assert.ok(
    bundle.indexOf('const __mod_dep') < bundle.indexOf(depDeclaration),
    '解构不能出现在依赖模块定义之前'
  );
});

test('依赖解构位于模块 IIFE 内部，而不是集中在 bundle 顶部', async () => {
  const fixture = await makeFixture({
    'dep.js': `export const VALUE = 42;`,
    'entry.js': `import { VALUE } from './dep.js';
export const out = VALUE;`
  });
  const bundle = await fixture.bundle('entry.js');
  const depDeclaration = bundle.split('\n').find((line) => line.includes('const { VALUE }'));
  assert.ok(depDeclaration, '应生成 VALUE 的解构');
  // 关键断言：解构行的缩进说明它在某个 IIFE 内部（顶层语句不会缩进）
  assert.match(depDeclaration, /^\s+/, '依赖解构必须缩进在模块 IIFE 内');
  // 并且它出现在 __mod_dep 定义之后，而不是文件顶部
  assert.ok(
    bundle.indexOf('const __mod_dep') < bundle.indexOf(depDeclaration),
    '解构不能出现在依赖模块定义之前'
  );
});

/* ------------------------------------------------------------------ *
 * 产物可执行性
 * ------------------------------------------------------------------ */

test('产物可执行：同一模块的重复 import 只声明一次，且导出可用', async () => {
  const fixture = await makeFixture({
    'a.js': `export const A = 'a';`,
    'b.js': `export const B = 'b';`,
    'entry.js': `import { A } from './a.js';
import { B } from './b.js';
import { A as A2 } from './a.js';
export const combined = A + B + A2;`
  });
  const bundle = await fixture.bundle('entry.js');
  // A 被导入了两次（一次改名），应产生两条不同的声明，而不是语法错误
  assert.equal(bundle.match(/const \{ A \} = /g)?.length, 1);
  assert.equal(bundle.match(/const \{ A: A2 \} = /g)?.length, 1);
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle.js' }));
  // a + b + a = 'aba'（第三个是 A 的别名，仍是同一个值）
  assert.equal(probeExports(bundle, '__mod_entry_').combined, 'aba');
});

test('产物可执行：命名空间导入与默认导入都能拿到正确的值', async () => {
  const fixture = await makeFixture({
    'dep.js': `export const named = 'N';
export default { kind: 'default' };`,
    'entry.js': `import def, * as ns from './dep.js';
export const out = ns.named + '|' + def.kind;`
  });
  const bundle = await fixture.bundle('entry.js');
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle.js' }));
  assert.equal(probeExports(bundle, '__mod_entry_').out, 'N|default');
});

test('循环依赖被明确拒绝，而不是产出坏代码', async () => {
  const fixture = await makeFixture({
    'a.js': `import { b } from './b.js';
export const a = b;`,
    'b.js': `import { a } from './a.js';
export const b = a;`
  });
  // 在收集阶段（collectModules 的 visit）就应抛错：
  // 打包器不支持循环依赖，早报比运行时炸好。
  // 注意必须用 async 包裹：collectModules 的递归里是同步 throw，
  // 直接传 () => fixture.bundle(...) 会在构造 Promise 之前就抛出，assert.rejects 接不住。
  await assert.rejects(async () => {
    await fixture.bundle('a.js');
  }, /循环依赖/);
});

/* ------------------------------------------------------------------ *
 * 真实入口产物：在本进程里真正跑一遍
 * ------------------------------------------------------------------ */

/** 把 dist 产物放进一个隔离上下文执行，捕获初始化期异常 */
function runDistBundle(code, context) {
  const sandbox = vm.createContext(context);
  return vm.runInContext(code, sandbox, { filename: 'dist-bundle.js' });
}

/** 最小 chrome 替身：产物初始化阶段会用到 runtime / storage / tabs 等 */
function makeChromeStub(overrides = {}) {
  const listeners = [];
  return {
    listeners,
    api: {
      runtime: {
        id: 'bundler-test',
        lastError: null,
        getManifest: () => ({ version: '0.0.0', manifest_version: 3 }),
        getURL: (p) => `chrome-extension://bundler-test/${p}`,
        sendMessage: async () => ({ ok: true, settings: {} }),
        onMessage: {
          addListener: (fn) => listeners.push(fn),
          removeListener() {}
        },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onSuspend: { addListener() {} },
        openOptionsPage() {}
      },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      contextMenus: { removeAll: (cb) => cb?.(), create() {}, onClicked: { addListener() {} } },
      tabs: { query: async () => [], sendMessage() {} },
      commands: { onCommand: { addListener() {} } },
      ...overrides
    }
  };
}

test('真实 background.js 能执行：不再抛 TDZ / 未定义引用', async () => {
  const code = await readFile(path.join(root, 'dist', 'background.js'), 'utf8');
  const stub = makeChromeStub();
  const context = {
    chrome: stub.api,
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
  context.globalThis = context;
  assert.doesNotThrow(() => runDistBundle(code, context), 'background.js 初始化不应抛异常');
  assert.ok(stub.listeners.length > 0, 'background 应注册 onMessage 监听器');
});

test('真实 content.js 能执行：模块初始化阶段不抛 TDZ', async () => {
  const code = await readFile(path.join(root, 'dist', 'content.js'), 'utf8');
  // 只让模块初始化跑完：body 为 null 会让 UI 挂载推迟到 DOMContentLoaded，
  // 避免测试里搭一整套 DOM。TDZ 缺陷发生在模块初始化阶段，这样已足够暴露。
  const documentStub = {
    readyState: 'loading',
    body: null,
    head: null,
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
  const stub = makeChromeStub();
  const context = {
    chrome: stub.api,
    document: documentStub,
    location: { href: 'https://example.com/article' },
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
  context.window = context;
  context.globalThis = context;
  context.window.top = context.window;
  context.window.self = context.window;
  context.window.innerWidth = 1000;
  context.window.innerHeight = 800;
  context.window.addEventListener = () => {};
  context.window.getSelection = () => ({ toString: () => '' });
  documentStub.defaultView = context.window;

  assert.doesNotThrow(() => runDistBundle(code, context), 'content.js 初始化不应抛异常');
  assert.equal(context.__DSH_TRANSLATOR_LOADED__, true, 'content script 应完成启动标记');
});
