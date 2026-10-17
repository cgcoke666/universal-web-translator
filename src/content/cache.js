/**
 * 页面内二级缓存（IndexedDB）。
 *
 * 为什么 content script 也要缓存：
 *  - SW 的内存缓存在浏览器回收后清空，页面每次刷新都要重新走一次消息往返；
 *  - IndexedDB 在同一站点内持久，刷新/前进后退时可秒出译文（离线也有效）；
 *  - 命中时完全不占用后台请求队列额度。
 *
 * 采用"单库单表 + 最后访问时间"的简单结构，超限时按 LRU 清理。
 */

import { cacheKey, normalizeText } from '../shared/constants.js';

const DB_NAME = 'dsh-translator';
const DB_VERSION = 1;
const STORE = 'translations';
const MAX_ENTRIES = 8000;

export class PageCache {
  constructor() {
    /** @type {IDBDatabase | null} */
    this.db = null;
    /** @type {Map<string, string>} 内存层，避免频繁事务 */
    this.memory = new Map();
    this.enabled = true;
    this.openFailed = false;
  }

  /** 懒打开数据库：只有真要读写时才建库，减少页面启动开销 */
  async open() {
    if (this.db || this.openFailed) return this.db;
    if (typeof indexedDB === 'undefined') {
      this.openFailed = true;
      return null;
    }
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'key' });
            store.createIndex('at', 'at');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
      return this.db;
    } catch {
      this.openFailed = true;
      return null;
    }
  }

  /**
   * @param {string} text
   * @param {string} targetLang
   * @returns {Promise<string | null>}
   */
  async get(text, targetLang) {
    if (!this.enabled || !text) return null;
    const key = cacheKey(targetLang, text);
    const hit = this.memory.get(key);
    if (hit) return hit;

    const db = await this.open();
    if (!db) return null;
    try {
      const record = await tx(db, 'readonly', (store) => store.get(key));
      if (record?.value) {
        this.memory.set(key, record.value);
        // 异步更新访问时间，不阻塞调用方
        void this.touch(db, key, record);
        return record.value;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} text
   * @param {string} targetLang
   * @param {string} translated
   */
  async set(text, targetLang, translated) {
    if (!this.enabled || !text || !translated) return;
    const normalized = normalizeText(text);
    if (normalized.length < 1) return;
    const key = cacheKey(targetLang, text);
    this.memory.set(key, translated);
    const db = await this.open();
    if (!db) return;
    try {
      await tx(db, 'readwrite', (store) =>
        store.put({ key, value: translated, at: Date.now(), len: normalized.length })
      );
      void this.maybeEvict(db);
    } catch {
      /* 缓存失败不影响主流程 */
    }
  }

  async touch(db, key, record) {
    try {
      await tx(db, 'readwrite', (store) => store.put({ ...record, at: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  /** 条目过多时按访问时间清理最旧的一半 */
  async maybeEvict(db) {
    if (Math.random() > 0.02) return; // 概率触发，避免每次写入都统计
    try {
      const count = await tx(db, 'readonly', (store) => store.count());
      if (count < MAX_ENTRIES) return;
      const targets = Math.floor(MAX_ENTRIES * 0.25);
      await new Promise((resolve) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const index = transaction.objectStore(STORE).index('at');
        let removed = 0;
        const cursorRequest = index.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || removed >= targets) return;
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      });
      this.memory.clear();
    } catch {
      /* ignore */
    }
  }

  async clear() {
    this.memory.clear();
    const db = await this.open();
    if (!db) return;
    try {
      await tx(db, 'readwrite', (store) => store.clear());
    } catch {
      /* ignore */
    }
  }

  async count() {
    const db = await this.open();
    if (!db) return 0;
    try {
      return await tx(db, 'readonly', (store) => store.count());
    } catch {
      return 0;
    }
  }
}

/** 把 IDBRequest 包成 Promise 的小工具 */
function tx(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
  });
}
