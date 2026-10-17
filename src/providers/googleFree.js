/**
 * Google 免费通道。
 *
 * 两条端点按顺序尝试：
 *  1. clients5.google.com/translate_a/t  —— 支持 query 重复参数批量，响应是 JSON 数组；
 *  2. translate.googleapis.com/translate_a/single —— 经典 gtx 端点，单个 q，按句切分返回。
 *
 * 这两条都是公开 web 端点，无需 Key，但配额有限（高频会返回 429），
 * 因此调用前请通过 TaskQueue 限速。
 */

import { normalizeLangFor } from '../shared/constants.js';
import { fetchWithTimeout } from '../shared/queue.js';
import { ProviderError, errorFromResponse } from './base.js';

export const meta = {
  id: 'google-free',
  label: 'Google 翻译（免费通道，无需 Key）',
  kind: 'free',
  needsKey: false,
  endpoints: ['https://clients5.google.com/translate_a/t', 'https://translate.googleapis.com/translate_a/single'],
  note: '开箱即用。走公开 web 端点，配额有限，整页翻译建议并发 ≤ 3。'
};

/**
 * @param {{segments: string[], targetLang: string, sourceLang?: string, signal?: AbortSignal, timeoutMs?: number}} request
 * @returns {Promise<Array<string|null>>}
 */
export async function translate(request) {
  const { segments, targetLang, sourceLang, signal, timeoutMs = 20000 } = request;
  if (segments.length === 0) return [];
  const tl = normalizeLangFor('google-free', targetLang);
  const sl = sourceLang && sourceLang !== 'auto' ? normalizeLangFor('google-free', sourceLang) : 'auto';

  try {
    return await translateViaClients5({ segments, tl, sl, signal, timeoutMs });
  } catch (error) {
    if (segments.length > 1 && isFallbackWorthy(error)) {
      return translateViaGtxBatch({ segments, tl, sl, signal, timeoutMs });
    }
    throw error;
  }
}

function isFallbackWorthy(error) {
  const status = error?.status ?? 0;
  return status === 400 || status === 403 || status === 404 || status === 0;
}

async function translateViaClients5({ segments, tl, sl, signal, timeoutMs }) {
  const params = new URLSearchParams({ client: 'dict-chrome-ex' });
  params.set('sl', sl);
  params.set('tl', tl);
  for (const segment of segments) params.append('q', segment);

  const url = `https://clients5.google.com/translate_a/t?${params.toString()}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    credentials: 'omit',
    signal,
    timeoutMs
  });
  if (!response.ok) throw await errorFromResponse('google-free', response);

  const text = await response.text();
  const decoded = decodeGoogleResponse(text);
  if (!Array.isArray(decoded)) {
    throw new ProviderError('[google-free] 响应格式异常，可能端点已变更', { provider: 'google-free', status: 0 });
  }

  if (decoded.length === 1 && segments.length > 1) {
    // 某些客户端标识下只返回一条拼接结果，此时回退到 gtx 逐条
    return segments.map((_, i) => (i === 0 ? String(decoded[0] ?? '') : null));
  }
  // 逐条对齐；若服务端把多个 q 合并成多个句子，按索引尽量对齐
  return segments.map((segment, index) => {
    const value = decoded[index];
    if (typeof value === 'string') return unescapeGoogle(value);
    if (Array.isArray(value)) return unescapeGoogle(value.map((v) => (Array.isArray(v) ? v[0] : v)).join(''));
    return null;
  });
}

/**
 * 经典 gtx 端点：一次只发一个 q，但会用 \n 分段以提升上下文质量。
 */
async function translateViaGtxBatch({ segments, tl, sl, signal, timeoutMs }) {
  const joined = segments.join('\n');
  const params = new URLSearchParams({
    client: 'gtx',
    sl,
    tl,
    dt: 't',
    q: joined
  });
  const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const response = await fetchWithTimeout(url, { method: 'GET', credentials: 'omit', signal, timeoutMs });
  if (!response.ok) throw await errorFromResponse('google-free', response);

  const text = await response.text();
  const data = decodeGoogleResponse(text);
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new ProviderError('[google-free] 响应格式异常（gtx 端点）', { provider: 'google-free', status: 0 });
  }
  const translated = data[0]
    .map((part) => (Array.isArray(part) ? String(part[0] ?? '') : ''))
    .join('');
  const lines = translated.split('\n');
  if (lines.length === segments.length) return lines.map(unescapeGoogle);
  if (segments.length === 1) return [translated];
  return null;
}

/**
 * Google 返回的是非标准 JSON（含转义），需要先做字符还原再解析。
 * 单独取出解析逻辑便于在 Node 里单测。
 * @param {string} raw
 */
export function decodeGoogleResponse(raw) {
  const cleaned = unescapeGoogle(String(raw).trim().replace(/^\)\]\}'\s*/, ''));
  try {
    return JSON.parse(cleaned);
  } catch {
    // 兜底：把裸 \x 转义按 UTF-8 还原后再试一次
    try {
      return JSON.parse(cleaned.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => `\\u00${hex}`));
    } catch {
      return null;
    }
  }
}

/**
 * Google 会把 &quot; 之类的实体和 \u 转义直接塞进 JSON 字符串里。
 * @param {string} text
 */
export function unescapeGoogle(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export default { meta, translate };
