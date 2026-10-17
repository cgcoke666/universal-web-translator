/**
 * 构建脚本：把 src/ 编译成可直接"加载已解压的扩展程序"的 dist/。
 *
 * 为什么不用 webpack/vite/esbuild：本机沙箱禁止 spawn 子进程，
 * 所有基于原生二进制的打包器都会 EPERM。因此改用 scripts/lib/bundler.mjs
 * 这个纯 JS 的极简打包器（支持我们代码用到的 ESM 子集）。
 *
 * 产物说明：
 *  - dist/background.js : service worker，单个经典脚本（无需原生 ESM，兼容性最好）
 *  - dist/content.js    : content script，单个经典脚本
 *  - dist/options、dist/popup : 页面 ESM（运行时由浏览器原生 import 共享模块）
 *  - dist/icons、dist/manifest.json、dist/content.css
 */

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleToScript, collectModules } from './lib/bundler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

async function main() {
  const started = Date.now();
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  /* ---------- 1. 两个入口打成经典脚本 ---------- */
  await buildEntry('src/background/index.js', 'dist/background.js', 'service worker');
  await buildEntry('src/content/index.js', 'dist/content.js', 'content script');

  /* ---------- 2. 复制静态资源 ---------- */
  await cp(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  await cp(path.join(srcDir, 'icons'), path.join(distDir, 'icons'), { recursive: true });
  await cp(path.join(srcDir, 'content', 'content.css'), path.join(distDir, 'content.css'));
  /**
   * _locales 必须一起复制。
   * manifest 里声明了 default_locale，Chrome 在**加载清单阶段**就会校验
   * _locales/<locale>/messages.json 是否存在；缺了会报
   * "Default locale was specified, but _locales subtree is missing"，
   * 直接拒绝加载整个扩展——连"加载已解压的扩展程序"这一步都过不去。
   */
  await cp(path.join(srcDir, '_locales'), path.join(distDir, '_locales'), { recursive: true });

  // 页面目录 + 它们通过原生 ESM 直接引用的共享模块（浏览器运行时按原路径解析）
  const dirsToCopy = ['options', 'popup', 'debug', 'shared', 'providers', 'content'];
  for (const dir of dirsToCopy) {
    await cp(path.join(srcDir, dir), path.join(distDir, dir), { recursive: true });
  }
  // 自检页要 import content/ 下的模块，但 content.js / content.css 的"正品"在 dist 根目录，
  // 复制进来的副本属于冗余产物，删掉以免混淆（也避免体积翻倍）。
  for (const redundant of ['content.js', 'content.css', 'env.js', 'client.js', 'index.js', 'observer.js', 'ui.js']) {
    await rm(path.join(distDir, 'content', redundant), { force: true });
  }

  /* ---------- 3. 校验页面依赖的共享模块路径可解析 ---------- */
  await verifyPageImports();

  const files = await listFiles(distDir);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.log(`\n构建完成，用时 ${Date.now() - started}ms`);
  console.log(`产物：${files.length} 个文件，共 ${(totalBytes / 1024).toFixed(1)} KB`);
  for (const file of files) {
    console.log(`  ${file.path.padEnd(28)} ${(file.size / 1024).toFixed(1)} KB`);
  }
  console.log('\n加载方式：Edge/Chrome → 扩展管理 → 打开"开发人员模式" → 加载已解压的扩展程序 → 选择 dist 目录');
}

/**
 * @param {string} entryRel
 * @param {string} outRel
 * @param {string} label
 */
async function buildEntry(entryRel, outRel, label) {
  const entry = path.join(root, entryRel);
  const modules = await collectModules(entry);
  const script = bundleToScript(modules, {
    banner: `/* ${label} bundle · modules: ${modules.map((m) => path.basename(m.file)).join(', ')} */`
  });
  const outPath = path.join(root, outRel);
  await writeFile(outPath, script, 'utf8');
  const size = (await readFile(outPath)).length;
  console.log(`✓ ${outRel}  ${modules.length} 个模块 · ${(size / 1024).toFixed(1)} KB`);
}

/** 页面（options/popup）用原生 ESM，用到 ../shared/*.js 与 ../providers/*.js，构建后必须仍然存在 */
async function verifyPageImports() {
  const pages = ['options/options.js', 'popup/popup.js'];
  const missing = [];
  for (const page of pages) {
    const file = path.join(distDir, page);
    const code = await readFile(file, 'utf8');
    const specs = [...code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      const target = path.resolve(path.dirname(file), spec);
      try {
        await readFile(target, 'utf8');
      } catch {
        missing.push(`${page} → ${spec}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `页面引用的模块在 dist 中缺失：\n  ${missing.join('\n  ')}\n` +
        '请在构建脚本里把对应目录复制到 dist（shared/ 与 providers/ 目前由 options、popup 直接引用）。'
    );
  }
}

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {Array<{path: string, size: number}>} */
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full, rel)));
    } else {
      const { size } = await stat(full);
      out.push({ path: rel, size });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

main().catch((error) => {
  console.error('\n构建失败：');
  console.error(error);
  process.exit(1);
});
