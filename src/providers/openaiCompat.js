/**
 * OpenAI 兼容 Chat Completions provider。
 *
 * 一套代码覆盖：OpenAI、DeepSeek、Moonshot、通义/智谱的兼容端点、Ollama、
 * LM Studio、vLLM、one-api / new-api 等自建网关——只要它实现了
 * `POST {endpoint} {model, messages}` 并返回 `choices[0].message.content`。
 *
 * 批量策略（从稳到降级）：
 *   1. `markers`：把 N 条文本拼成 `<1> ...\n<2> ...`，要求模型原样带标记返回，
 *      解析后逐条对齐。小模型最容易稳定复现这种格式。
 *   2. `json`：要求返回 {"1": "...", "2": "..."}，兼容部分喜欢 JSON 的模型。
 *   3. 解析失败 → 拆成单条请求（最稳但最慢），单条仍失败则填 null。
 */

import { LANGUAGE_NAMES, normalizeLangFor } from '../shared/constants.js';
import { fetchWithTimeout } from '../shared/queue.js';
import {
  ProviderError,
  buildMarkerInstruction,
  errorFromResponse,
  extractJsonObject,
  formatMarkedSegments,
  parseMarkedSegments
} from './base.js';

export const meta = {
  id: 'openai-compat',
  label: 'OpenAI 兼容接口（OpenAI / DeepSeek / Ollama / 自建网关）',
  kind: 'key',
  needsKey: true,
  endpoints: [],
  note: '填 Base URL 或完整 chat/completions 地址。本地 Ollama 建议用 http://127.0.0.1:11434/v1/chat/completions。'
};

const DEFAULT_SYSTEM_PROMPT = [
  'You are a professional web page translator embedded in a browser extension.',
  'Translate faithfully and idiomatically, keeping the original tone and register.',
  'Never translate code identifiers, API names, file paths, URLs, e-mail addresses or placeholder tokens.',
  'Never add explanations, notes, disclaimers or quotes.'
].join(' ');

/** 把用户填的地址补成完整 chat/completions 端点 */
export function resolveEndpoint(providerConfig = {}) {
  let endpoint = (providerConfig.endpoint || '').trim().replace(/\/+$/, '');
  if (!endpoint) endpoint = 'https://api.openai.com/v1';
  if (/\/chat\/completions$/.test(endpoint)) return endpoint;
  if (/\/v1$/.test(endpoint)) return `${endpoint}/chat/completions`;
  if (/\/v1\/?$/.test(endpoint)) return `${endpoint.replace(/\/$/, '')}/chat/completions`;
  // 只填了域名：补 /v1/chat/completions
  if (!/\/v\d/.test(endpoint)) return `${endpoint}/v1/chat/completions`;
  return `${endpoint}/chat/completions`;
}

/**
 * @param {{segments: string[], targetLang: string, sourceLang?: string, config?: object, signal?: AbortSignal, timeoutMs?: number, mode?: 'auto'|'markers'|'json'|'single'}} request
 * @returns {Promise<Array<string|null>>}
 */
