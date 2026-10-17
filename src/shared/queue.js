/**
 * 并发 + 限速队列。
 *
 * 为什么需要它：
 *  - 整页翻译会瞬间产生几十上百个分段，直接并发会触发公共接口 429；
 *  - 免费端点（Google gtx / Edge demux）有不同的每分钟配额，需要按主机分别限速；
 *  - 同一个分段可能被多个调用方同时请求，需要 in-flight 去重。
 *
 * 该模块不依赖任何浏览器 API，可直接在 Node 里测试。
 */

import { createLogger } from './constants.js';

/** @typedef {{minIntervalMs?: number, maxConcurrent?: number, retries?: number, baseBackoffMs?: number, maxBackoffMs?: number}} QueueOptions */

export class RateLimiter {
  /**
   * @param {number} minIntervalMs 同一 key 两次请求之间的最小间隔
   */
  constructor(minIntervalMs = 0) {
    this.minIntervalMs = minIntervalMs;
    /** @type {Map<string, number>} */
    this.lastAt = new Map();
  }

  /** 返回还需要等待的毫秒数 */
  reserve(key) {
    if (this.minIntervalMs <= 0) return 0;
    const now = Date.now();
    const last = this.lastAt.get(key) ?? 0;
    const wait = Math.max(0, last + this.minIntervalMs - now);
    this.lastAt.set(key, now + wait);
    return wait;
  }
}

export class TaskQueue {
  /**
   * @param {QueueOptions} [options]
   */
  constructor(options = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 40;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.retries = options.retries ?? 2;
    this.baseBackoffMs = options.baseBackoffMs ?? 350;
    this.maxBackoffMs = options.maxBackoffMs ?? 6000;
    this.limiter = new RateLimiter(this.minIntervalMs);

    this.running = 0;
    /** @type {Array<{run: () => Promise<unknown>, resolve: (v: unknown) => void, reject: (e: unknown) => void, key: string, attempts: number}>} */
    this.pending = [];
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map();
    this.debugEnabled = false;
    this.log = createLogger('queue', () => this.debugEnabled);
  }

  setConcurrency(n) {
    this.maxConcurrent = Math.max(1, n | 0);
    this.pump();
  }

  setDebug(enabled) {
    this.debugEnabled = !!enabled;
  }

  get size() {
    return this.pending.length + this.running;
  }

  /**
   * 入队一个任务。相同 key 且仍在飞行中的任务会被复用（去重）。
   * @template T
   * @param {string} key 去重与限速键（一般是 provider:host）
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  push(key, task) {
    const existing = this.inflight.get(key);
    if (existing) return /** @type {Promise<T>} */ (existing);

    const promise = new Promise((resolve, reject) => {
      this.pending.push({
        run: task,
        resolve: (v) => resolve(/** @type {T} */ (v)),
        reject,
        key,
        attempts: 0
      });
    });
    this.inflight.set(key, promise);
    promise.catch(() => {}).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.pump();
    return promise;
  }

  pump() {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) break;
      this.running += 1;
      void this.execute(item);
    }
  }

  /** @param {{run: () => Promise<unknown>, resolve: (v: unknown) => void, reject: (e: unknown) => void, key: string, attempts: number}} item */
  async execute(item) {
    const wait = this.limiter.reserve(item.key);
    try {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const result = await item.run();
      item.resolve(result);
    } catch (error) {
      item.attempts += 1;
      if (item.attempts <= this.retries && isRetryable(error)) {
        const backoff = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (item.attempts - 1));
        const jitter = Math.random() * this.baseBackoffMs;
        this.log.debug(`retry #${item.attempts} in ${Math.round(backoff + jitter)}ms`, item.key, describeError(error));
        this.pending.unshift(item);
        await new Promise((r) => setTimeout(r, backoff + jitter));
      } else {
        item.reject(error);
      }
    } finally {
      this.running -= 1;
      this.pump();
    }
  }
}

/** 429 / 5xx / 网络错误 / 超时值得重试；4xx 参数错误不值得 */
export function isRetryable(error) {
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 408) return true;
  if (status === 0 || Number.isNaN(status)) return true; // 网络层错误
  const code = String(error?.code ?? '');
  if (/^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR)/.test(code)) return true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
  return false;
}

export function describeError(error) {
  if (!error) return 'unknown error';
  const status = error.status ?? error.statusCode;
  const parts = [];
  if (status) parts.push(`HTTP ${status}`);
  if (error.code) parts.push(String(error.code));
  if (error.message) parts.push(String(error.message));
  return parts.join(' ') || String(error);
}

/**
 * 带超时的 fetch 封装：MV3 service worker 里没有第三方库，自己实现 AbortController 超时。
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number}} [init]
 */
export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = 20000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const outerSignal = rest.signal;
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', () => controller.abort(outerSignal.reason), { once: true });
  }
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
