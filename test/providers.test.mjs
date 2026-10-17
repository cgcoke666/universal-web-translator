/**
 * Provider 解析与容错单测。
 *
 * 这些用例对应真实世界里最容易翻车的三点：
 *  1. 模型不按格式返回（漏标记、合并行、包 markdown 代码块）；
 *  2. 免费端点返回非标准 JSON（Google 的 \x 转义）；
 *  3. 用户填的接口地址形态各异（带不带 /v1、带不带 /chat/completions）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarkerInstruction,
  errorFromResponse,
  extractJsonObject,
  formatMarkedSegments,
  parseMarkedSegments
} from '../src/providers/base.js';
import { decodeGoogleResponse, unescapeGoogle } from '../src/providers/googleFree.js';
import { AUTO_CHAIN, isConfigured, listProviders, getModule, resolveChain } from '../src/providers/index.js';
import {
  translate as microsoftTranslate,
  __resetTokenCache,
  isAuthCoolingDown,
  jwtExpiry
} from '../src/providers/microsoft.js';
import { parseJsonSegments, readContent, resolveEndpoint, sanitizeSegment } from '../src/providers/openaiCompat.js';
import { normalizeLangFor } from '../src/shared/constants.js';

/* ------------------------------------------------------------------ *
 * 标记协议
 * ------------------------------------------------------------------ */

test('formatMarkedSegments：单段不加标记，多段加编号', () => {
  assert.equal(formatMarkedSegments(['only one']), 'only one');
  assert.equal(formatMarkedSegments(['a', 'b']), '<1> a\n<2> b');
});

test('parseMarkedSegments：正常返回能逐条对齐', () => {
  const raw = '<1> 你好\n<2> 世界';
  assert.deepEqual(parseMarkedSegments(raw, 2), ['你好', '世界']);
});

test('parseMarkedSegments：容忍模型在标记前写字、加粗标记、包代码块', () => {
  const raw = 'Here is the translation:\n```\n**<1>** 你好\n**<2>** 世界\n```';
  assert.deepEqual(parseMarkedSegments(raw, 2), ['你好', '世界']);
});

test('parseMarkedSegments：模型漏掉某一条时对应位置为 null', () => {
  const raw = '<1> 你好\n<3> 第三';
  assert.deepEqual(parseMarkedSegments(raw, 3), ['你好', null, '第三']);
});

test('parseMarkedSegments：段内换行会被保留', () => {
  const raw = '<1> 第一行\n第二行\n<2> 第二段';
  assert.deepEqual(parseMarkedSegments(raw, 2), ['第一行\n第二行', '第二段']);
});

test('parseMarkedSegments：完全无法解析时返回 null（触发降级）', () => {
  assert.equal(parseMarkedSegments('模型直接返回了一段没有标记的译文', 3), null);
});

test('parseMarkedSegments：单段模式会剥掉多余的 <1> 前缀', () => {
  assert.deepEqual(parseMarkedSegments('<1> 你好', 1), ['你好']);
});

test('buildMarkerInstruction：多段时给出明确的对齐规则', () => {
  const instruction = buildMarkerInstruction(3, 'Simplified Chinese');
  assert.match(instruction, /3 numbered segments/);
  assert.match(instruction, /Simplified Chinese/);
  assert.match(instruction, /one line per segment/i);
});

/* ------------------------------------------------------------------ *
 * JSON 抽取
 * ------------------------------------------------------------------ */

test('extractJsonObject：从代码块与解释文字中抽出 JSON', () => {
  assert.deepEqual(extractJsonObject('```json\n{"1":"你好"}\n```'), { 1: '你好' });
  assert.deepEqual(extractJsonObject('好的，结果如下：{"1":"你好","2":"世界"} 以上。'), {
    1: '你好',
    2: '世界'
  });
  assert.equal(extractJsonObject('没有任何 JSON'), null);
  assert.equal(extractJsonObject('[1,2,3]'), null);
});

test('parseJsonSegments：键顺序无关，缺键为 null', () => {
  assert.deepEqual(parseJsonSegments('{"2":"乙","1":"甲"}', 2), ['甲', '乙']);
  assert.deepEqual(parseJsonSegments('{"1":"甲"}', 2), ['甲', null]);
  assert.equal(parseJsonSegments('{}', 2), null);
});

/* ------------------------------------------------------------------ *
 * 模型输出清洗
 * ------------------------------------------------------------------ */

test('sanitizeSegment：剥掉代码块与整体引号', () => {
  assert.equal(sanitizeSegment('```\n你好\n```', 'Hello'), '你好');
  assert.equal(sanitizeSegment('"你好"', 'Hello'), '你好');
  assert.equal(sanitizeSegment('   ', 'Hello'), null);
});

