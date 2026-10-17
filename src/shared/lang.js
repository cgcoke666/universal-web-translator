/**
 * 纯函数语言工具：字符集直方图 + 停用词投票 → 语言推测。
 *
 * 用途：
 *  1. 判断"该文本是否已经是目标语言"，避免 zh→zh 这类无效请求；
 *  2. 给 Google / Edge 免费端点提供 `sl` 提示（传 auto 亦可，但显式更省一次往返）；
 *  3. 完全本地计算，无网络依赖，可直接在 Node 里单元测试。
 *
 * 注意：本文件是纯 JavaScript（工程不使用 TS 编译），不要写类型注解。
 */

import { normalizeText } from './constants.js';

const CJK_UNIFIED = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const HIRAGANA_KATAKANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/;
const CYRILLIC = /[\u0400-\u04ff]/;
const GREEK = /[\u0370-\u03ff]/;
const ARABIC = /[\u0600-\u06ff\u0750-\u077f]/;
const HEBREW = /[\u0590-\u05ff]/;
const THAI = /[\u0e00-\u0e7f]/;
const DEVANAGARI = /[\u0900-\u097f]/;
const LATIN = /[A-Za-z\u00c0-\u024f]/;
const LETTER = /\p{L}/u;
const PERSIAN_CHARS = /[\u067e\u0686\u0698\u06af\u06cc]/;

/** 拉丁语系停用词投票表：短样本下比单纯字符集更可靠 */
const STOPWORDS = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'with', 'this', 'are', 'be', 'as', 'on'],
  de: ['der', 'die', 'und', 'den', 'das', 'ist', 'nicht', 'mit', 'sich', 'auch', 'auf', 'ein', 'eine', 'von'],
  fr: ['le', 'la', 'les', 'des', 'est', 'une', 'que', 'pour', 'dans', 'sur', 'pas', 'avec', 'vous', 'nous'],
  es: ['el', 'la', 'los', 'las', 'que', 'de', 'en', 'un', 'una', 'por', 'con', 'para', 'este', 'como'],
  pt: ['que', 'de', 'em', 'um', 'uma', 'para', 'com', 'não', 'os', 'as', 'do', 'da', 'se', 'por'],
  it: ['il', 'lo', 'la', 'gli', 'che', 'di', 'un', 'una', 'per', 'con', 'non', 'sono', 'come', 'questo'],
  nl: ['de', 'het', 'een', 'van', 'en', 'dat', 'niet', 'voor', 'met', 'zijn', 'op', 'aan', 'ook', 'maar'],
  pl: ['nie', 'jest', 'się', 'oraz', 'dla', 'jak', 'ale', 'przez', 'tego', 'jego', 'tak', 'tylko'],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'olarak', 'daha', 'ancak', 'gibi', 'kadar', 'değil', 'çok'],
  id: ['dan', 'yang', 'untuk', 'dengan', 'ini', 'itu', 'tidak', 'dari', 'pada', 'adalah', 'akan', 'juga'],
  vi: ['và', 'của', 'các', 'không', 'được', 'trong', 'người', 'những', 'với', 'này', 'cho', 'một'],
  sv: ['och', 'att', 'det', 'som', 'för', 'med', 'inte', 'har', 'den', 'till', 'är', 'på']
};

/**
 * 推测文本语言。
 * @param {string} input
 * @returns {{code: string, hits: number, confidence: number} | null} null 表示无法判断
 */
