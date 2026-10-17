/**
 * 分段器：把采集到的长文本切成"适合翻译引擎的块"，同时记录每一块在原文中的精确位置。
 *
 * 为什么不能在文本节点边界直接翻译：
 *  1. 有些节点是整篇文章（例如 <div> 里一堆 <br> 形成的长文），一次发全文会超长且
 *     引擎容易漏译、截断；
 *  2. 逐节点翻又会丢掉句子上下文，质量明显下降；
 *  3. 我们还需要"只翻译可见部分"之外的**顺序稳定**，否则译文与原文对不上。
 *
 * 因此这里做三件事：
 *  - **切分**：按句末标点（中英混排都要覆盖）切句，超长句再按逗号/空格硬切；
 *  - **合并**：相邻的短句（如标题、按钮、列表项）合并进同一段，减少请求数量；
 *  - **定位**：记录每段的起止 offset，渲染时可精确回填，不受 reflow 影响。
 */

import { isTranslatableText } from '../shared/lang.js';

/** 单次硬切上限：超过这个长度的"句子"会在逗号/空格处继续切 */
const HARD_BREAK_LIMIT = 2200;

/**
 * 句末标点切分。
 *
 * 关键细节：中日韩标点（。！？…；）**后面不需要空格**，所以不能用"标点 + 后视空格"
 * 的方式识别——那样 "第一句。第二句" 会被当成一整句，整篇正文就变成一次巨型请求。
 * 因此对 CJK 标点直接断句；ASCII 标点则要求后面是空白/引号/结尾，避开缩写与小数。
 *
 * @param {string} text
 * @returns {number[]} 每个分句的结束 offset（不含后随空白）
 */
export function findSentenceBoundaries(text) {
  const boundaries = [];
  const isCjkPunct = (ch) => '。！？…；'.includes(ch);
  const isAsciiPunct = (ch) => '.!?;'.includes(ch);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    // 换行是最强的段落边界（<br>、多行列表项），优先断句
    if (ch === '\n') {
      boundaries.push(i + 1);
      continue;
    }
    if (isCjkPunct(ch)) {
      boundaries.push(i + 1);
      continue;
    }
    if (!isAsciiPunct(ch)) continue;
    // 小数（1.5）与英文缩写/域名（e.g. / example.com）不算句末
    if (ch === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(next ?? '')) continue;
    if (ch === '.' && /[A-Za-z]/.test(text[i - 1] ?? '') && next && /[A-Za-z0-9]/.test(next)) continue;
    if (next === undefined || /\s/.test(next) || /["'”’）)】」』\]]/.test(next)) boundaries.push(i + 1);
  }
  return boundaries;
}

/**
 * @typedef {object} Piece
 * @property {number} id            全局唯一分段 id
 * @property {number} recordId      所属采集记录
 * @property {string} text          待翻译文本
 * @property {number} start         在原文中的起始 offset
 * @property {number} end           结束 offset
 */

/**
 * @typedef {object} PieceInput
 * @property {number} recordId
 * @property {string} text
 * @property {{kind: 'text'|'attr'}} [target]
 */

/**
 * 把一批记录切成翻译分段。
 *
 * @param {PieceInput[]} records
 * @param {{minTextLength?: number, batchMaxChars?: number, mergeShortPieces?: boolean}} [options]
 * @returns {Piece[]}
 */
export function segmentRecords(records, options = {}) {
  const minTextLength = options.minTextLength ?? 2;
  const budget = options.batchMaxChars ?? 1200;
  const mergeShort = options.mergeShortPieces !== false;

  /** @type {Piece[]} */
  const pieces = [];
  let nextId = 0;

  for (const record of records) {
    const raw = record.text ?? '';
    if (!raw.trim()) continue;
    // 属性文本（placeholder / 按钮值）通常很短，整条作为一个分段，不做句子切分
    if (record.target?.kind === 'attr') {
      if (isTranslatableText(raw, minTextLength)) {
        nextId += 1;
        pieces.push({ id: nextId, recordId: record.recordId, text: raw, start: 0, end: raw.length });
      }
      continue;
    }
    for (const part of splitText(raw)) {
      if (!isTranslatableText(part.text, minTextLength)) continue;
      nextId += 1;
      pieces.push({ id: nextId, recordId: record.recordId, ...part });
    }
  }

  if (!mergeShort) return pieces;
  return mergePieces(pieces, budget, records);
}

/**
 * 纯函数切分：返回 [{text, start, end}]。
 *
 * 行为说明（这决定了译文能不能精确对回原文）：
 *  - 文本不长于 hardLimit 时，仍然**按句切分**。很多博客/新闻页面整段正文就是一个
 *    文本节点，如果不切，一次请求会带上整篇文章，引擎容易漏译、截断，
 *    而且合并预算（batchMaxChars）会失效；
 *  - 文本长于 hardLimit 时先按句分句，再对超长句按逗号/空格硬切；
 *  - 无论哪条路径，返回的 start/end 都能在原文中精确切回该片段。
 *
 * 不依赖 DOM，便于单元测试。
 * @param {string} text
 * @param {{hardLimit?: number, sentenceSplit?: boolean}} [options]
 */
export function splitText(text, options = {}) {
  const hardLimit = options.hardLimit ?? HARD_BREAK_LIMIT;
  const sentenceSplit = options.sentenceSplit !== false;
  /** @type {Array<{text: string, start: number, end: number}>} */
  const out = [];
  if (!text) return out;

  if (!sentenceSplit) {
    for (const piece of hardSplit(text, 0, text.length, hardLimit)) {
      const trimmed = trimRange(text, piece.start, piece.end);
      if (trimmed) out.push(trimmed);
    }
    return out;
  }

  // 按句末标点找出所有分句边界
  const boundaries = findSentenceBoundaries(text);
  if (boundaries.length === 0 || boundaries[boundaries.length - 1] !== text.length) {
    boundaries.push(text.length);
  }

  let cursor = 0;
  for (const boundary of boundaries) {
    if (boundary <= cursor) continue;
    // 单个句子超过 hardLimit 时再硬切
    for (const piece of hardSplit(text, cursor, boundary, hardLimit)) {
      const trimmed = trimRange(text, piece.start, piece.end);
      if (trimmed) out.push(trimmed);
    }
    cursor = boundary;
  }
  return out;
}

/** 在逗号/空格处把 [start, end) 切成不超过 limit 的片段 */
function hardSplit(text, start, end, limit) {
  /** @type {Array<{start: number, end: number}>} */
  const out = [];
  let cursor = start;
  while (cursor < end) {
    const remaining = end - cursor;
    if (remaining <= limit) {
      out.push({ start: cursor, end });
      break;
    }
    const window = text.slice(cursor, cursor + limit);
    // 优先在逗号 / 顿号 / 分号处断开，其次空格
    let cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('、'),
      window.lastIndexOf('：'),
      window.lastIndexOf(':')
    );
    if (cut < limit * 0.4) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.4) cut = window.length;
    out.push({ start: cursor, end: cursor + cut + 1 });
    cursor += cut + 1;
  }
  return out;
}

