/**
 * Chrome 内置 Translator API 适配器单测。
 *
 * 端上路径没有网络依赖，因此这里的用例全部可以用假 Translator 覆盖：
 * 能力探测、语言码归一、实例复用、并发串行、下载进度、错误分类与降级。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  OnDeviceError,
  destroyAll,
  ensurePair,
  isReady,
  isRetryable,
  isSupported,
  normalizeOnDeviceLang,
  probeAvailability,
  resetCache,
  resolveSourceLang,
  translate
} from '../src/shared/onDevice.js';
import { createTranslatorStub, domError } from './helpers/translatorStub.mjs';

/** @type {ReturnType<typeof createTranslatorStub> | null} */
let stub = null;

beforeEach(() => {
  // 模块级缓存（实例、语言对可用性、串行队列）必须在用例之间清空
  resetCache();
});

afterEach(() => {
  stub?.uninstall();
  stub = null;
  resetCache();
});

/* ------------------------------------------------------------------ *
 * 能力探测
 * ------------------------------------------------------------------ */

test('isSupported：宿主没有 Translator 时返回 false', () => {
  delete globalThis.Translator;
  assert.equal(isSupported(), false);
});

test('probeAvailability：不支持的环境直接返回 unsupported', async () => {
  delete globalThis.Translator;
  assert.equal(await probeAvailability({ targetLang: 'zh-CN' }), 'unsupported');
});

test('probeAvailability：透传 Chrome 的语言包状态', async () => {
  stub = createTranslatorStub({ available: ['downloadable', 'available'] });
  stub.install();
  // 第一次：需要下载；downloadable 不缓存，所以第二次会重新探测
  assert.equal(await probeAvailability({ sourceLang: 'en', targetLang: 'zh-CN' }), 'downloadable');
  assert.equal(await probeAvailability({ sourceLang: 'en', targetLang: 'zh-CN' }), 'available');
  // available 会被缓存，不再重复探测
  assert.equal(await probeAvailability({ sourceLang: 'en', targetLang: 'zh-CN' }), 'available');
  assert.deepEqual(stub.state.availabilityCalls, ['en>zh', 'en>zh']);
});

test('probeAvailability：未识别的状态按可用处理，不误判为不可用', async () => {
  stub = createTranslatorStub({ available: 'readily' });
  stub.install();
  assert.equal(await probeAvailability({ sourceLang: 'en', targetLang: 'ja' }), 'available');
});

test('probeAvailability：NotSupportedError 视为该语言对不可用', async () => {
  stub = createTranslatorStub({ availabilityThrows: domError('NotSupportedError') });
  stub.install();
  assert.equal(await probeAvailability({ sourceLang: 'en', targetLang: 'zh-CN' }), 'unavailable');
});

test('probeAvailability：没有 availability() 的老实现不崩，按可用处理', async () => {
  stub = createTranslatorStub({ hasAvailability: false });
  stub.install();
  assert.equal(await probeAvailability({ sourceLang: 'en', targetLang: 'zh-CN' }), 'available');
});

test('isReady：只有 available 才算就绪', async () => {
  stub = createTranslatorStub({ available: 'downloadable' });
  stub.install();
  assert.equal(await isReady({ sourceLang: 'en', targetLang: 'zh-CN' }), false);
});

/* ------------------------------------------------------------------ *
 * 语言码归一
 * ------------------------------------------------------------------ */

test('normalizeOnDeviceLang：中文只区分 zh / zh-Hant，葡萄牙语用 pt-BR', () => {
  assert.equal(normalizeOnDeviceLang('zh-CN'), 'zh');
  assert.equal(normalizeOnDeviceLang('zh'), 'zh');
  assert.equal(normalizeOnDeviceLang('zh-Hans'), 'zh');
  assert.equal(normalizeOnDeviceLang('zh-TW'), 'zh-Hant');
  assert.equal(normalizeOnDeviceLang('zh-HK'), 'zh-Hant');
  assert.equal(normalizeOnDeviceLang('pt'), 'pt-BR');
  assert.equal(normalizeOnDeviceLang('pt-PT'), 'pt-BR');
  assert.equal(normalizeOnDeviceLang('en'), 'en');
  assert.equal(normalizeOnDeviceLang('ja'), 'ja');
  assert.equal(normalizeOnDeviceLang('iw'), 'he');
  assert.equal(normalizeOnDeviceLang('auto'), 'auto');
});