export async function translate(request) {
  const {
    segments,
    targetLang,
    sourceLang,
    config = {},
    signal,
    timeoutMs = 60000,
    mode = 'auto'
  } = request;
  if (segments.length === 0) return [];
  const endpoint = resolveEndpoint(config);
  const model = (config.model || '').trim();
  if (!model) {
    throw new ProviderError('[openai-compat] 未配置模型名（如 gpt-4o-mini / deepseek-chat / qwen2.5:7b）', {
      provider: 'openai-compat'
    });
  }
  const apiKey = (config.apiKey || '').trim();
  const forceSingle = segments.length === 1 || mode === 'single';
  if (forceSingle) {
    const text = await chat(endpoint, config, model, apiKey, buildSingleMessages(segments[0], targetLang, sourceLang, config), signal, timeoutMs, 1);
    return segments.map((segment, i) => (i === 0 ? text : null));
  }

  const wantedMode = mode === 'auto' ? 'markers' : mode;
  const first = await tryBatch(wantedMode, endpoint, config, model, apiKey, segments, targetLang, sourceLang, signal, timeoutMs);
  if (first && first.filter(Boolean).length === segments.length) return first;

  if (mode === 'auto' && wantedMode !== 'json') {
    const second = await tryBatch('json', endpoint, config, model, apiKey, segments, targetLang, sourceLang, signal, timeoutMs);
    if (second && second.filter(Boolean).length === segments.length) return second;
  }

  // 降级到逐条：慢但最可靠
  const out = [];
  let okCount = 0;
  for (const segment of segments) {
    try {
      const text = await chat(endpoint, config, model, apiKey, buildSingleMessages(segment, targetLang, sourceLang, config), signal, timeoutMs, 1);
      out.push(text);
      okCount += 1;
    } catch (error) {
      if (out.length === 0 && okCount === 0 && isFatal(error)) throw error;
      out.push(null);
    }
  }
  if (okCount === 0 && out.every((v) => v === null)) {
    throw new ProviderError('[openai-compat] 所有分段翻译失败，请检查模型名 / 网络 / 额度。', {
      provider: 'openai-compat'
    });
  }
  // 把前面批量失败的结果与逐条结果合并
  if (first || out.length === segments.length) {
    return out.map((value, i) => value ?? (first ? first[i] : null));
  }
  return out;
}

async function tryBatch(mode, endpoint, config, model, apiKey, segments, targetLang, sourceLang, signal, timeoutMs) {
  try {
    const messages = mode === 'json'
      ? buildJsonMessages(segments, targetLang, sourceLang, config)
      : buildMarkerMessages(segments, targetLang, sourceLang, config);
    const content = await chat(endpoint, config, model, apiKey, messages, signal, timeoutMs, segments.length);
    const parsed =
      mode === 'json' ? parseJsonSegments(content, segments.length) : parseMarkedSegments(content, segments.length);
    if (!parsed) return null;
    // 明显被截断的条目视为失败（译文长度不足原文 15%）
    return parsed.map((value, i) => sanitizeSegment(value, segments[i]));
  } catch (error) {
    if (isFatal(error) && error?.status && error.status !== 429) throw error;
    return null;
  }
}

function isFatal(error) {
  const status = error?.status ?? 0;
  return status === 401 || status === 403 || status === 402 || status === 400 || status === 404;
}

/**
 * 过滤模型常见的"越权输出"：整段解释、引号包裹、仅标记无内容等。
 * @param {string|null} value
 * @param {string} source
 */
export function sanitizeSegment(value, source) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  // 整段被引号或代码块包裹
  text = text.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim();
  if (/^".*"$/s.test(text) && text.length > 2) text = text.slice(1, -1).trim();
  if (!text) return null;
  // 译文短得不合理 → 视为截断
  const minRatio = 0.12;
  if (source.length > 20 && text.length < source.length * minRatio) return null;
  return text;
}

function buildMarkerMessages(segments, targetLang, sourceLang, config) {
  const target = LANGUAGE_NAMES[targetLang] ?? normalizeLangFor('openai-compat', targetLang);
  const source = sourceLang && sourceLang !== 'auto' ? LANGUAGE_NAMES[sourceLang] ?? sourceLang : '';
  return [
    { role: 'system', content: config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: `${buildMarkerInstruction(segments.length, target, source)}\n\n${formatMarkedSegments(segments)}` }
  ];
}

