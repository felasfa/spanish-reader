'use strict';

/* OfflineCache — shared module for Spanish Reader
 *
 * Provides:
 *   IndexedDB  — article HTML cache (7-day TTL, pruned on init)
 *   localStorage — reading-list mirror, scroll positions, pending sync queue
 *
 * Usage:
 *   OfflineCache.init({ dbName: 'spanish-reader' });
 */
const OfflineCache = (() => {
  const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  let _prefix = 'offline';
  let _db = null;

  // ── localStorage key helpers ──────────────────────────────────────────────

  const k = name => `${_prefix}:${name}`;

  function lsGet(name) {
    try { return JSON.parse(localStorage.getItem(k(name))); } catch { return null; }
  }
  function lsSet(name, val) {
    try { localStorage.setItem(k(name), JSON.stringify(val)); } catch { /* quota */ }
  }
  function lsDel(name) {
    try { localStorage.removeItem(k(name)); } catch { /* ignore */ }
  }

  // ── IndexedDB ─────────────────────────────────────────────────────────────

  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(`${_prefix}-articles`, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('articles')) {
          const store = db.createObjectStore('articles', { keyPath: 'url' });
          store.createIndex('ts', 'ts');
        }
      };
      req.onsuccess  = e => resolve(e.target.result);
      req.onerror    = e => reject(e.target.error);
    });
  }

  async function _db_() {
    if (!_db) _db = await _openDB();
    return _db;
  }

  function _tx(mode, fn) {
    return _db_().then(db => new Promise((resolve, reject) => {
      const tx    = db.transaction('articles', mode);
      const store = tx.objectStore('articles');
      const req   = fn(store);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  // ── Prune expired entries on startup ──────────────────────────────────────

  async function _prune() {
    try {
      const db     = await _db_();
      const cutoff = Date.now() - TTL_MS;
      const tx     = db.transaction('articles', 'readwrite');
      const range  = IDBKeyRange.upperBound(cutoff);
      const req    = tx.objectStore('articles').index('ts').openCursor(range);
      req.onsuccess = e => {
        const cur = e.target.result;
        if (cur) { cur.delete(); cur.continue(); }
      };
    } catch (e) {
      console.warn('[OfflineCache] prune failed:', e);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function init({ dbName } = {}) {
    if (dbName) _prefix = dbName;
    _prune(); // fire-and-forget
  }

  function isOnline() {
    return navigator.onLine !== false;
  }

  // Reading-list mirror
  function saveList(items) {
    lsSet('rl', items);
  }
  function loadList() {
    return lsGet('rl'); // null if never saved
  }

  // Article HTML (IndexedDB)
  async function cacheArticle(url, html) {
    try {
      await _tx('readwrite', store => store.put({ url, html, ts: Date.now() }));
    } catch (e) {
      console.warn('[OfflineCache] write failed:', e);
    }
  }

  async function getCachedArticle(url) {
    try {
      const row = await _tx('readonly', store => store.get(url));
      if (!row) return null;
      if (Date.now() - row.ts > TTL_MS) {
        _tx('readwrite', store => store.delete(url)).catch(() => {});
        return null;
      }
      return row.html;
    } catch {
      return null;
    }
  }

  // Scroll positions (localStorage, per-URL map)
  function saveScrollLocal(url, pct) {
    const map = lsGet('scroll') || {};
    map[url] = pct;
    lsSet('scroll', map);
  }
  function getScrollLocal(url) {
    return (lsGet('scroll') || {})[url] || 0;
  }

  // Pending scroll sync queue (flushed when back online)
  function queueScroll(url, pct) {
    const q = lsGet('scroll-queue') || {};
    q[url] = pct;
    lsSet('scroll-queue', q);
  }

  async function flushScrollQueue(callback) {
    const q = lsGet('scroll-queue') || {};
    if (!Object.keys(q).length) return;
    lsDel('scroll-queue');
    for (const [url, pct] of Object.entries(q)) {
      try { await callback(url, pct); } catch { /* ignore individual failures */ }
    }
  }

  return {
    init,
    isOnline,
    saveList,
    loadList,
    cacheArticle,
    getCachedArticle,
    saveScrollLocal,
    getScrollLocal,
    queueScroll,
    flushScrollQueue,
  };
})();