test('resolveSourceLang：显式源语言优先，与目标相同时判为不需要翻译', () => {
  assert.equal(resolveSourceLang('ja', 'zh', 'Hello world this is English'), 'ja');
  assert.equal(resolveSourceLang('zh-CN', 'zh', 'Hello'), '');
});

test('resolveSourceLang：能从样本推断源语言', () => {
  const french = 'Bonjour, ceci est un texte en français avec des mots pour le test.';
  assert.equal(resolveSourceLang('auto', 'zh', french), 'fr');
  const japanese = 'これは日本語のテキストです。翻訳のテストに使います。';
  assert.equal(resolveSourceLang('auto', 'zh', japanese), 'ja');
});

test('resolveSourceLang：检测不出来时回退英语（避免冷门语种白降级）', () => {
  // 纯符号/极短文本无法判定语言
  assert.equal(resolveSourceLang('auto', 'zh', '12345'), 'en');
  // 目标本身就是英语时，回退英语会造成同语言，返回空表示不可用
  assert.equal(resolveSourceLang('auto', 'en', '12345'), '');
});

/* ------------------------------------------------------------------ *
 * 翻译主流程
 * ------------------------------------------------------------------ */

test('translate：逐条返回译文，且同一语言对只创建一次实例', async () => {
  stub = createTranslatorStub();
  stub.install();
  const out = await translate({ segments: ['Hello', 'World'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.deepEqual(out, ['[zh]Hello', '[zh]World']);
  assert.deepEqual(stub.state.createCalls, ['en>zh']);

  // 第二次调用复用同一实例
  await translate({ segments: ['Again'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.deepEqual(stub.state.createCalls, ['en>zh']);
});

test('translate：同一实例上的调用被串行化（端上模型扛不住并发）', async () => {
  stub = createTranslatorStub();
  stub.install();
  await translate({
    segments: ['a', 'b', 'c', 'd', 'e'],
    targetLang: 'zh-CN',
    sourceLang: 'en',
    concurrency: 3
  });
  assert.equal(stub.state.translateCalls.length, 5);
  assert.equal(stub.state.maxActiveTranslations, 1, '同一语言对不应出现并发 translate');
});

test('translate：不同语言对使用各自的实例', async () => {
  stub = createTranslatorStub();
  stub.install();
  await translate({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  await translate({ segments: ['Hola'], targetLang: 'ja', sourceLang: 'es' });
  assert.deepEqual(stub.state.createCalls, ['en>zh', 'es>ja']);
});

test('translate：单条失败只让该条为 null，不影响整批', async () => {
  stub = createTranslatorStub({
    translate: (text) => {
      if (text === 'bad') throw new Error('model exploded');
      return `[zh]${text}`;
    }
  });
  stub.install();
  const out = await translate({ segments: ['good', 'bad', 'fine'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.deepEqual(out, ['[zh]good', null, '[zh]fine']);
});

test('translate：空数组直接返回，不创建实例', async () => {
  stub = createTranslatorStub();
  stub.install();
  assert.deepEqual(await translate({ segments: [], targetLang: 'zh-CN', sourceLang: 'en' }), []);
  assert.equal(stub.state.createCalls.length, 0);
});

test('translate：没有 API 时抛出 unsupported', async () => {
  delete globalThis.Translator;
  await assert.rejects(
    () => translate({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' }),
    (error) => error instanceof OnDeviceError && error.code === 'unsupported'
  );
});

test('translate：源语言与目标语言相同时抛出 same-language', async () => {
  stub = createTranslatorStub();
  stub.install();
  await assert.rejects(
    () => translate({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'zh-CN' }),
    (error) => error.code === 'same-language'
  );
});

test('translate：onProgress 收到语言包下载百分比，onPhase 依次通告阶段', async () => {
  stub = createTranslatorStub({
    downloadEvents: [
      { loaded: 0, total: 100 },
      { loaded: 25, total: 100 },
      { loaded: 100, total: 100 }
    ]
  });
  stub.install();
  /** @type {number[]} */
  const percents = [];
  /** @type {string[]} */
  const phases = [];
  await translate({
    segments: ['Hello'],
    targetLang: 'zh-CN',
    sourceLang: 'en',
    onProgress: (percent) => percents.push(percent),
    onPhase: (phase) => phases.push(phase)
  });
  assert.deepEqual(percents, [0, 25, 100]);
  assert.deepEqual(phases, ['preparing', 'downloading', 'translating']);
});

test('ensurePair：预热后 translate 不再重复创建实例', async () => {
  stub = createTranslatorStub();
  stub.install();
  assert.equal(await ensurePair({ sourceLang: 'en', targetLang: 'zh-CN' }), true);
  await translate({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.deepEqual(stub.state.createCalls, ['en>zh']);
});

test('ensurePair：语言相同直接拒绝，不做无意义下载', async () => {
  stub = createTranslatorStub();
  stub.install();
  await assert.rejects(() => ensurePair({ sourceLang: 'zh-CN', targetLang: 'zh' }), (error) => error.code === 'same-language');
  assert.equal(stub.state.createCalls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 错误分类
 * ------------------------------------------------------------------ */

test('translate：create 的错误被翻译成带语义 code 的 OnDeviceError', async () => {
  const cases = [
    ['NotAllowedError', 'not-allowed'],
    ['NotSupportedError', 'unavailable'],
    ['NetworkError', 'download-failed'],
    ['AbortError', 'aborted'],
    ['OperationError', 'unknown']
  ];
  for (const [name, expected] of cases) {
    resetCache();
    stub?.uninstall();
    stub = createTranslatorStub({ available: 'downloadable', createError: domError(name) });
    stub.install();
    await assert.rejects(
      () => translate({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' }),
      (error) => error instanceof OnDeviceError && error.code === expected,
      `${name} 应映射为 ${expected}`
    );
  }
});

test('语言包准备超时：不会无限等待，而是降级为可重试的失败', async () => {
  // 网络受限时 Chrome 的模型下载可能既不返回也不报错——没有上限就会永远卡住
  stub = createTranslatorStub({ available: 'downloadable', createHangs: true });
  stub.install();
  const startedAt = Date.now();
  await assert.rejects(
    () => ensurePair({ sourceLang: 'en', targetLang: 'zh-CN', createTimeoutMs: 40 }),
    (error) => {
      assert.equal(error.code, 'download-failed');
      assert.equal(error.retryable, true);
      assert.match(error.message, /超时/);
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 2000, '应在给定上限附近失败，而不是一直等');
});

test('语言包准备超时：批量翻译同样不会卡死', async () => {
  stub = createTranslatorStub({ available: 'downloadable', createHangs: true });
  stub.install();
  await assert.rejects(
    () =>
      translate({
        segments: ['Hello'],
        targetLang: 'zh-CN',
        sourceLang: 'en',
        createTimeoutMs: 40
      }),
    (error) => error.code === 'download-failed'
  );
});

test('create 失败后不会把坏实例留在缓存里（下次仍可重试）', async () => {
  stub = createTranslatorStub({ available: 'downloadable', createError: domError('NetworkError') });
  stub.install();  await assert.rejects(() => translate({ segments: ['a'], targetLang: 'zh-CN', sourceLang: 'en' }));
  await assert.rejects(() => translate({ segments: ['a'], targetLang: 'zh-CN', sourceLang: 'en' }));
  assert.equal(stub.state.createCalls.length, 2, '失败的实例不应被复用');
});

test('isRetryable：语言不支持/无手势不重试，下载失败可重试', () => {
  assert.equal(isRetryable(new OnDeviceError('x', { code: 'unavailable' })), false);
  assert.equal(isRetryable(new OnDeviceError('x', { code: 'not-allowed' })), false);
  assert.equal(isRetryable(new OnDeviceError('x', { code: 'unsupported' })), false);
  assert.equal(isRetryable(new OnDeviceError('x', { code: 'download-failed' })), true);
  assert.equal(isRetryable(new OnDeviceError('x', { code: 'unknown' })), true);
});

/* ------------------------------------------------------------------ *
 * 资源回收
 * ------------------------------------------------------------------ */

test('destroyAll：释放已创建的实例并清空缓存', async () => {
  stub = createTranslatorStub();
  stub.install();
  await translate({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  await destroyAll();
  assert.equal(stub.state.destroyed, 1);
  // 释放后再次翻译会重新创建
  await translate({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(stub.state.createCalls.length, 2);
});
