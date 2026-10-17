/**
 * Provider 统一契约。
 *
 * 每个 provider 导出：
 *   id          唯一标识（设置里存的就是它）
 *   label       展示名
 *   kind        'free' | 'key' | 'local'，用于设置页分组与提示
 *   needsKey    是否需要 API Key
 *   endpoints   需要在 manifest host_permissions 中声明的来源
 *   translate() 实际翻译实现
 *
 * translate() 约定：
 *   - 入参 segments 是**已经按预算切好的一组短文本**（不是整篇文章），
 *     批量语义由各 provider 自己决定（query 重复参数 / JSON 数组 / 分隔符）；
 *   - 返回的数组长度必须与入参一致，顺序一一对应；
 *   - 单个分段翻译失败时填 null（调用方决定是否降级），整体失败才 throw。
 */

/** 统一错误对象 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, provider?: string, retryable?: boolean, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = info.status ?? 0;
    this.code = info.code ?? '';
    this.provider = info.provider ?? '';
    this.retryable = info.retryable ?? false;
    if (info.cause) this.cause = info.cause;
  }
}

/**
 * 把 Response 转成统一错误，并尽量抽取服务端错误信息。
 * @param {string} provider
 * @param {Response} response
 */
export async function errorFromResponse(provider, response) {
  let detail = '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        detail =
          json?.error?.message ??
          json?.message ??
          json?.error_description ??
          json?.error?.code ??
          text.slice(0, 300);
      } catch {
        detail = text.slice(0, 300);
      }
    }
  } catch {
    /* ignore */
  }
  const friendly = friendlyMessage(response.status, detail, provider);
  return new ProviderError(friendly, {
    status: response.status,
    provider,
    retryable: response.status === 429 || response.status >= 500 || response.status === 408
  });
}

function friendlyMessage(status, detail, provider) {
  const base = `[${provider}] HTTP ${status}`;
  switch (status) {
    case 401:
    case 403:
      return `${base}：认证失败，请检查 API Key / 令牌是否有效或已过期。${detail ? ` 详情：${detail}` : ''}`;
    case 402:
      return `${base}：额度不足（DeepL 免费额度用尽或账户欠费）。${detail ? ` 详情：${detail}` : ''}`;
    case 429:
      return `${base}：触发限流，已自动重试。可降低并发或在设置里更换引擎。${detail ? ` 详情：${detail}` : ''}`;
    case 456:
      return `${base}：DeepL 本月字符额度已用尽。`;
    case 400:
      return `${base}：请求参数被拒绝（常见于语言码不支持）。${detail ? ` 详情：${detail}` : ''}`;
    default:
      return `${base}${detail ? `：${detail}` : ''}`;
  }
}

/**
 * 从模型输出里抽出 JSON 对象。容忍 ```json 包裹、前后解释文字。
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
export function extractJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 构造"逐条对齐"的翻译指令。
 * 采用编号标记而不是 JSON：小模型更容易稳定复现标记，且解析失败可降级。
 * @param {number} count
 * @param {string} targetName 目标语言的人类可读名
 * @param {string} [sourceName]
 */
export function buildMarkerInstruction(count, targetName, sourceName) {
  if (count === 1) {
    return [
      `Translate the user's text into ${targetName}.`,
      sourceName ? `The source language is ${sourceName}.` : '',
      'Output ONLY the translation, no quotes, no explanation, keep the original line breaks.'
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `You are a translation engine. The user sends ${count} numbered segments.`,
    `Translate every segment into ${targetName}.`,
    sourceName ? `Source language: ${sourceName}.` : '',
    'Rules:',
    '1. Keep the exact segment markers like <1>, <2> at the start of each translated line.',
    '2. Output exactly one line per segment, same markers, same order, no merging, no omitting.',
    '3. Translate only; never answer, explain, summarize or add notes.',
    '4. Keep placeholders, numbers, code identifiers, URLs and HTML tags unchanged.',
    '5. Never add or remove line breaks other than the ones separating segments.'
  ]
    .filter(Boolean)
    .join('\n');
}

/** 把 segments 拼成带标记的输入 */
export function formatMarkedSegments(segments) {
  if (segments.length === 1) return segments[0];
  return segments.map((text, i) => `<${i + 1}> ${text}`).join('\n');
}

/**
 * 解析模型返回的带标记文本。
 *
 * 容错策略（真实模型非常不听话，这些情况天天出现）：
 *  - 整段包在 ``` 代码块里；
 *  - 标记被加粗：`**<1>** 你好`；
 *  - 开头多一句 "Here is the translation:"；
 *  - 段内本身有换行。
 *
 * 做法：先剥代码块，再用全局正则抓出所有 `<N>` 标记，把相邻标记之间的内容作为该段译文。
 * 前导解释文字（出现在第一个标记之前的）直接丢弃。
 *
 * @param {string} raw
 * @param {number} count
 * @returns {Array<string|null> | null} 解析不出任何标记时返回 null，交给上层降级
 */
export function parseMarkedSegments(raw, count) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).replace(/\r\n?/g, '\n').trim();
  if (!text) return null;

  const fence = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  if (count === 1) {
    const single = text.replace(/^(?:\*\*)?\s*<1>\s*(?:\*\*)?\s*/, '').trim();
    return single ? [single] : null;
  }

  const markerRe = /(?:\*\*)?\s*<(\d{1,3})>\s*(?:\*\*)?/g;
  /** @type {Array<{index: number, start: number}>} */
  const markers = [];
  let match;
  while ((match = markerRe.exec(text)) !== null) {
    markers.push({ index: Number(match[1]), start: match.index, contentStart: markerRe.lastIndex });
  }
  if (markers.length === 0) return null;

  /** @type {Map<number, string>} */
  const map = new Map();
  markers.forEach((marker, position) => {
    if (!Number.isInteger(marker.index) || marker.index < 1 || marker.index > count) return;
    const end = position + 1 < markers.length ? markers[position + 1].start : text.length;
    const body = text.slice(marker.contentStart, end).trim();
    if (map.has(marker.index)) {
      const previous = map.get(marker.index);
      map.set(marker.index, body ? `${previous}\n${body}` : previous);
    } else {
      map.set(marker.index, body);
    }
  });
  if (map.size === 0) return null;

  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const value = map.get(i);
    out.push(value === undefined || value === '' ? null : value);
  }
  return out;
}
