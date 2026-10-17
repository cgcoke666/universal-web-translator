/**
 * Microsoft / Edge 免费翻译通道。
 *
 * 这是 Edge 浏览器内置"翻译"功能使用的同一条公开服务：
 *   1. 从 edge.microsoft.com/translate/auth 取一个短时效 JWT；
 *   2. 调 api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0 批量翻译。
 *
 * 令牌有寿命（约 10 分钟），需要在内存里缓存并做提前刷新；
 * 请求必须带 `X-ClientTraceId`（UUID），否则部分节点会拒绝。
 */

import { normalizeLangFor } from '../shared/constants.js';
import { ProviderError, errorFromResponse } from './base.js';
import { fetchWithTimeout } from '../shared/queue.js';

export const meta = {
  id: 'microsoft',
  label: 'Microsoft / Edge 翻译（免费通道，无需 Key）',
  kind: 'free',
  needsKey: false,
  endpoints: [
    'https://edge.microsoft.com/translate/auth',
    'https://api-edge.cognitive.microsofttranslator.com/translate'
  ],
  note: 'Edge 内置翻译所用通道，比 Google 免费通道更稳、单次可带多条文本，推荐作为首选或兜底。'
};

const AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const TRANSLATE_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&includeSentenceLength=false';

/** @type {{token: string, expiresAt: number} | null} */
let cachedToken = null;
/** 并发去重：多个批次同时到达时只取一次令牌 */
let tokenPromise = null;
/**
 * 授权端点失效后的冷却截止时间。
 *
 * 真实故障：`edge.microsoft.com/translate/auth` 已经返回 404（2025 年实测，
 * 加浏览器 UA 一样 404），说明微软确实把这个免费取令牌的端点下线了。
 * 不记冷却的话，每个批次都会白打一次请求、刷一条 404，整页翻译会被拖慢
 * 且日志全是噪音。冷却期内直接快速失败，让引擎链立刻落到下一个。
 *
 * 冷却而不是永久禁用：端点有可能恢复，10 分钟后重试一次成本很低。
 */
let authBlockedUntil = 0;
const AUTH_COOLDOWN_MS = 10 * 60 * 1000;

export function __resetTokenCache() {
  cachedToken = null;
  tokenPromise = null;
  authBlockedUntil = 0;
}

/** 授权端点是否处于"已知失效"的冷却期 */
export function isAuthCoolingDown(now = Date.now()) {
  return now < authBlockedUntil;
}

/**
 * 解析 JWT 的 exp 字段（不校验签名，只用于本地过期判断）。
 * 注意：service worker 里没有 Buffer / atob 也不保证存在，因此手写 base64url 解码。
 */
export function jwtExpiry(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return 0;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = base64Decode(padded);
    const json = JSON.parse(binary);
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 把 base64 解成字符串（JWT payload 通常是 ASCII/UTF-8 JSON）。
 * 用位累加的方式解码，不依赖 atob / Buffer —— service worker 里两者都不保证存在。
 * @param {string} input
 */
function base64Decode(input) {
  const lookup = new Map();
  for (let i = 0; i < B64_CHARS.length; i += 1) lookup.set(B64_CHARS[i], i);
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of String(input)) {
    const value = lookup.get(ch);
    if (value === undefined) continue; // '=' 与非法字符直接忽略
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
  }
  return bytes.map((byte) => String.fromCharCode(byte)).join('');
}

async function getToken(signal, timeoutMs) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const response = await fetchWithTimeout(AUTH_URL, {
      method: 'GET',
      credentials: 'omit',
      signal,
      timeoutMs
    });
    if (!response.ok) {
      const error = await errorFromResponse('microsoft', response);
      // 404 / 401 / 403 都说明授权端点本身不可用了（不是限流），进入冷却
      if (response.status === 404 || response.status === 401 || response.status === 403) {
        authBlockedUntil = Date.now() + AUTH_COOLDOWN_MS;
        throw new ProviderError(
          `[microsoft] 免费通道的授权接口已失效（HTTP ${response.status}），` +
            '已暂时跳过并改用其它引擎；如需高质量翻译请配置 DeepL / OpenAI，或使用内置翻译。',
          { provider: 'microsoft', status: response.status, retryable: false }
        );
      }
      throw error;
    }
    const token = (await response.text()).trim();
    if (!token || token.length < 20) {
      throw new ProviderError('[microsoft] 未能取得访问令牌，端点可能已变更', { provider: 'microsoft' });
    }
    const exp = jwtExpiry(token);
    cachedToken = { token, expiresAt: exp || now + 8 * 60 * 1000 };
    return token;
  })();

  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * @param {{segments: string[], targetLang: string, sourceLang?: string, region?: string, signal?: AbortSignal, timeoutMs?: number}} request
 * @returns {Promise<Array<string|null>>}
 */
export async function translate(request) {
  const { segments, targetLang, sourceLang, region, signal, timeoutMs = 20000 } = request;
  if (segments.length === 0) return [];

  // 已知授权端点失效：直接快速失败，不浪费一次网络往返
  if (isAuthCoolingDown()) {
    throw new ProviderError(
      '[microsoft] 免费通道的授权接口已失效，已暂时跳过；请使用内置翻译或配置其它引擎。',
      { provider: 'microsoft', retryable: false }
    );
  }

  const token = await getToken(signal, timeoutMs);
  const params = new URLSearchParams({ 'api-version': '3.0' });
  const to = normalizeLangFor('microsoft', targetLang);
  params.set('to', to);
  if (sourceLang && sourceLang !== 'auto') params.set('from', normalizeLangFor('microsoft', sourceLang));
  if (region) params.set('region', region);

  const body = segments.map((text) => ({ Text: text }));
  const response = await fetchWithTimeout(`${TRANSLATE_URL.split('?')[0]}?${params.toString()}`, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      'X-ClientTraceId': uuid(),
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body),
    signal,
    timeoutMs
  });

  if (!response.ok) {
    if (response.status === 401) cachedToken = null; // 令牌过期，下次重取
    throw await errorFromResponse('microsoft', response);
  }

  /** @type {Array<{translations?: Array<{text?: string}>}>} */
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new ProviderError('[microsoft] 响应格式异常', { provider: 'microsoft' });
  }
  return segments.map((_, i) => {
    const item = data[i];
    const text = item?.translations?.[0]?.text;
    return typeof text === 'string' ? text : null;
  });
}

export default { meta, translate };
