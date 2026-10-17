/**
 * DeepL（付费 / 免费额度）provider。
 *
 * 支持：
 *  - DeepL API Free（Key 以 `:fx` 结尾）→ api-free.deepl.com
 *  - DeepL API Pro → api.deepl.com
 *  - 目标语言必须显式：DeepL 不支持 target_lang=auto；源语言可省略（自动检测）
 *  - 一次请求可带多个 text 字段（最多 50 条），批处理能显著省额度
 *  - `tag_handling=html` 让 DeepL 自己保护标签，但我们传的是纯文本分片，因此默认关闭
 */

import { normalizeLangFor } from '../shared/constants.js';
import { fetchWithTimeout } from '../shared/queue.js';
import { ProviderError, errorFromResponse } from './base.js';

export const meta = {
  id: 'deepl',
  label: 'DeepL API（需 Key，质量最佳）',
  kind: 'key',
  needsKey: true,
  endpoints: ['https://api-free.deepl.com/v2/translate', 'https://api.deepl.com/v2/translate'],
  note: 'Key 以 :fx 结尾为免费版（每月 50 万字符）。中文需区分简繁：ZH / ZH-HANT。'
};

const MAX_TEXTS_PER_REQUEST = 50;

export function resolveEndpoint(providerConfig = {}) {
  const configured = (providerConfig.endpoint || '').trim().replace(/\/+$/, '');
  const key = (providerConfig.apiKey || '').trim();
  const isFreeKey = key.endsWith(':fx');
  const fallback = isFreeKey ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const host = configured || fallback;
  // 允许只填域名，自动补 /v2/translate
  return /\/v2\/translate$/.test(host) ? host : `${host}/v2/translate`;
}

/**
 * @param {{segments: string[], targetLang: string, sourceLang?: string, config?: {apiKey?: string, endpoint?: string}, signal?: AbortSignal, timeoutMs?: number}} request
 * @returns {Promise<Array<string|null>>}
 */
export async function translate(request) {
  const { segments, targetLang, sourceLang, config = {}, signal, timeoutMs = 25000 } = request;
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) {
    throw new ProviderError('[deepl] 未配置 API Key，请在设置页填写。', { provider: 'deepl', status: 401 });
  }
  if (segments.length === 0) return [];

  const endpoint = resolveEndpoint(config);
  /** @type {string[]} */
  const results = [];

  for (let offset = 0; offset < segments.length; offset += MAX_TEXTS_PER_REQUEST) {
    const slice = segments.slice(offset, offset + MAX_TEXTS_PER_REQUEST);
    const body = new URLSearchParams();
    for (const text of slice) body.append('text', text);
    body.set('target_lang', normalizeLangFor('deepl', targetLang));
    if (sourceLang && sourceLang !== 'auto') body.set('source_lang', normalizeLangFor('deepl', sourceLang));
    body.set('preserve_formatting', '1');
    body.set('split_sentences', '0'); // 我们自己已经切分好了，避免 DeepL 再切

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString(),
      signal,
      timeoutMs
    });

    if (!response.ok) throw await errorFromResponse('deepl', response);
    /** @type {{translations?: Array<{text?: string}>}} */
    const data = await response.json();
    const list = Array.isArray(data?.translations) ? data.translations : [];
    for (let i = 0; i < slice.length; i += 1) {
      const text = list[i]?.text;
      results.push(typeof text === 'string' ? text : null);
    }
  }

  return results;
}

/** 设置页"测试连接"用：翻译一句固定文本并返回耗时 */
export async function selftest(config) {
  const started = Date.now();
  const out = await translate({
    segments: ['Hello, world. This is a connection test.'],
    targetLang: 'zh-CN',
    config,
    timeoutMs: 15000
  });
  return { ok: Boolean(out[0]), text: out[0] ?? '', ms: Date.now() - started };
}

export default { meta, translate, selftest };
