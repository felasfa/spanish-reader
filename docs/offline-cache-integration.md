# Offline Cache — Integration Spec for Spanish Reader

This document describes how to integrate `offline-cache.js` into the Spanish Reader app.
The module is identical in both apps; only the `init()` call differs.

---

## 1. Copy the shared module

Copy `public/js/offline-cache.js` from the medical-ai-news repo into the Spanish Reader
at the same path (`public/js/offline-cache.js`). **Do not modify the file.**

The module provides these capabilities:

| Feature | Storage | Notes |
|---|---|---|
| Article HTML cache | IndexedDB | 7-day TTL, auto-pruned on init |
| Reading list mirror | localStorage | instant load on startup, no spinner |
| Last-known scroll positions | localStorage | per-URL map, used for offline restore |
| Pending scroll sync queue | localStorage | flushed when network returns |

---

## 2. `public/index.html` — add script tag

Add **before** the first `<script src="/js/app.js">` (or equivalent entry-point script):

```html
<script src="/js/offline-cache.js"></script>
```

---

## 3. App init — one line, app-specific

In the `DOMContentLoaded` handler (wherever startup logic runs):

```js
OfflineCache.init({ dbName: 'spanish-reader' });
```

> For medical-ai-news this is `'medical-ai-news'`. The `dbName` is used as the
> prefix for all IndexedDB database names and localStorage keys, so the two apps
> never collide even if running on the same origin.

---

## 4. `loadReadingList()` — serve cache first, refresh in background

Replace the existing function body with this pattern:

```js
async function loadReadingList() {
  const container = document.getElementById('rl-cards'); // adjust selector if needed

  // Serve cached list immediately — no spinner if we have data
  const cached = OfflineCache.loadList();
  if (cached) {
    S.rlItems = cached;
    renderReadingList(cached);
  } else {
    container.innerHTML = '<div class="state-loading"><div class="spinner"></div><p>Loading…</p></div>';
  }

  if (!OfflineCache.isOnline()) return; // keep showing cached data

  try {
    const items = await apiFetch('/api/reading-list');
    S.rlItems = items;
    OfflineCache.saveList(items);
    renderReadingList(items);
  } catch (err) {
    if (!cached) container.innerHTML = `<div class="state-error">${err.message}</div>`;
    // else keep the cached render — don't flash an error over good data
  }
}
```

---

## 5. `loadUrlInReader(url, scrollPct)` — cache-aware fetch

### 5a. Extract the iframe-mount logic into a helper

Create this helper (add it just above `loadUrlInReader`):

```js
function _mountHtml(frame, html, url, scrollPct) {
  frame.srcdoc = html;
  frame.onload = async () => {
    document.getElementById('reader-loading').hidden = true;
    if (typeof scrollPct === 'number' && scrollPct > 0) {
      frame.contentWindow?.postMessage({ type: 'scroll-to', pct: scrollPct }, '*');
    } else if (scrollPct === undefined) {
      // Restore scroll: try server first, fall back to local cache
      try {
        const { scrollPct: saved } = await apiFetch(
          `/api/reading-list/scroll?url=${encodeURIComponent(url)}`
        );
        if (saved > 0) frame.contentWindow?.postMessage({ type: 'scroll-to', pct: saved }, '*');
      } catch {
        const local = OfflineCache.getScrollLocal(url);
        if (local > 0) frame.contentWindow?.postMessage({ type: 'scroll-to', pct: local }, '*');
      }
    }
    // scrollPct === 0 → stay at top, no action needed
  };
}
```

### 5b. Add the offline + cache path to `loadUrlInReader`

After the initial setup (`loading.hidden = false`, etc.) and after the `isKnownBlocked`
early-return, insert:

```js
const cached = await OfflineCache.getCachedArticle(url);

// ── Offline: serve from cache or show message ───────────────────────────────
if (!OfflineCache.isOnline()) {
  loading.hidden = true;
  if (cached) {
    _mountHtml(frame, cached, url, scrollPct);
  } else {
    showProxyFallback(frame, url, 'offline');
  }
  return;
}
```

### 5c. Cache the fetched HTML (online path)

In the successful-fetch branch, after you have `html = data.html`, add:

```js
OfflineCache.cacheArticle(url, html);
```

### 5d. Serve stale cache on network error

