/**
 * content ↔ background 通信客户端单测。
 *
 * 重点覆盖两类容易被忽略的问题：
 *  1. 超时定时器的收尾——泄漏的挂起定时器不会影响浏览器，却会让
 *     "真正执行产物"的校验/测试被硬卡（本项目就被卡了 90 秒）；
 *  2. MV3 SW 冷启动时的消息重试语义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TranslationClient } from '../src/content/client.js';

/** 装一个最小的 chrome.runtime，sendMessage 行为可注入 */
function installChromeStub(sendMessage) {
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage() {},
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener() {}
      }
    }
  };
  return { listeners };
}

test('send：正常收到响应时，超时定时器必须被清理（否则会挂住事件循环）', async () => {
  installChromeStub(async () => ({ ok: true, result: { provider: 'on-device' } }));

  /**
   * 直接统计 setTimeout/clearTimeout 的配对，而不是去猜运行时状态：
   * 旧实现用 `Promise.race([p, new Promise(_, reject => setTimeout(...))])`，
   * 正常返回时那个定时器不会被清掉，于是每发一条消息就留一个挂起定时器。
   * 浏览器里只是浪费内存，但在 Node 里执行产物时，事件循环要等它整整
   * DEFAULT_TIMEOUT（90 秒）才排空——本项目就因此被卡了 90 秒。
   */
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  /** @type {Map<unknown, number>} */
  const live = new Map();
  let created = 0;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest);
    live.set(id, ms ?? 0);
    created += 1;
    return id;
  };
  globalThis.clearTimeout = (id) => {
    live.delete(id);
    return realClearTimeout(id);
  };

  try {
    const client = new TranslationClient();
    const response = await client.send({ type: 'translator/ping' }, { timeout: 90_000, retries: 0 });
    assert.equal(response.result.provider, 'on-device');

    // 让 finally 里的 clearTimeout 跑完
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    assert.ok(created > 0, '应当创建过超时定时器');
    assert.deepEqual(
      [...live.values()],
      [],
      `正常返回后不应遗留定时器，实际遗留：${[...live.values()].join(', ')}ms`
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('send：超时确实会拒绝，并带上可读的超时提示', async () => {
  // 永不响应的 sendMessage
  installChromeStub(() => new Promise(() => {}));
  const client = new TranslationClient();
  await assert.rejects(
    () => client.send({ type: 'translator/slow' }, { timeout: 30, retries: 0 }),
    /等待后台响应超时/
  );
});

test('send：后台无响应会重试一次，随后成功', async () => {
  let calls = 0;
  installChromeStub(async () => {
    calls += 1;
    if (calls === 1) throw new Error('Could not establish connection');
    return { ok: true, value: 1 };
  });
  const client = new TranslationClient();
  const response = await client.send({ type: 'translator/flaky' }, { timeout: 500, retries: 1 });
  assert.equal(response.value, 1);
  assert.equal(calls, 2);
});

test('send：扩展上下文失效时立刻失败，不做无意义重试', async () => {
  let calls = 0;
  installChromeStub(async () => {
    calls += 1;
    throw new Error('Extension context invalidated.');
  });
  const client = new TranslationClient();
  await assert.rejects(() => client.send({ type: 'translator/dead' }, { timeout: 500, retries: 3 }), /context invalidated/);
  assert.equal(calls, 1, '上下文失效后不应再重试');
});

test('send：后台返回 ok:false 时抛出后台给的错误信息', async () => {
  installChromeStub(async () => ({ ok: false, error: '没有可用的翻译引擎' }));
  const client = new TranslationClient();
  await assert.rejects(() => client.send({ type: 'translator/x' }, { retries: 0 }), /没有可用的翻译引擎/);
});
