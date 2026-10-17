/**
 * 同进程测试运行器。
 *
 * 背景：`node --test test/` 会为每个测试文件 spawn 一个子进程，本机沙箱禁止 spawn，
 * 因此会直接 EPERM。这里改成在**同一个进程**里按顺序 import 每个测试文件，
 * 由 node:test 自己在进程内收集并运行用例。
 *
 * 用法：
 *   node scripts/test.mjs            运行 test/ 下所有 *.test.mjs
 *   node scripts/test.mjs lang       只运行文件名包含 lang 的测试
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');
const filter = process.argv[2] ?? '';

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(full)));
    } else if (entry.name.endsWith('.test.mjs')) {
      files.push(full);
    }
  }
  return files;
}

const files = (await collect(testDir))
  .filter((file) => (filter ? file.toLowerCase().includes(filter.toLowerCase()) : true))
  .sort();

if (files.length === 0) {
  console.error(filter ? `没有匹配 "${filter}" 的测试文件` : 'test/ 目录下没有 *.test.mjs');
  process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件（同进程模式）\n`);
const started = Date.now();
for (const file of files) {
  const rel = path.relative(root, file);
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    console.error(`\n✖ 加载失败：${rel}`);
    console.error(error);
    process.exitCode = 1;
  }
  console.log(`  · 已加载 ${rel}`);
}
console.log(`\n加载完成，用时 ${Date.now() - started}ms（用例结果由 node:test 汇总输出）`);
