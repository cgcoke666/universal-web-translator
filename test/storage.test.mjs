/**
 * 设置、缓存与请求队列单测。
 *
 * 这三块是"省钱"和"不炸"的关键：
 *  - 设置合并写错 → 用户升版本后配置丢失；
 *  - 缓存键写错 → 命中率暴跌，配额白烧；
 *  - 队列写错 → 免费端点被 429 打死，或者失败任务永久卡住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  cacheKey,
  chunkBySize,
  hash32,
  matchHostPattern,
  mergeSettings,
  normalizeText,
  uniqCompact
} from '../src/shared/constants.js';
import { TranslationCache, bucketOf } from '../src/shared/cache.js';
import { RateLimiter, TaskQueue, isRetryable } from '../src/shared/queue.js';

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

test('mergeSettings：空值返回默认设置，且是深拷贝', () => {
  const merged = mergeSettings(null);
  assert.deepEqual(merged, DEFAULT_SETTINGS);
  merged.skipSelectors.push('.ad');
  assert.deepEqual(DEFAULT_SETTINGS.skipSelectors, [], '不能污染默认设置对象');
});

test('mergeSettings：保留用户值并补齐新增字段', () => {
  const merged = mergeSettings({ targetLang: 'ja', minTextLength: 5 });
  assert.equal(merged.targetLang, 'ja');
  assert.equal(merged.minTextLength, 5);
  assert.equal(merged.displayMode, 'bilingual', '未提供的字段应回落到默认值');
  assert.equal(merged.translateShadowDom, true);
});

test('mergeSettings：providerConfig 按引擎深合并，不覆盖其它引擎配置', () => {
  const merged = mergeSettings({
    providerConfig: { deepl: { apiKey: 'k:fx' } }
  });
  assert.equal(merged.providerConfig.deepl.apiKey, 'k:fx');
  assert.equal(merged.providerConfig.deepl.endpoint, 'https://api-free.deepl.com', '默认端点应保留');
  assert.equal(merged.providerConfig.ollama.model, 'qwen2.5:7b', '其它引擎默认值不应丢失');
});

test('mergeSettings：忽略 null/undefined，避免把默认值抹成空', () => {
  const merged = mergeSettings({ targetLang: null, concurrency: undefined });
  assert.equal(merged.targetLang, DEFAULT_SETTINGS.targetLang);
  assert.equal(merged.concurrency, DEFAULT_SETTINGS.concurrency);
});

test('mergeSettings：站点规则整体替换', () => {
  const merged = mergeSettings({ siteMode: { 'example.com': 'never' }, siteTargetLang: { 'a.com': 'en' } });
  assert.deepEqual(merged.siteMode, { 'example.com': 'never' });
  assert.deepEqual(merged.siteTargetLang, { 'a.com': 'en' });
});

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

test('normalizeText / cacheKey：空白差异共用同一条缓存', () => {
  assert.equal(normalizeText('  Hello   world \n'), 'Hello world');
  assert.equal(cacheKey('zh-CN', 'Hello   world'), cacheKey('zh-CN', ' Hello world '));
  assert.notEqual(cacheKey('zh-CN', 'Hello'), cacheKey('ja', 'Hello'), '不同目标语言不能共用缓存');
});

test('hash32：稳定且分布合理', () => {
  assert.equal(hash32('same input'), hash32('same input'));
  const buckets = new Set();
  for (let i = 0; i < 200; i += 1) buckets.add(parseInt(hash32(`text-${i}`), 36) % 8);
  assert.equal(buckets.size, 8, '分桶应覆盖全部 8 个桶');
});

test('chunkBySize：按预算切块且不丢项', () => {
  const items = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)];
  const chunks = chunkBySize(items, 25, (item) => item.length);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.flat(), items);
  // 单个元素超过预算时也要自成一块，不能丢
  const oversized = chunkBySize(['x'.repeat(100)], 10, (item) => item.length);
  assert.equal(oversized.length, 1);
});

test('uniqCompact / matchHostPattern 的常见用法', () => {
  assert.deepEqual(uniqCompact([' .ad ', '', '.ad', 'nav']), ['.ad', 'nav']);
  assert.equal(matchHostPattern('www.example.com', '*.example.com'), true);
  assert.equal(matchHostPattern('example.com', '*.example.com'), true);
  assert.equal(matchHostPattern('notexample.com', '*.example.com'), false);
  assert.equal(matchHostPattern('anything', '*'), true);
});

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

/** 内存版 chrome.storage.local 替身 */
function fakeStorage() {
  /** @type {Record<string, unknown>} */
  let data = {};
  return {
    data: () => data,
    async get(keys) {
      if (keys === undefined || keys === null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items) {
      data = { ...data, ...items };
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete data[key];
    }
  };
}

test('TranslationCache：写后可读，命中率统计正确', async () => {
  const cache = new TranslationCache({ storage: fakeStorage() });
  cache.set('Hello', 'zh-CN', '你好');
  assert.equal(cache.get('Hello', 'zh-CN'), '你好');
  assert.equal(cache.get('Hello   ', 'zh-CN'), '你好', '空白折叠后必须命中同一条');
  assert.equal(cache.get('Hello', 'ja'), undefined, '不同语言不能串味');
  const stats = cache.stats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 1);
});