function buildJsonMessages(segments, targetLang, sourceLang, config) {
  const target = LANGUAGE_NAMES[targetLang] ?? normalizeLangFor('openai-compat', targetLang);
  const source = sourceLang && sourceLang !== 'auto' ? LANGUAGE_NAMES[sourceLang] ?? sourceLang : '';
  const payload = {};
  segments.forEach((text, i) => {
    payload[String(i + 1)] = text;
  });
  const instruction = [
    `Translate each value of the JSON object into ${target}.`,
    source ? `Source language: ${source}.` : '',
    'Return ONLY a JSON object with exactly the same keys, values replaced by the translation.',
    'Do not translate keys. Do not add keys. Do not wrap the JSON in markdown fences.'
  ]
    .filter(Boolean)
    .join(' ');
  return [
    { role: 'system', content: config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: `${instruction}\n\n${JSON.stringify(payload)}` }
  ];
}

function buildSingleMessages(text, targetLang, sourceLang, config) {
  const target = LANGUAGE_NAMES[targetLang] ?? normalizeLangFor('openai-compat', targetLang);
  const source = sourceLang && sourceLang !== 'auto' ? LANGUAGE_NAMES[sourceLang] ?? sourceLang : '';
  return [
    { role: 'system', content: config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Translate the following text into ${target}.${source ? ` Source language: ${source}.` : ''} Output only the translation.\n\n${text}`
    }
  ];
}

/**
 * @param {string} content
 * @param {number} count
 * @returns {Array<string|null> | null}
 */
export function parseJsonSegments(content, count) {
  const parsed = extractJsonObject(content);
  if (!parsed) return null;
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const value = parsed[String(i)];
    out.push(typeof value === 'string' ? value : null);
  }
  const hits = out.filter((v) => typeof v === 'string' && v.length > 0).length;
  if (hits === 0) return null;
  return out;
}

async function chat(endpoint, config, model, apiKey, messages, signal, timeoutMs, expectedCount) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    messages,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0,
    stream: false
  };
  // 让模型尽量只输出译文；部分网关不支持该字段，失败时会在下面兜底重试
  const useJsonMode = /json/i.test(config.responseFormat ?? '');
  if (useJsonMode) body.response_format = { type: 'json_object' };
  // 输出预算：给足空间，避免长段落被截断
  body.max_tokens = Math.min(8192, Math.max(256, Math.ceil(expectedCount * 220)));

  const response = await send(endpoint, config, apiKey, body, signal, timeoutMs);
  if (!response.ok) {
    const error = await errorFromResponse('openai-compat', response);
    // 某些本地服务不认 max_tokens / temperature，去掉后重试一次
    if (response.status === 400) {
      delete body.max_tokens;
      delete body.temperature;
      const retry = await send(endpoint, config, apiKey, body, signal, timeoutMs);
      if (retry.ok) return readContent(await retry.json());
      throw await errorFromResponse('openai-compat', retry);
    }
    throw error;
  }
  return readContent(await response.json());
}

async function send(endpoint, config, apiKey, body, signal, timeoutMs) {
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (config.extraHeaders && typeof config.extraHeaders === 'object') {
    for (const [k, v] of Object.entries(config.extraHeaders)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  return fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
    timeoutMs
  });
}

/** 兼容 OpenAI / Ollama / 部分网关的不同响应形状 */
export function readContent(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message ?? choice?.delta ?? {};
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  if (typeof content !== 'string' || !content.trim()) {
    // Ollama 原生 /api/chat
    if (typeof data?.message?.content === 'string') content = data.message.content;
    else if (typeof data?.response === 'string') content = data.response;
  }
  if (typeof content !== 'string') {
    throw new ProviderError('[openai-compat] 响应中没有可用的文本内容', { provider: 'openai-compat' });
  }
  return content.trim();
}

/** 设置页"测试连接" */
export async function selftest(config) {
  const started = Date.now();
  const out = await translate({
    segments: ['Hello, world. This is a connection test.'],
    targetLang: 'zh-CN',
    config,
    timeoutMs: 45000,
    mode: 'single'
  });
  return { ok: Boolean(out[0]), text: out[0] ?? '', ms: Date.now() - started };
}

export default { meta, translate, selftest };
