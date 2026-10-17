/**
 * 打包发布产物：把 dist/ 压成可以直接分发的 zip。
 *
 * 用法：
 *   npm run pack            # 先构建再打包
 *   node scripts/pack.mjs   # 只打包现有的 dist/（CI 里通常已先构建）
 *
 * 产物：release/universal-web-translator-v<version>.zip
 *
 * 包里就是 dist/ 的内容，用户解压后直接在 Chrome 里"加载已解压的扩展程序"即可，
 * 不需要装 Node、不需要构建。GitHub Release 附件用的就是这个文件。
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');

/** 递归列出目录下的文件（相对路径，正斜杠，按字典序） */
async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {string[]} */
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function main() {
  const started = Date.now();

  /* ---------- 1. 读取版本号，并校验两个来源一致 ---------- */
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  if (pkg.version !== manifest.version) {
    throw new Error(
      `版本号不一致：package.json=${pkg.version}，manifest.json=${manifest.version}。请先统一版本再打包。`
    );
  }
  if (!manifest.default_locale || !manifest.manifest_version) {
    throw new Error('dist/manifest.json 看起来不完整，请先执行 node scripts/build.mjs');
  }

  /* ---------- 2. 收集 dist 内容 ---------- */
  const files = await listFiles(distDir);
  if (files.length === 0) throw new Error('dist/ 是空的，请先执行 node scripts/build.mjs');
  // 打包前挡住"把过期产物发出去"的最常见情况
  const required = ['manifest.json', 'background.js', 'content.js', 'content.css'];
  const missing = required.filter((name) => !files.includes(name));
  if (missing.length > 0) {
    throw new Error(`dist 缺少必要文件：${missing.join(', ')}（请重新执行构建）`);
  }

  /** @type {Array<{name: string, data: Buffer, mtime: Date}>} */
  const entries = [];
  let totalBytes = 0;
  for (const rel of files) {
    const full = path.join(distDir, rel);
    const data = await readFile(full);
    const info = await stat(full);
    totalBytes += data.length;
    entries.push({ name: rel, data, mtime: info.mtime });
  }

  /* ---------- 3. 写 zip ---------- */
  await mkdir(releaseDir, { recursive: true });
  const zipName = `universal-web-translator-v${manifest.version}.zip`;
  const zipPath = path.join(releaseDir, zipName);
  const zip = buildZip(entries);
  await writeFile(zipPath, zip);

  /* ---------- 4. 汇报 ---------- */
  console.log(`\n打包完成，用时 ${Date.now() - started}ms`);
  console.log(`产物：release/${zipName}`);
  console.log(`内容：${files.length} 个文件，原始 ${(totalBytes / 1024).toFixed(1)} KB → zip ${(zip.length / 1024).toFixed(1)} KB`);
  for (const name of files) console.log(`  ${name}`);
  console.log('\n用法：解压 zip → Chrome/Edge 扩展管理 → 开发者模式 → 加载已解压的扩展程序 → 选择解压出的目录');
  console.log('发布：把这个 zip 上传到 GitHub Release 即可（.github/workflows/release.yml 会自动做）。');
}

main().catch((error) => {
  console.error('\n打包失败：');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