test('sanitizeSegment：译文短得离谱视为截断，返回 null 触发重试', () => {
  const source = 'This is a reasonably long English sentence that must be translated fully.';
  assert.equal(sanitizeSegment('短', source), null);
  assert.equal(sanitizeSegment('这是一句足够长的中文译文，用来通过长度校验。', source)?.length > 0, true);
});

/* ------------------------------------------------------------------ *
 * 地址归一化
 * ------------------------------------------------------------------ */

test('resolveEndpoint：把各种写法补全成 chat/completions', () => {
  assert.equal(resolveEndpoint({ endpoint: 'https://api.openai.com' }), 'https://api.openai.com/v1/chat/completions');
  assert.equal(resolveEndpoint({ endpoint: 'https://api.openai.com/v1' }), 'https://api.openai.com/v1/chat/completions');
  assert.equal(
    resolveEndpoint({ endpoint: 'https://api.deepseek.com/v1/chat/completions' }),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    resolveEndpoint({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions/' }),
    'http://127.0.0.1:11434/v1/chat/completions'
  );
  assert.equal(resolveEndpoint({ endpoint: 'https://gw.example.com/v1/' }), 'https://gw.example.com/v1/chat/completions');
  assert.equal(resolveEndpoint({}), 'https://api.openai.com/v1/chat/completions');
});

test('readContent：兼容 OpenAI 与 Ollama 的响应形状', () => {
  assert.equal(readContent({ choices: [{ message: { content: '你好' } }] }), '你好');
  assert.equal(readContent({ message: { content: '你好' } }), '你好');
  assert.equal(readContent({ response: '你好' }), '你好');
  assert.equal(
    readContent({ choices: [{ message: { content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] } }] }),
    '你好'
  );
  assert.throws(() => readContent({}), /没有可用的文本内容/);
});

/* ------------------------------------------------------------------ *
 * 免费端点解析
 * ------------------------------------------------------------------ */

test('unescapeGoogle：还原 \\u 转义、\\x 转义与 HTML 实体', () => {
  assert.equal(unescapeGoogle('\\u4f60\\u597d'), '你好');
  assert.equal(unescapeGoogle('\\xe4\\xbd\\xa0'), 'ä½\xa0');
  assert.equal(unescapeGoogle('a &amp; b &quot;c&quot;'), 'a & b "c"');
});

test('decodeGoogleResponse：解析含转义的非标准响应', () => {
  assert.deepEqual(decodeGoogleResponse('[["Hello"]]'), [['Hello']]);
  assert.deepEqual(decodeGoogleResponse('[["\\u4f60\\u597d"]]'), [['你好']]);
  assert.deepEqual(decodeGoogleResponse(')]}\'\n[["Hi"]]'), [['Hi']]);
  assert.equal(decodeGoogleResponse('not json at all'), null);
});

/* ------------------------------------------------------------------ *
 * JWT 过期解析
 * ------------------------------------------------------------------ */

test('jwtExpiry：从 JWT payload 里读出 exp（毫秒）', () => {
  // {"exp": 1700000000} 的 base64url
  const payload = Buffer.from(JSON.stringify({ exp: 1700000000 })).toString('base64url');
  const token = `header.${payload}.signature`;
  assert.equal(jwtExpiry(token), 1700000000_000);
  assert.equal(jwtExpiry('garbage'), 0);
  assert.equal(jwtExpiry('a.!!!.c'), 0);
});

/* ------------------------------------------------------------------ *
 * 语言码映射
 * ------------------------------------------------------------------ */

test('normalizeLangFor：各 provider 的语言码差异被抹平', () => {
  assert.equal(normalizeLangFor('deepl', 'zh-CN'), 'ZH');
  assert.equal(normalizeLangFor('deepl', 'zh-TW'), 'ZH-HANT');
  assert.equal(normalizeLangFor('deepl', 'en'), 'EN');
  assert.equal(normalizeLangFor('microsoft', 'zh-CN'), 'zh-Hans');
  assert.equal(normalizeLangFor('microsoft', 'zh-TW'), 'zh-Hant');
  assert.equal(normalizeLangFor('google-free', 'zh-CN'), 'zh-CN');
  assert.equal(normalizeLangFor('openai-compat', 'zh-CN'), 'Simplified Chinese');
  assert.equal(normalizeLangFor('microsoft', 'auto'), 'auto');
});

test('normalizeLangFor：内置翻译用 BCP-47（中文只分 zh / zh-Hant）', () => {
  assert.equal(normalizeLangFor('on-device', 'zh-CN'), 'zh');
  assert.equal(normalizeLangFor('on-device', 'zh'), 'zh');
  assert.equal(normalizeLangFor('on-device', 'zh-TW'), 'zh-Hant');
  assert.equal(normalizeLangFor('on-device', 'pt'), 'pt-BR');
  assert.equal(normalizeLangFor('on-device', 'en'), 'en');
  assert.equal(normalizeLangFor('on-device', 'auto'), 'auto');
});

/* ------------------------------------------------------------------ *
 * 内置翻译（端上引擎）在注册表里的位置
 * ------------------------------------------------------------------ */

test('内置翻译：可在设置里选择，但绝不进入 background 的远端链', () => {
  const providers = listProviders();
  const onDevice = providers.find((provider) => provider.id === 'on-device');
  assert.ok(onDevice, '设置页应该能列出内置翻译');
  assert.equal(onDevice.kind, 'on-device');
  assert.equal(onDevice.needsKey, false);
  assert.equal(onDevice.remote, false, '内置翻译没有远端实现模块');
  // 它在 service worker 里没有实现：pipeline 拿到 null 会自然跳过而不是崩
  assert.equal(getModule('on-device'), null);
  // 不需要任何配置即视为可用
  assert.equal(isConfigured('on-device', {}), true);
});

test('resolveChain：显式选择内置翻译时给出的是纯远端兜底链', () => {
  // 用户显式选了内置翻译：远端链 = 用户的兜底选择 + 默认免费通道（始终有兜底）
  assert.deepEqual(resolveChain('on-device', {}, ['microsoft']), ['microsoft', 'google-free']);
  // 没勾任何兜底时仍然有默认免费通道，端上失败不会让整页无译文
  assert.deepEqual(resolveChain('on-device', {}, []), ['microsoft', 'google-free']);
  // 勾了内置翻译也不会把它混进远端链（SW 里没有 Translator）
  assert.deepEqual(resolveChain('auto', {}, ['on-device']), AUTO_CHAIN);
  assert.ok(!resolveChain('auto', {}, ['on-device']).includes('on-device'));
});


/* ------------------------------------------------------------------ *
 * 微软免费通道：授权端点失效后的处理
 *
 * 真实故障：edge.microsoft.com/translate/auth 已返回 404，
 * 若不处理，每个批次都白打一次请求并刷一条 404 日志。
 * ------------------------------------------------------------------ */

test('微软通道：授权端点 404 时给出可读提示并进入冷却', async () => {
  const realFetch = globalThis.fetch;
  __resetTokenCache();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('not found', { status: 404 });
  };
  try {
    await assert.rejects(
      () =>
        microsoftTranslate({
          segments: ['hello'],
          targetLang: 'zh-CN',
          timeoutMs: 1000
        }),
      (error) => {
        assert.match(error.message, /授权接口已失效/);
        assert.match(error.message, /内置翻译|DeepL|OpenAI/);
        assert.equal(error.retryable, false);
        return true;
      }
    );
    assert.equal(fetchCalls, 1);
    assert.equal(isAuthCoolingDown(), true);

    // 冷却期内再次调用：直接失败，不应再发网络请求
    await assert.rejects(
      () => microsoftTranslate({ segments: ['hello'], targetLang: 'zh-CN', timeoutMs: 1000 }),
      /授权接口已失效/
    );
    assert.equal(fetchCalls, 1, '冷却期内不应重复请求授权端点');
  } finally {
    globalThis.fetch = realFetch;
    __resetTokenCache();
  }
});

