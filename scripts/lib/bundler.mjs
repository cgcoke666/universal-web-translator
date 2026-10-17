/**
 * 极简零依赖打包器。
 *
 * 背景：本机沙箱禁止 spawn 子进程（esbuild / rollup 的二进制或 worker 都会 EPERM），
 * 因此这里用纯 Node 实现一个"够用即可"的 ES Module → 单个经典脚本 打包器。
 *
 * 支持的语法子集（我们自己的代码只用到这些）：
 *   import { a, b as c } from './x.js';
 *   import Def from './x.js';
 *   import * as ns from './x.js';
 *   export const/let/function/class/async function ...
 *   export { a, b as c };            // 顶层导出汇总
 *   export default ...;
 *
 * 生成策略：
 *   1. 解析得到每个模块的 import/export 信息；
 *   2. 按依赖拓扑序（深度优先）拼接模块体；
 *   3. 顶层 `import { a } from './x.js'` → 重写成 `const { a } = __m_x;`（或重命名版）
 *      这样同一模块内不会出现重复绑定，也天然保留了 ESM 的绑定语义近似值；
 *   4. 所有导出挂到 `const __m_<id> = {}` 命名空间对象上；
 *   5. 最后按入口顺序吐出 IIFE。
 *
 * 局限（明确写下来，避免误用）：
 *   - 不支持循环依赖（我们的模块图是有向无环的，由 assertNoCycles 保证）；
 *   - 不支持 `export * from`；
 *   - 不做 tree shaking、不做压缩；
 *   - 不处理 `import(...)` 动态导入（后台 SW 走原生 ESM，不经过这里）。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const IMPORT_RE = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm;

/**
 * @typedef {object} ModuleInfo
 * @property {string} file 绝对路径
 * @property {string} id 唯一短 id（用于命名空间变量名）
 * @property {string} code 源码
 * @property {Array<{spec: string, local: string, imported: string, kind: 'named'|'default'|'namespace'}>} imports
 * @property {Array<{local: string, exported: string}>} exports
 * @property {string|null} defaultExport 默认导出的本地标识符
 */

/**
 * 从一个入口出发，深度优先收集全部模块并按依赖顺序返回。
 * @param {string} entry 绝对路径
 * @returns {Promise<ModuleInfo[]>}
 */
export async function collectModules(entry) {
  /** @type {Map<string, ModuleInfo>} */
  const byFile = new Map();
  /** @type {string[]} */
  const order = [];
  const visiting = new Set();

  async function visit(file) {
    const abs = path.resolve(file);
    if (byFile.has(abs)) return;
    if (visiting.has(abs)) {
      throw new Error(`检测到循环依赖：${abs}\n（打包器不支持循环依赖，请拆出共享模块）`);
    }
    visiting.add(abs);
    const code = await readFile(abs, 'utf8');
    const info = parseModule(abs, code);
    for (const imp of info.imports) {
      if (!imp.spec.startsWith('.')) {
        throw new Error(`${abs}: 打包器只支持相对路径导入，收到 "${imp.spec}"`);
      }
      await visit(path.resolve(path.dirname(abs), imp.spec));
    }
    visiting.delete(abs);
    byFile.set(abs, info);
    order.push(abs);
  }

  await visit(entry);
  return order.map((file) => byFile.get(file));
}

/**
 * 解析单个模块的 import/export。
 * @param {string} file
 * @param {string} code
 * @returns {ModuleInfo}
 */
