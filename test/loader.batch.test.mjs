/**
 * 端上翻译调度器单测。
 *
 * 这里验证的是"什么时候该走端上、失败后怎么把剩下的分段交给远端"这套决策，
 * 它比 API 本身更容易出错：错误的判定会导致整页翻译变慢、变慢或直接缺段。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { OnDeviceTranslator, describeProbe } from '../src/content/onDeviceLoader.js';
import { resetCache } from '../src/shared/onDevice.js';
import { createTranslatorStub, domError } from './helpers/translatorStub.mjs';

/** @type {ReturnType<typeof createTranslatorStub> | null} */
let stub = null;

beforeEach(() => {
  resetCache();
});

afterEach(() => {
  stub?.uninstall();
  stub = null;
  resetCache();
});

function makeLoader() {
  const loader = new OnDeviceTranslator({ debug: () => false });
  loader.enabled = true;
  return loader;
}

/* ------------------------------------------------------------------ *
 * 该不该尝试端上
 * ------------------------------------------------------------------ */

test('没有 Translator API 时不尝试端上，整批留给远端', async () => {
  delete globalThis.Translator;
  const loader = makeLoader();
  const result = await loader.translateBatch({ segments: ['Hello'], targetLang: 'zh-CN' });
  assert.equal(result.attempted, false);
  assert.deepEqual(result.remaining, [0]);
  assert.deepEqual(result.results, [null]);
});

test('设置里关闭端上引擎时完全不动用（也不做任何探测）', async () => {
  stub = createTranslatorStub();
  stub.install();
  const loader = makeLoader();
  loader.enabled = false;
  const result = await loader.translateBatch({ segments: ['Hello'], targetLang: 'zh-CN' });
  assert.equal(result.attempted, false);
  assert.deepEqual(result.remaining, [0]);
  assert.equal(stub.state.availabilityCalls.length, 0);
  assert.equal(stub.state.createCalls.length, 0);
});