test('微软通道：非认证类错误（如 503）不进入冷却，仍可重试', async () => {
  const realFetch = globalThis.fetch;
  __resetTokenCache();
  globalThis.fetch = async () => new Response('boom', { status: 503 });
  try {
    await assert.rejects(() =>
      microsoftTranslate({ segments: ['hello'], targetLang: 'zh-CN', timeoutMs: 1000 })
    );
    assert.equal(isAuthCoolingDown(), false, '5xx 是临时故障，不应冷却');
  } finally {
    globalThis.fetch = realFetch;
    __resetTokenCache();
  }
});


/* ------------------------------------------------------------------ *
 * 错误信息
 * ------------------------------------------------------------------ */

test('errorFromResponse：把 HTTP 状态翻译成用户能看懂的中文', async () => {
  const unauthorized = await errorFromResponse(
    'deepl',
    new Response(JSON.stringify({ message: 'Wrong endpoint' }), { status: 401 })
  );
  assert.match(unauthorized.message, /认证失败/);
  assert.equal(unauthorized.status, 401);

  const limited = await errorFromResponse('google-free', new Response('rate limited', { status: 429 }));
  assert.match(limited.message, /限流/);
  assert.equal(limited.retryable, true);

  const serverError = await errorFromResponse('microsoft', new Response('boom', { status: 503 }));
  assert.equal(serverError.retryable, true);
});
