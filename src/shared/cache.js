/**
 * 翻译结果缓存。
 *
 * 两层结构：
 *  - L1：service worker 内存 Map（LRU），命中不落盘；
 *  - L2：chrome.storage.local 分桶持久化，重启浏览器仍有效。
 *
 * 关键设计：缓存键 = 目标语言 + 归一化原文的 hash。归一化折叠空白，
 * 让 "  Hello  world " 与 "Hello world" 共用一条缓存。
 */

import { CACHE_BUCKETS, STORAGE_KEYS, cacheKey, hash32, normalizeText } from './constants.js';

export class TranslationCache {
  /**
   * @param {{storage?: {get: (keys?: string|string[]|null) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void>, remove: (keys: string|string[]) => Promise<void>}, maxMemory?: number, debug?: boolean}} [options]
   */
  constructor(options = {}) {
    this.storage = options.storage ?? (globalThis.chrome?.storage?.local ?? null);
    this.maxMemory = options.maxMemory ?? 4000;
    /** @type {Map<string, string>} */
    this.memory = new Map();
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.dirtyBuckets = new Set();
    this.flushTimer = null;
    this.enabled = true;
  }

  /** 一次性把持久层读进内存（service worker 启动时调用一次） */
  async warmup() {
    if (!this.storage) return;
    const keys = bucketKeys();
    try {
      const data = await this.storage.get(keys);
      for (const k of keys) {
        const bucket = data?.[k];
        if (!bucket || typeof bucket !== 'object') continue;
        for (const [key, value] of Object.entries(bucket)) {
          if (typeof value === 'string') this.memory.set(key, value);
        }
      }
      this.trim();
    } catch (error) {
      console.warn('[dsh-translator:cache] warmup failed', error);
    }
  }

  /**
   * @param {string} text
   * @param {string} targetLang
   * @returns {string | undefined}
   */
  get(text, targetLang) {
    if (!this.enabled) return undefined;
    const key = cacheKey(targetLang, text);
    const hit = this.memory.get(key);
    if (hit !== undefined) {
      // LRU：命中后重新插入到队尾
      this.memory.delete(key);
      this.memory.set(key, hit);
      this.hits += 1;
      return hit;
    }
    this.misses += 1;
    return undefined;
  }

  /**
   * @param {string} text
   * @param {string} targetLang
   * @param {string} translated
   */
  set(text, targetLang, translated) {
    if (!this.enabled) return;
    if (!translated) return;
    const original = normalizeText(text);
    if (original.length < 1) return;
    // 译文与原文完全一致时也缓存，避免反复请求同样的 "ok"
    const key = cacheKey(targetLang, text);
    this.memory.set(key, translated);
    this.writes += 1;
    this.dirtyBuckets.add(bucketOf(key));
    this.trim();
    this.scheduleFlush();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  trim() {
    while (this.memory.size > this.maxMemory) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memory.delete(oldest.value);
    }
  }

  scheduleFlush() {
    if (!this.storage || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 2500);
  }

  /** 只写回被改动的桶，避免整表重写 */
  async flush() {
    if (!this.storage || this.dirtyBuckets.size === 0) return;
    const buckets = [...this.dirtyBuckets];
    this.dirtyBuckets.clear();
    /** @type {Record<string, Record<string, string>>} */
    const payload = {};
    for (const bucket of buckets) payload[bucket] = {};
    for (const [key, value] of this.memory) {
      const bucket = bucketOf(key);
      if (payload[bucket]) payload[bucket][key] = value;
    }
    try {
      await this.storage.set(payload);
    } catch (error) {
      console.warn('[dsh-translator:cache] flush failed', error);
    }
  }

  /** 立即写回，供 SW 卸载前或设置变更后调用 */
  async flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.memory.size,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      hitRate: total > 0 ? this.hits / total : 0
    };
  }

  async clear() {
    this.memory.clear();
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.dirtyBuckets.clear();
    if (!this.storage) return;
    try {
      await this.storage.remove(bucketKeys());
    } catch (error) {
      console.warn('[dsh-translator:cache] clear failed', error);
    }
  }
}

function bucketKeys() {
  return Array.from({ length: CACHE_BUCKETS }, (_, i) => `${STORAGE_KEYS.cache}.c${i}`);
}

function bucketOf(key) {
  const n = parseInt(hash32(key), 36) % CACHE_BUCKETS;
  return `${STORAGE_KEYS.cache}.c${Number.isFinite(n) ? n : 0}`;
}

export { bucketKeys, bucketOf };
