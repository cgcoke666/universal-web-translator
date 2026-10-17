/**
 * 零依赖 PNG 编码器 + 图标生成。
 *
 * 为什么自己写：本机沙箱禁止 spawn 子进程，sharp / canvas / pngjs 这类库要么需要
 * 原生编译、要么需要 postinstall 脚本，都会 EPERM。PNG 的容器格式本身很简单，
 * 配合 Node 内置的 zlib 就能手写。
 *
 * 支持的编码能力：8bit RGBA、无隔行、单个 IDAT（zlib deflate）。
 */

import { deflateSync } from 'node:zlib';

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度必须为 width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA 数据长度不匹配：期望 ${width * height * 4}，实际 ${rgba.length}`);
  }
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * 绘制工具（不依赖 canvas，全部手算）
 * ------------------------------------------------------------------ */

export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  /** 以 alpha 混合方式画一个像素，坐标做 4x 超采样由调用方负责 */
  blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const sa = a;
    const da = this.data[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    this.data[i] = Math.round((r * sa + this.data[i] * da * (1 - sa)) / outA);
    this.data[i + 1] = Math.round((g * sa + this.data[i + 1] * da * (1 - sa)) / outA);
    this.data[i + 2] = Math.round((b * sa + this.data[i + 2] * da * (1 - sa)) / outA);
    this.data[i + 3] = Math.round(outA * 255);
  }

  /** 圆角矩形（圆角半径 r），fill 为 [r,g,b,a] */
  roundRect(x0, y0, x1, y1, r, fill) {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
        if (!insideRoundRect(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) continue;
        this.blend(x, y, fill[0], fill[1], fill[2], fill[3]);
      }
    }
  }

  /** 用参数化函数画形状：inside(px,py) 返回是否需要填色 */
  fillWhere(bounds, inside, fill) {
    const [x0, y0, x1, y1] = bounds;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        this.blend(x, y, fill[0], fill[1], fill[2], fill[3]);
      }
    }
  }
}

function insideRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/* ------------------------------------------------------------------ *
 * 品牌图标：圆角方块 + "文/A" 双语符号
 * ------------------------------------------------------------------ */

const BRAND = {
  bgTop: [79, 110, 247],
  bgBottom: [41, 66, 176],
  ink: [255, 255, 255]
};

/**
 * 生成 size×size 的品牌图标 RGBA。
 * 造型：渐变圆角方块 + 左侧中文"文"字横竖笔画的抽象化 + 右侧字母 A 的抽象三角形，
 * 全部用矩形/三角形基元拼出来，避免依赖字体渲染。
 * @param {number} size
 * @returns {Uint8Array}
 */
export function brandIcon(size) {
  const ss = 4; // 超采样倍数，让边缘平滑
  const S = size * ss;
  const canvas = new Canvas(S, S);
  const radius = S * 0.24;

  // 渐变底：竖直方向线性插值，直接写像素避免无谓的 alpha 混合
  for (let y = 0; y < S; y += 1) {
    const t = y / (S - 1);
    const r = Math.round(BRAND.bgTop[0] + (BRAND.bgBottom[0] - BRAND.bgTop[0]) * t);
    const g = Math.round(BRAND.bgTop[1] + (BRAND.bgBottom[1] - BRAND.bgTop[1]) * t);
    const b = Math.round(BRAND.bgTop[2] + (BRAND.bgBottom[2] - BRAND.bgTop[2]) * t);
    for (let x = 0; x < S; x += 1) {
      if (!insideRoundRect(x + 0.5, y + 0.5, S * 0.02, S * 0.02, S * 0.98, S * 0.98, radius)) continue;
      canvas.data[(y * S + x) * 4 + 0] = r;
      canvas.data[(y * S + x) * 4 + 1] = g;
      canvas.data[(y * S + x) * 4 + 2] = b;
      canvas.data[(y * S + x) * 4 + 3] = 255;
    }
  }

  const ink = [255, 255, 255, 1];

  // 左侧：三条横线 + 一条竖线（"文/A" 的抽象），右上方一个点
  const leftX0 = S * 0.16;
  const leftX1 = S * 0.46;
  const barH = S * 0.055;
  const bars = [0.24, 0.42, 0.6];
  for (const by of bars) {
    canvas.fillWhere(
      [leftX0, S * by, leftX1, S * by + barH],
      (px, py) => insideRoundRect(px, py, leftX0, S * by, leftX1, S * by + barH, barH / 2),
      ink
    );
  }
  const vx = (leftX0 + leftX1) / 2 - barH / 2;
  canvas.fillWhere(
    [vx, S * 0.24, vx + barH, S * 0.66],
    (px, py) => insideRoundRect(px, py, vx, S * 0.24, vx + barH, S * 0.66, barH / 2),
    ink
  );

  // 右侧：字母 A 的抽象三角 + 中横
  const apexX = S * 0.75;
  const apexY = S * 0.24;
  const footY = S * 0.78;
  const half = S * 0.19;
  const stroke = S * 0.075;
  const distToSegment = (px, py, ax, ay, bx, by) => {
    const vx2 = bx - ax;
    const vy2 = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const len2 = vx2 * vx2 + vy2 * vy2;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx2 + wy * vy2) / len2));
    const cx = ax + t * vx2;
    const cy = ay + t * vy2;
    return Math.hypot(px - cx, py - cy);
  };
  canvas.fillWhere(
    [apexX - half - stroke, apexY - stroke, apexX + half + stroke, footY + stroke],
    (px, py) =>
      distToSegment(px, py, apexX, apexY, apexX - half, footY) <= stroke / 2 ||
      distToSegment(px, py, apexX, apexY, apexX + half, footY) <= stroke / 2 ||
      distToSegment(px, py, apexX - half * 0.55, S * 0.6, apexX + half * 0.55, S * 0.6) <= stroke / 2,
    ink
  );

  return downscale(canvas.data, S, size, ss);
}

/** 盒式降采样，把超采样的画布缩回目标尺寸 */
function downscale(data, S, size, ss) {
  const out = new Uint8Array(size * size * 4);
  const area = ss * ss;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < ss; dy += 1) {
        for (let dx = 0; dx < ss; dx += 1) {
          const i = ((y * ss + dy) * S + (x * ss + dx)) * 4;
          const alpha = data[i + 3] / 255;
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / area) * 255);
    }
  }
  return out;
}
