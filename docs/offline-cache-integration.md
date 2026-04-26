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
    precacheAll(items); // background — no await
  } catch (err) {
    if (!cached) container.innerHTML = `<div class="state-error">${err.message}</div>`;
    // else keep the cached render — don't flash an error over good data
  }
}
```

---

## 5. Background pre-caching with `precacheAll`

After loading the reading list, silently cache every uncached article so the user
can read offline without taking any extra action.

### 5a. Progress UI elements in HTML

In the reading list view, add a status bar element just above the article cards:

```html
<div id="rl-cache-status" hidden style="font-size:12px;color:#6b7280;padding:4px 0 8px;display:flex;align-items:center;gap:6px;">
  <svg id="rl-cache-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite;flex-shrink:0"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
  <span id="rl-cache-msg"></span>
</div>
```

Add the spinner keyframe animation to your CSS:

```css
@keyframes spin { to { transform: rotate(360deg); } }
```

### 5b. `precacheAll` function

Add this near the top of your read-later JS file:

```js
let _precaching = false;

function _setCacheStatus(msg, done = false) {
  const bar  = document.getElementById('rl-cache-status');
  const spin = document.getElementById('rl-cache-spinner');
  const txt  = document.getElementById('rl-cache-msg');
  if (!bar) return;
  if (!msg) { bar.hidden = true; return; }
  bar.hidden = false;
  txt.textContent = msg;
  if (spin) spin.style.display = done ? 'none' : '';
}

async function precacheAll(items) {
  if (_precaching || !OfflineCache.isOnline() || !items.length) return;
  _precaching = true;
  const eligible = items.filter(i => i.url && !isKnownBlocked(i.url));
  let fetched = 0, attempted = 0;
  try {
    for (const item of eligible) {
      if (!OfflineCache.isOnline()) break;
      const already = await OfflineCache.getCachedArticle(item.url);
      if (already) continue;
      attempted++;
      _setCacheStatus(`Saving ${fetched + 1} of ${eligible.length} articles to this browser…`);
      try {
        // ?inlineImages=1 embeds images as base64 so they render offline
        const data = await apiFetch(`/api/fetch?url=${encodeURIComponent(item.url)}&inlineImages=1`);
        // Only cache clean reader extractions — skip raw proxy (warning) and CSR pages
        if (data && data.html && !data.warning && !data.csr) {
          await OfflineCache.cacheArticle(item.url, data.html);
          fetched++;
        }
      } catch {}
    }
    if (attempted > 0) {
      _setCacheStatus(`${fetched} of ${eligible.length} articles saved to this browser ✓`, true);
      setTimeout(() => _setCacheStatus(''), 4000);
    } else {
      _setCacheStatus('');
    }
  } finally {
    _precaching = false;
  }
}
```

> **Why skip `warning` and `csr` responses?**  Raw-proxy pages rely on external CSS
> and JS that are unavailable offline and render as blank white pages. CSR (client-side
> rendered) pages need JS execution and cannot be shown in the reader at all. Only the
> three clean reader tiers (JSON-LD, __NEXT_DATA__, Readability) render correctly offline.

---

## 6. `loadUrlInReader(url, scrollPct)` — cache-aware fetch

### 6a. Extract the iframe-mount logic into a helper

Create this helper (add it just above `loadUrlInReader`):

```js
function _mountHtml(frame, html, url, scrollPct) {
  // IMPORTANT: set onload BEFORE srcdoc — on iOS Safari the content can load
  // synchronously before the handler is assigned, causing it to never fire.
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
  frame.srcdoc = html;
}
```

### 6b. Add the offline + cache path to `loadUrlInReader`

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

### 6c. Cache the fetched HTML (online path)

In the successful-fetch branch, after you have `data`, add — but only for clean
reader extractions (not raw proxy or CSR responses which render blank offline):

```js
if (data.html && !data.warning && !data.csr) {
  await OfflineCache.cacheArticle(url, data.html);
}
```

### 6d. Serve stale cache on network error

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

## 7. `showProxyFallback` — add offline case

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

## 8. `saveScrollPosition()` — save locally + queue when offline

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

## 9. Event listeners — add at the bottom of the read-later JS file

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

## 10. State object — add `rlItems`

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

## 11. Image inlining — embed images as base64 for offline viewing

Without image inlining, cached articles show broken image icons offline because
external CDN URLs are unavailable. The solution is server-side: the API fetches each
`<img>` URL and replaces it with a `data:` URI before returning the HTML.

### 11a. Server-side `inlineImages` function

Add to your Express server (requires `axios`):

```js
async function inlineImages(html, baseUrl) {
  const srcs = [];
  const imgRe = /<img\b[^>]+\bsrc=["']([^"']{10,})["'][^>]*/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const src = m[1];
    if (!src.startsWith('data:') && !srcs.includes(src)) srcs.push(src);
    if (srcs.length >= 8) break;  // cap at 8 images per article
  }
  if (!srcs.length) return html;

  const resolved = srcs.map(src => {
    try { return new URL(src, baseUrl).href; } catch { return src; }
  });

  const MAX_BYTES = 300 * 1024;  // skip images > 300 KB
  const dataUris = await Promise.all(resolved.map(async (absUrl, i) => {
    try {
      const resp = await axios.get(absUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,
        maxContentLength: MAX_BYTES,
        headers: { 'User-Agent': FETCH_HEADERS['User-Agent'] },
      });
      const ct = (resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      if (!ct.startsWith('image/')) return null;
      const b64 = Buffer.from(resp.data).toString('base64');
      return { src: srcs[i], dataUri: `data:${ct};base64,${b64}` };
    } catch { return null; }
  }));

  for (const item of dataUris) {
    if (!item) continue;
    html = html.split(`src="${item.src}"`).join(`src="${item.dataUri}"`);
    html = html.split(`src='${item.src}'`).join(`src='${item.dataUri}'`);
  }
  return html;
}