test('TranslationCache：持久化跨实例生效（模拟浏览器重启）', async () => {
  const storage = fakeStorage();
  const first = new TranslationCache({ storage });
  first.set('Persisted text', 'zh-CN', '持久化文本');
  await first.flushNow();

  const second = new TranslationCache({ storage });
  await second.warmup();
  assert.equal(second.get('Persisted text', 'zh-CN'), '持久化文本');
});

test('TranslationCache：clear 同时清空内存与持久层', async () => {
  const storage = fakeStorage();
  const cache = new TranslationCache({ storage });
  cache.set('A', 'zh-CN', '甲');
  await cache.flushNow();
  await cache.clear();
  assert.equal(cache.get('A', 'zh-CN'), undefined);
  const data = storage.data();
  assert.deepEqual(Object.keys(data), [], '持久层也应被清空');
});

test('TranslationCache：enableCache 关闭后不读不写', () => {
  const cache = new TranslationCache({ storage: fakeStorage() });
  cache.setEnabled(false);
  cache.set('B', 'zh-CN', '乙');
  assert.equal(cache.get('B', 'zh-CN'), undefined);
  assert.equal(cache.stats().writes, 0);
});

test('bucketOf：分桶稳定，且 200 条缓存能分散到多个桶', () => {
  assert.equal(bucketOf('same-key'), bucketOf('same-key'), '同一 key 必须落同一桶');
  const buckets = new Set();
  for (let i = 0; i < 200; i += 1) buckets.add(bucketOf(`zh-CN|${hash32(`text-${i}`)}`));
  assert.ok(buckets.size >= 6, `应分散到多个桶以避免单键过大，实际 ${buckets.size} 个桶`);
  for (const bucket of buckets) assert.match(bucket, /^cache\.c[0-7]$/);
});

test('TranslationCache：内存上限触发 LRU 淘汰', () => {
  const cache = new TranslationCache({ storage: fakeStorage(), maxMemory: 3 });
  for (let i = 0; i < 10; i += 1) cache.set(`text-${i}`, 'zh-CN', `译文${i}`);
  assert.ok(cache.memory.size <= 3, `内存条目应受限，实际 ${cache.memory.size}`);
  assert.equal(cache.get('text-9', 'zh-CN'), '译文9', '最新写入的必须还在');
});

/* ------------------------------------------------------------------ *
 * 队列
 * ------------------------------------------------------------------ */

test('isRetryable：限流/5xx/网络错误可重试，参数错误不可重试', () => {
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ status: 503 }), true);
  assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryable({ status: 400 }), false);
  assert.equal(isRetryable({ status: 401 }), false);
  assert.equal(isRetryable({ status: 456 }), false);
});

test('RateLimiter：同一 key 连续保留会拉开间隔', () => {
  const limiter = new RateLimiter(50);
  assert.equal(limiter.reserve('k'), 0, '第一次不应等待');
  assert.ok(limiter.reserve('k') > 0, '第二次必须等待');
  assert.equal(limiter.reserve('other'), 0, '不同 key 互不影响');
});

test('TaskQueue：相同 key 的在飞任务被去重', async () => {
  const queue = new TaskQueue({ maxConcurrent: 2, minIntervalMs: 0 });
  let calls = 0;
  const task = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'done';
  };
  const [a, b] = await Promise.all([queue.push('same', task), queue.push('same', task)]);
  assert.equal(a, 'done');
  assert.equal(b, 'done');
  assert.equal(calls, 1, '同一 key 只应真正执行一次');
});

test('TaskQueue：可重试错误会退避重试直到成功', async () => {
  const queue = new TaskQueue({ maxConcurrent: 1, retries: 3, baseBackoffMs: 1, minIntervalMs: 0 });
  let attempts = 0;
  const result = await queue.push('retry', async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('rate limited');
      error.status = 429;
      throw error;
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('TaskQueue：不可重试错误立即抛出，不浪费时间', async () => {
  const queue = new TaskQueue({ maxConcurrent: 1, retries: 3, baseBackoffMs: 1, minIntervalMs: 0 });
  let attempts = 0;
  await assert.rejects(
    () =>
      queue.push('fatal', async () => {
        attempts += 1;
        const error = new Error('bad key');
        error.status = 401;
        throw error;
      }),
    /bad key/
  );
  assert.equal(attempts, 1);
});

test('TaskQueue：并发上限被遵守', async () => {
  const queue = new TaskQueue({ maxConcurrent: 2, minIntervalMs: 0 });
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 6 }, (_, i) =>
    queue.push(`job-${i}`, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return i;
    })
  );
  const results = await Promise.all(jobs);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.ok(peak <= 2, `峰值并发应 ≤ 2，实际 ${peak}`);
});

test('TaskQueue：setConcurrency 立即生效', async () => {
  const queue = new TaskQueue({ maxConcurrent: 1, minIntervalMs: 0 });
  let peak = 0;
  let running = 0;
  const jobs = Array.from({ length: 8 }, (_, i) =>
    queue.push(`c-${i}`, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 8));
      running -= 1;
      return i;
    })
  );
  queue.setConcurrency(4);
  await Promise.all(jobs);
  assert.ok(peak >= 2, `提高并发后应真的并行，实际峰值 ${peak}`);
});