test('目标语言无法在端上使用时跳过，并记入黑名单避免反复尝试', async () => {
  stub = createTranslatorStub({ available: 'unavailable' });
  stub.install();
  const loader = makeLoader();
  const first = await loader.translateBatch({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(first.attempted, false);
  assert.equal(first.blocked, true);

  const second = await loader.translateBatch({ segments: ['World'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(second.blocked, true);
  // 第二次直接命中黑名单，不再探测也不再尝试创建
  assert.equal(stub.state.createCalls.length, 0);
});

test('目标语言切换后黑名单清空，重新给端上一次机会', async () => {
  stub = createTranslatorStub({ available: 'unavailable' });
  stub.install();
  const loader = makeLoader();
  await loader.translateBatch({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  loader.resetBlocklist();
  await loader.translateBatch({ segments: ['Hello'], targetLang: 'ja', sourceLang: 'en' });
  // 换语言后重新探测了一次（en>ja）
  assert.ok(stub.state.availabilityCalls.includes('en>ja'));
});

/* ------------------------------------------------------------------ *
 * 成功路径与部分成功
 * ------------------------------------------------------------------ */

test('可用时整批端上翻译，remaining 为空', async () => {
  stub = createTranslatorStub();
  stub.install();
  const loader = makeLoader();
  const result = await loader.translateBatch({
    segments: ['Hello', 'World'],
    targetLang: 'zh-CN',
    sourceLang: 'en'
  });
  assert.equal(result.attempted, true);
  assert.equal(result.provider, 'on-device');
  assert.deepEqual(result.results, ['[zh]Hello', '[zh]World']);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.error, '');
});

test('部分分段端上没返回时，只有这些位置留给远端（且保持原下标）', async () => {
  stub = createTranslatorStub({
    translate: (text) => (text === 'World' ? null : `[zh]${text}`)
  });
  stub.install();
  const loader = makeLoader();
  const result = await loader.translateBatch({
    segments: ['Hello', 'World', 'Again'],
    targetLang: 'zh-CN',
    sourceLang: 'en'
  });
  assert.deepEqual(result.results, ['[zh]Hello', null, '[zh]Again']);
  assert.deepEqual(result.remaining, [1]);
  assert.match(result.error, /1 段未返回/);
});

test('不含字母的分段不送端上模型，直接留给远端流程', async () => {
  stub = createTranslatorStub();
  stub.install();
  const loader = makeLoader();
  const result = await loader.translateBatch({
    segments: ['Hello', '12345'],
    targetLang: 'zh-CN',
    sourceLang: 'en'
  });
  assert.equal(stub.state.translateCalls.length, 1, '纯数字不应占用端上模型');
  assert.deepEqual(result.results, ['[zh]Hello', null]);
  assert.deepEqual(result.remaining, [1]);
});

/* ------------------------------------------------------------------ *
 * 失败与降级
 * ------------------------------------------------------------------ */

test('下载失败（可重试）只降级本次，不拉黑语言对', async () => {
  stub = createTranslatorStub({ available: 'downloadable', createError: domError('NetworkError') });
  stub.install();
  const loader = makeLoader();
  const first = await loader.translateBatch({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(first.attempted, true);
  assert.equal(first.blocked, false);
  assert.deepEqual(first.remaining, [0]);
  assert.match(first.error, /语言包下载失败/);

  // 网络问题不该被永久拉黑：下一批仍然会再试一次
  await loader.translateBatch({ segments: ['World'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(stub.state.createCalls.length, 2);
});

test('浏览器不支持该语言对（NotSupportedError）会被拉黑，避免持续拖慢', async () => {
  stub = createTranslatorStub({ available: 'downloadable', createError: domError('NotSupportedError') });
  stub.install();
  const loader = makeLoader();
  const first = await loader.translateBatch({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(first.blocked, true);
  const second = await loader.translateBatch({ segments: ['World'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(second.attempted, false);
  assert.equal(stub.state.createCalls.length, 1, '拉黑后不应再尝试创建');
});

test('预热成功后再批量翻译不会重复创建实例', async () => {
  stub = createTranslatorStub();
  stub.install();
  const loader = makeLoader();
  const sample = 'Hello world, this is a sample English sentence for language detection.';
  assert.equal(await loader.prewarm('zh-CN', sample), true);
  const result = await loader.translateBatch({ segments: ['Hello'], targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(result.provider, 'on-device');
  assert.equal(stub.state.createCalls.length, 1);
});

test('预热失败只返回 false，把降级决定留给后续批次', async () => {
  delete globalThis.Translator;
  const loader = makeLoader();
  assert.equal(await loader.prewarm('zh-CN', 'Hello world'), false);
});

/* ------------------------------------------------------------------ *
 * 状态文案
 * ------------------------------------------------------------------ */

test('probe 与 describeProbe：把探测结果变成可读文案', async () => {
  stub = createTranslatorStub({ available: 'downloadable' });
  stub.install();
  const loader = makeLoader();
  const probe = await loader.probe({ targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(probe.status, 'downloadable');
  assert.equal(probe.supported, true);
  assert.match(describeProbe(loader.lastProbe), /需要先下载语言包/);

  const unsupported = describeProbe({ supported: false, status: 'unsupported' });
  assert.match(unsupported, /不支持内置翻译/);
});

test('probeForLaunch：找不到可用语言对时给出 unavailable，不虚构就绪状态', async () => {
  stub = createTranslatorStub({ available: 'unavailable' });
  stub.install();
  const loader = makeLoader();
  const probe = await loader.probeForLaunch({ targetLang: 'zh-CN' });
  assert.equal(probe.status, 'unavailable');
  assert.equal(probe.supported, true);
  assert.equal(probe.sourceLang, '');
});

test('probeForLaunch：显式源语言可用时立刻报 available（面板显示"离线就绪"）', async () => {
  stub = createTranslatorStub({ available: 'available' });
  stub.install();
  const loader = makeLoader();
  const probe = await loader.probeForLaunch({ targetLang: 'zh-CN', sourceLang: 'en' });
  assert.equal(probe.status, 'available');
  assert.equal(probe.sourceLang, 'en');
  // 探测只读 availability：不创建实例、不触发下载
  assert.equal(stub.state.createCalls.length, 0);
});

test('probeForLaunch：关闭端上引擎时不探测，直接返回 disabled', async () => {
  stub = createTranslatorStub();
  stub.install();
  const loader = makeLoader();
  loader.enabled = false;
  const probe = await loader.probeForLaunch({ targetLang: 'zh-CN' });
  assert.equal(probe.status, 'disabled');
  assert.equal(stub.state.availabilityCalls.length, 0);
});

test('probeSourceCandidates：显式源语言优先，且不把目标语言当源语言', () => {
  const loader = makeLoader();
  assert.deepEqual(loader.probeSourceCandidates('ja', 'zh-CN'), ['ja']);
  assert.deepEqual(loader.probeSourceCandidates('auto', 'zh-CN'), ['en', 'ja', 'fr', 'de']);
  // 目标语言是英语时，候选里不应再出现 en（同语言对无意义）
  assert.ok(!loader.probeSourceCandidates('auto', 'en').includes('en'));
});
