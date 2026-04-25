'use strict';
/**
 * OfflineCache — portable offline reading module
 *
 * Used by: medical-ai-news, spanish-reader (and any future reader app)
 *
 * Call once on startup:
 *   OfflineCache.init({ dbName: 'medical-ai-news' });
 *
 * Public API:
 *   OfflineCache.cacheArticle(url, html)          store processed article HTML
 *   OfflineCache.getCachedArticle(url)            → html string | null
 *   OfflineCache.saveList(items)                  persist reading list to localStorage
 *   OfflineCache.loadList()                       → items array | null
 *   OfflineCache.saveScrollLocal(url, pct)        persist last-known scroll position
 *   OfflineCache.getScrollLocal(url)              → pct number | 0
 *   OfflineCache.queueScroll(url, pct)            queue a scroll sync for when online
 *   OfflineCache.flushScrollQueue(syncFn)         flush queued syncs; syncFn(url,pct)→Promise
 *   OfflineCache.isOnline()                       → boolean
 */
const OfflineCache = (() => {
  const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  let _prefix    = 'app';
  let _dbPromise = null;

  // ── localStorage helpers ──────────────────────────────────────────────────

  const k = name => _prefix + ':' + name;
  function lsGet(name) { try { return JSON.parse(localStorage.getItem(k(name))); } catch { return null; } }
  function lsSet(name, val) { try { localStorage.setItem(k(name), JSON.stringify(val)); } catch {} }
  function lsDel(name) { try { localStorage.removeItem(k(name)); } catch {} }

  // ── IndexedDB ─────────────────────────────────────────────────────────────

  function _openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(_prefix + '-articles', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('articles')) {
          db.createObjectStore('articles', { keyPath: 'url' });
        }
      };
      req.onsuccess = e => {
        const db = e.target.result;
        // Reset on unexpected close (e.g. iOS Safari backgrounding the tab)
        db.onclose = () => { _dbPromise = null; };
        resolve(db);
      };
      req.onerror = e => { _dbPromise = null; reject(e.target.error); };
    });
  }

  function _getDb() {
    if (!_dbPromise) _dbPromise = _openDb();
    return _dbPromise;
  }

  // Use .then() — never async/await — to create transactions.
  // WebKit silently drops IDB transactions created after `await` in async functions.
  function _tx(mode, fn) {
    return _getDb().then(db => new Promise((resolve, reject) => {
      const tx    = db.transaction('articles', mode);
      const store = tx.objectStore('articles');
      const req   = fn(store);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    }));
  }

  // ── Article cache (IndexedDB) ─────────────────────────────────────────────

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
    } catch { return null; }
  }

  function _pruneExpired() {
    _getDb().then(db => {
      const tx  = db.transaction('articles', 'readwrite');
      const req = tx.objectStore('articles').openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (Date.now() - cursor.value.ts > TTL_MS) cursor.delete();
        cursor.continue();
      };
    }).catch(() => {});
  }

  // ── Reading list (localStorage) ───────────────────────────────────────────

  function saveList(items) { lsSet('rl', items); }
  function loadList()      { return lsGet('rl'); }

  // ── Scroll positions (localStorage) ──────────────────────────────────────

  function saveScrollLocal(url, pct) {
    const map = lsGet('scroll') || {};
    map[url] = pct;
    lsSet('scroll', map);
  }

  function getScrollLocal(url) {
    return (lsGet('scroll') || {})[url] || 0;
  }

  // ── Scroll sync queue (localStorage) ─────────────────────────────────────

  function queueScroll(url, pct) {
    const q = lsGet('scroll-queue') || {};
    q[url] = pct;
    lsSet('scroll-queue', q);
  }

  async function flushScrollQueue(syncFn) {
    const q = lsGet('scroll-queue') || {};
    if (!Object.keys(q).length) return;
    lsDel('scroll-queue');
    for (const entry of Object.entries(q)) {
      try { await syncFn(entry[0], entry[1]); } catch {}
    }
  }

  // ── Online status ─────────────────────────────────────────────────────────

  function isOnline() { return navigator.onLine !== false; }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init(opts) {
    if (opts && opts.dbName) _prefix = opts.dbName;
    _pruneExpired();
  }

  return {
    init,
    cacheArticle, getCachedArticle,
    saveList, loadList,
    saveScrollLocal, getScrollLocal,
    queueScroll, flushScrollQueue,
    isOnline,
  };
})();