export function parseModule(file, code) {
  /** @type {ModuleInfo['imports']} */
  const imports = [];
  /** @type {Array<{local: string, exported: string}>} */
  const exports = [];
  let defaultExport = null;

  // ---- import ----
  let transformed = code.replace(IMPORT_RE, (match, clause, spec) => {
    const trimmed = clause.trim();
    if (trimmed.startsWith('{')) {
      const inner = trimmed.replace(/^\{|\}$/g, '');
      for (const part of inner.split(',')) {
        const item = part.trim();
        if (!item) continue;
        const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        if (asMatch) imports.push({ spec, imported: asMatch[1], local: asMatch[2], kind: 'named' });
        else imports.push({ spec, imported: item, local: item, kind: 'named' });
      }
    } else if (trimmed.startsWith('*')) {
      const nsMatch = trimmed.match(/^\*\s+as\s+([\w$]+)$/);
      if (!nsMatch) throw new Error(`${file}: 无法解析 import 语句 "${clause}"`);
      imports.push({ spec, imported: '*', local: nsMatch[1], kind: 'namespace' });
    } else {
      // 可能是 default、default + named、default + namespace
      const [head, ...restParts] = trimmed.split(',');
      const local = head.trim();
      imports.push({ spec, imported: 'default', local, kind: 'default' });
      const rest = restParts.join(',').trim();
      if (rest.startsWith('{')) {
        const inner = rest.replace(/^\{|\}$/g, '');
        for (const part of inner.split(',')) {
          const item = part.trim();
          if (!item) continue;
          const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
          if (asMatch) imports.push({ spec, imported: asMatch[1], local: asMatch[2], kind: 'named' });
          else imports.push({ spec, imported: item, local: item, kind: 'named' });
        }
      } else if (rest.startsWith('*')) {
        const nsMatch = rest.match(/^\*\s+as\s+([\w$]+)$/);
        if (!nsMatch) throw new Error(`${file}: 无法解析 import 语句 "${clause}"`);
        imports.push({ spec, imported: '*', local: nsMatch[1], kind: 'namespace' });
      }
    }
    return '';
  });
  transformed = transformed.replace(BARE_IMPORT_RE, '');

  // ---- export default ----
  transformed = transformed.replace(/^[ \t]*export\s+default\s+/gm, () => {
    const name = `__default_${hashName(file)}`;
    defaultExport = name;
    // 包一层 const，避免 `export default function foo(){}` 这种带名声明被破坏
    return `const ${name} = `;
  });

  // ---- export { a, b as c } ----
  transformed = transformed.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (match, inner) => {
    for (const part of inner.split(',')) {
      const item = part.trim();
      if (!item) continue;
      const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (asMatch) exports.push({ local: asMatch[1], exported: asMatch[2] });
      else exports.push({ local: item, exported: item });
    }
    return '';
  });

  // ---- export const/let/var/function/class ----
  transformed = transformed.replace(
    /^[ \t]*export\s+(async\s+function|function|class|const|let|var)\s+([\w$]+)/gm,
    (match, kind, name) => {
      exports.push({ local: name, exported: name });
      return match.replace(/^([ \t]*)export\s+/, '$1');
    }
  );

  // 剩下的 export 关键字说明用了未支持的写法，早点报错比运行时炸掉好
  const leftover = transformed.match(/^[ \t]*export\s+.*$/m);
  if (leftover) {
    throw new Error(`${file}: 不支持的 export 写法 → ${leftover[0].trim()}`);
  }

  /**
   * 残留的 import 必须报错，不能放过去。
   *
   * 踩过的坑（真实事故）：IMPORT_RE 是行锚定的，遇到**行内 import**
   * （`import { x } from './y.js'; export const a = x;` 写在同一行）匹配不到，
   * 于是 import 语句原样留在产物里、依赖也没被收集进来，
   * 结果是"语法错误 + 导出对象是空的"这种最糟糕的静默失败：
   * 产物看起来生成了，浏览器里却整段报错。
   * 宁可在构建时明确失败，也不要产出坏代码。
   *
   * 判定必须严格：注释里出现 "import" 这个词（本项目里就有好几处）不能算。
   * 因此只认真正的 import 语法——带引号路径的裸导入，或带 from 子句的绑定导入。
   */
  const leftoverImport = transformed.match(
    /^.*\bimport\s*(?:\(\s*['"]|['"][^'"]+['"]|(?:[\w$*{][^\n]*?)\bfrom\s*['"])/m
  );
  if (leftoverImport) {
    throw new Error(
      `${file}: 存在无法内联的 import（请让 import 独占一行）→ ${leftoverImport[0].trim().slice(0, 120)}`
    );
  }

  return { file, id: hashName(file), code: transformed, imports, exports, defaultExport };
}

/** 生成合法的短标识符 */
function hashName(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '').replace(/[^\w$]/g, '_');
  let h = 0x811c9dc5;
  for (let i = 0; i < file.length; i += 1) {
    h ^= file.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${base}_${(h >>> 0).toString(36)}`;
}

/**
 * 把模块列表合成为一个经典脚本。
 *
 * 输出结构：
 *   const __mod_<hash> = (() => { ...模块体...; return { 导出名: 本地名, default: ... }; })();
 * 模块体内部用 `const { x } = __mod_<depHash>;` 引入依赖。
 * 每个模块有独立的 IIFE 作用域，因此不同模块里的同名变量（很常见，例如每个模块都
 * 会 import `normalizeText`）不会互相冲突。
 *
 * @param {ModuleInfo[]} modules 依赖序（被依赖者在前）
 * @param {{banner?: string}} [options]
 */
export function bundleToScript(modules, options = {}) {
  const byFile = new Map(modules.map((m) => [m.file, m]));
  const chunks = [];
  /**
   * 已被声明在外层 bundle 作用域里的绑定名。
   *
   * 依赖解构写在各模块 IIFE 的顶部，但**同一个绑定会被多个模块导入**
   * （例如 normalizeText 被 cache.js / pipeline.js / constants.js 同时用到），
   * 若每个模块都来一条 `const { normalizeText } = __mod_constants;`，
   * 它们属于同一个函数作用域，会直接抛
   * `SyntaxError: Identifier 'normalizeText' has already been declared`——
   * 整个脚本连解析都过不去。所以同名绑定只在第一次出现时声明。
   */
  const declaredOuter = new Set();

  for (const mod of modules) {
    /**
     * 依赖解构必须放在**本模块自己的 IIFE 内部**，不能提到最外层。
     *
     * 踩过的坑（真实事故）：早期版本把所有 `const { x } = __mod_dep;` 集中声明在
     * 整个 bundle 的最顶部，理由是"函数声明会提升，所以 __mod_* 解析阶段就可见"。
     * 这在只有函数声明时勉强成立，但一旦模块体里存在**函数调用**就会炸：
     *   const __mod_a = (() => { f(); function f(){ return CACHE_BUCKETS; } })();
     * 函数声明 `f` 被提升到该 IIFE 顶部，它在 __mod_a 初始化**之前**执行，
     * 而 `CACHE_BUCKETS` 来自最外层尚未初始化的 `const __mod_constants = ...`，
     * 于是抛 "Cannot access '__mod_constants_xxx' before initialization"（TDZ）。
     *
     * 放进 IIFE 内就安全了：modules 已按依赖拓扑序排列（被依赖者在前），
     * 轮到本模块执行时，它引用的每个 __mod_dep 都已完成了赋值。
     */
    const lines = [];
    for (const imp of mod.imports) {
      const dep = byFile.get(path.resolve(path.dirname(mod.file), imp.spec));
      if (!dep) throw new Error(`${mod.file}: 找不到依赖 ${imp.spec}`);
      const ns = `__mod_${dep.id}`;
      /** @type {string} */
      let declaration;
      if (imp.kind === 'namespace') {
        // 命名空间导入直接用模块对象本身
        declaration = `const ${imp.local} = ${ns};`;
      } else if (imp.kind === 'default') {
        declaration = `const ${imp.local} = ${ns}.default;`;
      } else {
        declaration = `const { ${
          imp.imported === imp.local ? imp.imported : `${imp.imported}: ${imp.local}`
        } } = ${ns};`;
      }
      // 同名绑定全 bundle 只声明一次（各模块 IIFE 共享同一个外层函数作用域）
      if (declaredOuter.has(imp.local)) continue;
      declaredOuter.add(imp.local);
      lines.push(`  ${declaration}`);
    }
    lines.push(`  const __mod_${mod.id} = (() => {`);
    lines.push(indent(mod.code.trimEnd()));
    lines.push(`    return { ${exportBindings(mod)} };`);
    lines.push('  })();');
    chunks.push(`/* ==== ${path.basename(mod.file)} ==== */\n${lines.join('\n')}`);
  }

  return [
    '/* 本文件由 scripts/build.mjs 自动生成，请勿直接修改。 */',
    options.banner ?? '',
    '(function () {',
    "'use strict';",
    ...chunks,
    '})();',
    ''
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/** 生成导出对象字面量的内容 */
function exportBindings(mod) {
  const list = mod.exports.map((e) => (e.local === e.exported ? e.local : `${e.exported}: ${e.local}`));
  if (mod.defaultExport) list.push(`default: ${mod.defaultExport}`);
  return list.join(', ');
}

function indent(code) {
  return code
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `  ${line}`))
    .join('\n');
}