/** 收缩首尾空白但保持 offset 语义（返回的 text 已是 trim 后的内容） */
function trimRange(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  if (e <= s) return null;
  return { text: text.slice(s, e), start: s, end: e };
}

/**
 * 合并相邻短分段：同一记录内相邻、且合并后不超过预算的片段会被拼在一起。
 * 合并的好处是一次请求翻译多句，上下文更完整、请求数更少。
 * @param {Piece[]} pieces
 * @param {number} budget
 * @param {PieceInput[]} records
 */
export function mergePieces(pieces, budget, records) {
  const textOf = new Map(records.map((r) => [r.recordId, r.text ?? '']));
  /** @type {Piece[]} */
  const out = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    const source = textOf.get(piece.recordId) ?? '';
    const gap = prev ? source.slice(prev.end, piece.start) : '';
    const mergeable =
      prev &&
      prev.recordId === piece.recordId &&
      // 中间只有空白或单个空格时才能安全合并（否则会改变原文结构）
      /^[\s\u00a0]*$/.test(gap) &&
      prev.text.length + piece.text.length + 1 <= budget &&
      isPlainProse(prev.text) &&
      isPlainProse(piece.text);
    if (mergeable) {
      prev.text = `${prev.text} ${piece.text}`;
      prev.end = piece.end;
    } else {
      out.push({ ...piece });
    }
  }
  return out;
}

/** 含换行/列表符号/冒号的短标签不适合与前后文合并 */
function isPlainProse(text) {
  if (/[\n\r\t]/.test(text)) return false;
  if (/^[-•*·–—]\s*/.test(text)) return false;
  return true;
}

/**
 * 反向操作：把分段译文按 offset 回填到原文，得到完整译文。
 * 用于"仅译文模式"或片段翻译。
 * @param {string} original
 * @param {Array<{start: number, end: number, text: string}>} parts
 */
export function assembleTranslated(original, parts) {
  if (!parts || parts.length === 0) return original;
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const part of sorted) {
    if (part.start < cursor) continue;
    out += original.slice(cursor, part.start);
    out += part.text;
    cursor = part.end;
  }
  out += original.slice(cursor);
  return out;
}