export function detectLanguage(input) {
  const text = normalizeText(input);
  if (!text) return null;

  let han = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let greek = 0;
  let arabic = 0;
  let hebrew = 0;
  let thai = 0;
  let devanagari = 0;
  let latin = 0;
  let letters = 0;

  for (const ch of text) {
    if (CJK_UNIFIED.test(ch)) han += 1;
    else if (HIRAGANA_KATAKANA.test(ch)) kana += 1;
    else if (HANGUL.test(ch)) hangul += 1;
    else if (CYRILLIC.test(ch)) cyrillic += 1;
    else if (GREEK.test(ch)) greek += 1;
    else if (ARABIC.test(ch)) arabic += 1;
    else if (HEBREW.test(ch)) hebrew += 1;
    else if (THAI.test(ch)) thai += 1;
    else if (DEVANAGARI.test(ch)) devanagari += 1;
    else if (LATIN.test(ch)) latin += 1;
    if (LETTER.test(ch)) letters += 1;
  }

  /** @type {{code: string, hits: number, confidence: number}[]} */
  const candidates = [];
  const push = (code, hits) => {
    if (hits > 0) candidates.push({ code, hits, confidence: 0 });
  };

  if (kana > 0) {
    // 只要有假名就是日语（汉字混排也属日语）
    push('ja', kana + han);
  } else if (hangul > 0) {
    push('ko', hangul + (han > 0 ? han * 0.5 : 0));
  } else {
    push('zh', han);
    push('ru', cyrillic);
    push('el', greek);
    if (arabic > 0) push(PERSIAN_CHARS.test(text) ? 'fa' : 'ar', arabic);
    push('he', hebrew);
    push('th', thai);
    push('hi', devanagari);
  }

  if (latin > 0) {
    const vote = stopwordVote(text);
    if (vote) {
      candidates.push({ code: vote.code, hits: Math.max(latin * 0.4, vote.hits * 1.5), confidence: 0 });
    } else if (candidates.length === 0) {
      candidates.push({ code: 'en', hits: latin, confidence: 0 });
    }
  }

  if (candidates.length === 0 || letters === 0) return null;
  candidates.sort((a, b) => b.hits - a.hits);
  const top = candidates[0];
  const total = candidates.reduce((sum, c) => sum + c.hits, 0);
  top.confidence = total > 0 ? Math.min(1, top.hits / total) : 0;
  return top;
}

function stopwordVote(text) {
  const words = text.toLowerCase().match(/[\p{L}']+/gu);
  if (!words || words.length === 0) return null;
  let best = null;
  for (const [code, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    let hits = 0;
    for (const w of words) if (set.has(w)) hits += 1;
    if (hits > 0 && (!best || hits > best.hits)) best = { code, hits };
  }
  if (!best) return null;
  const ratio = best.hits / words.length;
  if (words.length >= 6 && ratio < 0.05) return null;
  return best;
}

/** 目标语言族：中简/中繁同族，其余按主标签归一 */
export function langFamily(code) {
  const lower = String(code || '').toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  return lower.split(/[-_]/)[0];
}

/**
 * 文本是否已经基本是目标语言。
 *
 * 注意"最少字符数"这道闸门：像"你好"这种 2 字中文，字符集判定的置信度是 1.0，
 * 但它同样可能只是页面里一个中文品牌名。要求至少 6 个字母/表意字符才敢断言
 * "这已经是目标语言"，否则一律送去翻译（宁可多一次请求，也不要漏翻）。
 */
export function isAlreadyTarget(text, targetLang) {
  const t = normalizeText(text);
  const letters = (t.match(/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  if (letters < 6) return false;
  const profile = detectLanguage(t);
  if (!profile) return false;
  return langFamily(profile.code) === langFamily(targetLang) && profile.confidence >= 0.5;
}

/** 是否值得送去翻译 */
export function isTranslatableText(text, minLength = 2) {
  const t = normalizeText(text);
  if (t.length < minLength) return false;
  if (!LETTER.test(t)) return false;
  if (isProbablyCode(t)) return false;
  return true;
}

const CODE_HINTS = /[{}<>;=]|=>|\b(function|const|let|var|return|import|export|class|def|public|private|static|void)\b/;

/** 代码 / 路径 / 版本号 / 标识符等不该翻译的片段 */
export function isProbablyCode(text) {
  const t = String(text).trim();
  if (t.length <= 3) return false;
  if (/^[\d\s.,:%+\-/()]+$/.test(t)) return false;
  if (/^(https?:\/\/|mailto:)/i.test(t)) return true;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return true;
  if (/^[/~.]?[\w.-]+(\/[\w.-]+){2,}\/?$/.test(t)) return true;
  if (/^v?\d+(\.\d+){1,3}([-+][\w.]+)?$/.test(t)) return true;
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(t)) return true;
  if (CODE_HINTS.test(t) && /[{}<>;=]/.test(t)) return true;

  const hasCjk = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(t);
  if (!hasCjk && !/\s/.test(t) && /[a-zA-Z]/.test(t)) {
    if (t.length > 20 && /[_$]/.test(t)) return true;
    if (/^[a-z]+[A-Z]/.test(t) && t.length > 8) return true;
  }
  return false;
}

/** 估算译文长度：CJK 目标通常收缩，拉丁目标通常膨胀，用于布局预警与预算计算 */
export function estimateTranslatedLength(text, targetLang) {
  const family = langFamily(targetLang);
  const cjkTarget = family === 'zh' || family === 'ja' || family === 'ko';
  const hasCjk = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(text);
  if (cjkTarget && !hasCjk) return Math.ceil(text.length * 0.6);
  if (!cjkTarget && hasCjk) return Math.ceil(text.length * 1.8);
  return text.length;
}
