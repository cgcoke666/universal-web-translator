/**
 * 生成扩展图标（16/32/48/128）到 src/icons/。
 * 用法：node scripts/make-icons.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandIcon, encodePng } from './lib/png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'icons');
const SIZES = [16, 32, 48, 128];

await mkdir(outDir, { recursive: true });

for (const size of SIZES) {
  const rgba = brandIcon(size);
  const png = encodePng(size, size, rgba);
  const file = path.join(outDir, `icon${size}.png`);
  await writeFile(file, png);
  console.log(`✓ icons/icon${size}.png  ${png.length} bytes`);
}

console.log('图标生成完成。');
