/**
 * 「端上优先 + 远端兜底」组合策略单测。
 *
 * 这层逻辑的价值全在"到底有没有先试内置翻译"：真实故障是划词翻译
 * 完全绕过端上引擎（直接打远端），于是远端通道一挂（微软 auth 接口 404、
 * Google 域名不可达），划词就什么都不出来。所以下面每个用例都盯住
 * "on-device 有没有被调用、调用后还剩没剩东西给远端"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFailureHint, dedupeErrors, translateWithFallback } from '../src/content/translateFlow.js';

/** 造一个端上引擎替身：results 指定每段返回什么 */
function makeOnDevice(results, extra = {}) {
  const calls = [];
  return {
    calls,
    translateBatch: async (request) => {
      calls.push(request);
      return {
        results: typeof results === 'function' ? results(request) : results,
        provider: 'on-device',
        error: '',
        ...extra
      };
    }
  };
}

/** 造一个远端客户端替身 */
function makeClient(result, behavior = 'ok') {
  const calls = [];
  return {
    calls,
    translate: async (request) => {
      calls.push(request);
      if (behavior === 'throw') throw new Error('Failed to fetch');
      if (behavior === 'not-ok') return { ok: false, error: '翻译服务无响应' };
      return { ok: true, result };
    }
  };
}

/* ------------------------------------------------------------------ *
 * 端上优先
 * ------------------------------------------------------------------ */

test('端上能翻完时，完全不应该调用远端', async () => {
  const onDevice = makeOnDevice(['甲', '乙']);
  const client = makeClient({ translations: ['不该出现'] });
  const out = await translateWithFallback({
    segments: ['one', 'two'],
    targetLang: 'zh-CN',
    onDevice,
    client
  });
  assert.deepEqual(out.translations, ['甲', '乙']);
  assert.equal(out.provider, 'on-device');
  assert.equal(client.calls.length, 0, '端上已覆盖全部分段，远端不应被请求');
  assert.equal(out.failed, false);
});

test('端上只翻出一部分时，远端只收到剩下的下标（且结果保序）', async () => {
  const onDevice = makeOnDevice(['甲', null, '丙']);
  const client = makeClient({ translations: ['乙'], provider: 'microsoft', errors: [] });
  const out = await translateWithFallback({
    segments: ['one', 'two', 'three'],
    targetLang: 'zh-CN',
    onDevice,
    client
  });
  assert.deepEqual(out.translations, ['甲', '乙', '丙']);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].segments, ['two'], '只应把没翻好的那一段发给远端');
  // provider 以真正产出译文的端上引擎为主
  assert.equal(out.provider, 'on-device');
});

test('端上整体不可用时，整批交给远端', async () => {
  const client = makeClient({ translations: ['甲', '乙'], provider: 'google-free' });
  const out = await translateWithFallback({
    segments: ['one', 'two'],
    targetLang: 'zh-CN',
    onDevice: null,
    client
  });
  assert.deepEqual(out.translations, ['甲', '乙']);
  assert.equal(out.provider, 'google-free');
  assert.deepEqual(client.calls[0].segments, ['one', 'two']);
});

test('设置里关闭端上时，不碰端上引擎', async () => {
  const onDevice = makeOnDevice(['甲']);
  const client = makeClient({ translations: ['乙'] });
  const out = await translateWithFallback({
    segments: ['one'],
    targetLang: 'zh-CN',
    onDeviceEnabled: false,
    onDevice,
    client
  });
  assert.equal(onDevice.calls.length, 0);
  assert.deepEqual(out.translations, ['乙']);
});

test('端上抛错时不会拖垮整批，仍会走远端', async () => {
  const onDevice = {
    calls: [],
    translateBatch: async () => {
      throw new Error('NotAllowedError: no user activation');
    }
  };
  const client = makeClient({ translations: ['甲'], provider: 'microsoft' });
  const out = await translateWithFallback({
    segments: ['one'],
    targetLang: 'zh-CN',
    onDevice,
    client
  });
  assert.deepEqual(out.translations, ['甲']);
  assert.equal(out.failed, false);
});

/* ------------------------------------------------------------------ *
 * 失败时的可读性
 * ------------------------------------------------------------------ */

test('端上与远端都失败：首条错误是"接下来该做什么"，而不是裸 HTTP 错误', async () => {
  const onDevice = makeOnDevice([null], { error: '内置翻译不支持 en → zh' });
  const client = makeClient(
    { translations: [null], errors: ['[microsoft] HTTP 404', '[google-free] Failed to fetch'] },
    'not-ok'
  );
  const out = await translateWithFallback({
    segments: ['one'],
    targetLang: 'zh-CN',
    onDevice,
    client
  });
  assert.equal(out.failed, true);
  assert.deepEqual(out.translations, [null]);
  assert.match(out.errors[0], /没有可用的翻译引擎/);
  assert.match(out.errors[0], /提前下载语言包/);
  // 原始错误仍然保留，方便定位
  assert.ok(out.errors.some((e) => /HTTP 404|Failed to fetch/.test(e)) || out.errors.length > 1);
});

test('远端客户端直接抛异常（网络失败）也能被吞住并给出提示', async () => {
  const client = makeClient(null, 'throw');
  const out = await translateWithFallback({
    segments: ['one'],
    targetLang: 'zh-CN',
    onDevice: null,
    client
  });
  assert.equal(out.failed, true);
  assert.match(out.errors[0], /没有可用的翻译引擎/);
});

test('空分段数组直接返回，不触发任何引擎', async () => {
  const onDevice = makeOnDevice([]);
  const client = makeClient({ translations: [] });
  const out = await translateWithFallback({
    segments: [],
    targetLang: 'zh-CN',
    onDevice,
    client
  });
  assert.deepEqual(out.translations, []);
  assert.equal(out.failed, false);
  assert.equal(onDevice.calls.length, 0);
  assert.equal(client.calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 错误收敛
 * ------------------------------------------------------------------ */

test('dedupeErrors：去重、去空、限量（避免同一错误刷屏）', () => {
  assert.deepEqual(dedupeErrors(['a', 'a', '', null, 'b', 'a', 'c', 'd']), ['a', 'b', 'c']);
  assert.deepEqual(dedupeErrors(['x', 'y'], 1), ['x']);
  assert.deepEqual(dedupeErrors(null), []);
});

test('buildFailureHint：没有细节时也给出可执行建议', () => {
  const hint = buildFailureHint([]);
  assert.match(hint, /提前下载语言包/);
  assert.doesNotMatch(hint, /（/);
});

test('buildFailureHint：语言包下载失败时，不要误导用户反复点下载', () => {
  const hint = buildFailureHint(['语言包下载失败，请检查网络（en>zh: NetworkError）', '[microsoft] HTTP 404']);
  // 这类失败是网络/服务受限，必须引导换引擎，而不是"再点一次下载"
  assert.doesNotMatch(hint, /提前下载语言包/);
  assert.match(hint, /Ollama|DeepL|OpenAI/);
  // 原始错误仍然附在后面，便于排查
  assert.match(hint, /NetworkError/);
});

test('buildFailureHint：浏览器不支持时提示升级或换引擎', () => {
  const hint = buildFailureHint(['当前浏览器不支持内置翻译（需要 Chrome 138+ 桌面版）']);
  assert.match(hint, /Chrome 138/);
  assert.match(hint, /DeepL|OpenAI/);
});