In the `catch` block (where you currently call `showProxyFallback`), prepend:

```js
if (cached) {
  loading.hidden = true;
  toast('Loaded from cache', 'info');
  _mountHtml(frame, cached, url, scrollPct);
  return;
}
// ... existing showProxyFallback call below
```

Replace the existing `frame.srcdoc = html` + `frame.onload` block at the end with:

```js
_mountHtml(frame, html, url, scrollPct);
```

---

## 6. `showProxyFallback` — add offline case

In the `msg` ternary / switch, add an `'offline'` branch:

```js
const msg = reason === 'csr'
  ? 'This page loads its content via JavaScript and cannot be shown in the reader. Open it directly in your browser:'
  : reason === 'offline'
    ? "You're offline and this article hasn't been cached yet. Open it when you have a connection:"
    : (reason === true || reason === 'blocked')
      ? 'This site blocks external loading. Open it directly in your browser:'
      : 'This page could not be loaded in the reader. You can open it directly:';
```

---

## 7. `saveScrollPosition()` — save locally + queue when offline

Replace the existing function with:

```js
function saveScrollPosition() {
  if (!S.currentArticle || !S.iframeScrollPct) return;
  const url = S.currentArticle.url;
  const pct = S.iframeScrollPct;

  // Always persist locally so offline scroll restore works
  OfflineCache.saveScrollLocal(url, pct);

  if (OfflineCache.isOnline()) {
    // sendBeacon must use Blob — plain string sends text/plain which Express ignores
    navigator.sendBeacon(
      API + '/api/reading-list/scroll',
      new Blob([JSON.stringify({ url, scrollPct: pct })], { type: 'application/json' })
    );
  } else {
    OfflineCache.queueScroll(url, pct);
  }
}
```

---

## 8. Event listeners — add at the bottom of the read-later JS file

```js
// Flush queued scroll syncs when network returns
window.addEventListener('online', () => {
  OfflineCache.flushScrollQueue(async (url, pct) => {
    await apiFetch('/api/reading-list/scroll', {
      method: 'POST',
      body: JSON.stringify({ url, scrollPct: pct }),
    });
  });
});

// Re-sync reading list when tab regains focus (picks up adds from other devices)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && OfflineCache.isOnline() && S.view === 'rl') {
    loadReadingList();
  }
});
```

---

## 9. State object — add `rlItems`

In the global state object `S`, add:

```js
rlItems: null,   // cached reading list (null = not yet loaded)
```

This is used in `loadReadingList` and `openArticle` to avoid re-fetching the list
when the user opens an article from the list view.

Also update `openArticle` to use the cache:

```js
async function openArticle(id) {
  const items = S.rlItems || await apiFetch('/api/reading-list').catch(() => []);
  const item  = items.find(i => i.id === id);
  // ...rest unchanged
}
```

---

## 10. Checklist

- [ ] `offline-cache.js` copied to `public/js/`
- [ ] `<script src="/js/offline-cache.js">` added before app scripts in HTML
- [ ] `OfflineCache.init({ dbName: 'spanish-reader' })` called in DOMContentLoaded
- [ ] `loadReadingList()` updated (cache-first pattern)
- [ ] `_mountHtml()` helper added above `loadUrlInReader`
- [ ] `loadUrlInReader()` updated (offline path + cache write + stale fallback)
- [ ] `showProxyFallback()` updated (`'offline'` case)
- [ ] `saveScrollPosition()` updated (local save + offline queue)
- [ ] `online` event listener added
- [ ] `visibilitychange` listener added
- [ ] `S.rlItems` added to state; `openArticle` uses it

---

## Notes

- **No server changes needed.** All changes are client-side. The module uses existing
  API endpoints (`GET /api/reading-list`, `POST /api/reading-list/scroll`).
- **Images**: article text is fully cached. Images from external CDNs are not — they
  load from the browser's HTTP cache if previously visited, or are broken if not.
  A service worker would be needed to guarantee image availability offline.
- **Storage**: IndexedDB stores full article HTML. Typical articles are 50–300 KB.
  The 7-day TTL and startup prune keep storage bounded.
- **Multi-device sync**: the `visibilitychange` handler re-fetches the reading list
  whenever the user returns to the tab with network available. Articles added on a
  second device appear within one tab-focus cycle.