async function sendReaderResult(res, req, html, url) {
  if (req.query.inlineImages === '1') {
    try { html = await inlineImages(html, url); } catch (e) { console.warn('inlineImages error:', e.message); }
  }
  return res.json({ html, url });
}
```

### 11b. Use `sendReaderResult` in all clean reader tier returns

Replace `return res.json({ html: readerHtml, url })` at the end of each reader tier
(JSON-LD, __NEXT_DATA__, Readability) with:

```js
return sendReaderResult(res, req, readerHtml, url);
```

Do **not** apply to the raw proxy fallback — it returns `{ html, url, warning: true }`
and should remain as `res.json({ html, url, warning: true })`.

### 11c. Client: pass `&inlineImages=1` when pre-caching

In `precacheAll` (see section 5b), the fetch URL already includes `&inlineImages=1`.
When the user opens an article online, the regular fetch (without the param) is used so
image inlining only happens during background caching, keeping the live reader fast.

> **Limits**: up to 8 images, 300 KB each, 5 s timeout per image. Images that fail or
> exceed limits are skipped silently; the rest still inline. Typical articles add
> ~500 KB–2 MB to IndexedDB after inlining.

---

## 12. Service Worker — App Shell Cache

Without a service worker, navigating away from the app and returning while offline fails
because the browser must fetch `index.html` from the server. The service worker pre-caches
all static shell files so the app loads fully offline.

### 12a. Create `public/service-worker.js`

```js
'use strict';
// Increment CACHE_VER after any significant deploy to force re-cache of shell files.
const CACHE_VER = 'v1';
const CACHE     = 'spanish-reader-' + CACHE_VER;

const SHELL = [
  '/',
  '/css/style.css',
  '/js/offline-cache.js',
  '/js/app.js',
  '/js/read-later.js',
  // add any other JS/CSS bundles your app loads
  '/favicon.svg',
  '/favicon.png',
  '/apple-touch-icon.png',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete stale caches, take control immediately ──────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept cross-origin requests (API, CDN images, etc.)
  if (url.origin !== location.origin) return;

  // Navigation requests: network-first, cached shell as fallback
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put('/', clone));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => null);
        return cached || networkFetch;
      })
    )
  );
});
```

> Update `CACHE_VER` (e.g. `'v2'`) whenever you make a significant deploy so
> users get the fresh shell on next load.

### 12b. Register in `DOMContentLoaded`

In the same handler where you call `OfflineCache.init(...)`:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
```

### 12c. Netlify `_redirects` (SPA routing)

If your app uses client-side routing and Netlify serves it, make sure
`public/_redirects` contains:

```
/*  /index.html  200
```

The service worker's navigation handler will then serve the cached shell
for all routes when offline.

---

## 13. Checklist

- [ ] `offline-cache.js` copied to `public/js/`
- [ ] `<script src="/js/offline-cache.js">` added before app scripts in HTML
- [ ] `OfflineCache.init({ dbName: 'spanish-reader' })` called in DOMContentLoaded
- [ ] `loadReadingList()` updated (cache-first pattern, calls `precacheAll` after render)
- [ ] Cache progress bar HTML added (`#rl-cache-status`, `#rl-cache-spinner`, `#rl-cache-msg`)
- [ ] `precacheAll()` + `_setCacheStatus()` functions added; uses `?inlineImages=1`
- [ ] `_mountHtml()` helper added: sets `onload` BEFORE `srcdoc` (iOS race fix)
- [ ] `loadUrlInReader()` updated (offline path; only caches non-warning non-CSR articles)
- [ ] `showProxyFallback()` updated (`'offline'` case)
- [ ] `saveScrollPosition()` updated (local save + offline queue)
- [ ] `online` event listener added
- [ ] `visibilitychange` listener added
- [ ] `S.rlItems` added to state; `openArticle` uses it
- [ ] Server: `inlineImages()` + `sendReaderResult()` functions added
- [ ] Server: all 3 clean reader tiers use `sendReaderResult` (not raw `res.json`)
- [ ] `public/service-worker.js` created (with correct `CACHE` name)
- [ ] SW registered in `DOMContentLoaded`
- [ ] `public/_redirects` has `/* /index.html 200` (if SPA routing used)

---

## Notes

- **No server changes needed.** All changes are client-side. The module uses existing
  API endpoints (`GET /api/reading-list`, `POST /api/reading-list/scroll`).
- **Images**: background pre-caching (`precacheAll`) passes `?inlineImages=1` so the
  server fetches up to 8 images per article and embeds them as base64 data URIs.
  Cached articles therefore show images fully offline. Images > 300 KB or that time
  out (5 s) are skipped silently. When the user opens an article live (online), the
  regular fetch (no inlining) is used so the reader stays fast.
- **Storage**: IndexedDB stores full article HTML. Typical articles are 50–300 KB.
  The 7-day TTL and startup prune keep storage bounded.
- **Multi-device sync**: the `visibilitychange` handler re-fetches the reading list
  whenever the user returns to the tab with network available. Articles added on a
  second device appear within one tab-focus cycle.
- **SW update cycle**: bumping `CACHE_VER` causes the new SW to install alongside
  the old one. On next navigation the old SW is replaced and stale caches deleted.
  Users may need one page reload to pick up new shell files after a deploy.
