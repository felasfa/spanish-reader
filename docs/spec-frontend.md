# Spanish Reader — Frontend Specification

## Architecture

Single-page app served as static files from Netlify (`public/`). No build step — plain HTML, CSS, and vanilla JS. All API calls go to the VPS at `https://api.felasfa.app`.

```
public/
  index.html        # shell: nav, view containers
  css/style.css     # all styles
  js/app.js         # all client logic
```

---

## Views

Three views are swapped in/out by toggling CSS visibility. `state.currentView` tracks which is active.

### 1. Reading List View (`#reading-list-view`)

Default view on load. Fetches `GET /api/reading-list` and renders article cards.

**Card layout:**
- Thumbnail image (left, 80×80px, object-fit: cover, rounded)
- Title (bold, single line, truncated)
- Summary (2 lines, truncated, muted color)
- Site name + date added (small, muted)
- Tap anywhere on card → open article in reader
- Long-press or right-click on links inside reader → context menu (Open / Save for Later)

**Controls (top bar):**
- "Import from Gmail" button → `POST /api/gmail-import` → refreshes list on success
- "Clear all" (destructive, confirm dialog) → `DELETE /api/reading-list`

**Mark as read:**
- Article is marked read when opened (`PATCH /api/reading-list/:id`)
- Read articles shown with reduced opacity; unread shown first

**Empty state:** friendly message prompting user to save an article via bookmarklet.

---

### 2. Vocabulary View (`#vocab-view`)

Fetches `GET /api/vocabulary` and renders word cards as a collapsed list.

**Collapsed (summary) row — `.vocab-summary`:**
```
[word]  [·]  [translation]                          [date]  [×]
```
- Single line, `display: flex; align-items: center; gap: 8px`
- Word in bold; translation in muted text
- Date right-aligned
- `×` delete button → `DELETE /api/vocabulary/:id`

**Expanded (detail) — `.vocab-detail`:**
- Clicking the row toggles `.vocab-detail` visibility
- Shows full Spanish sentence (`vocab-sentence-es`, italic, muted)
- Shows English sentence translation below
- Source URL as a small link

**Controls:**
- "Clear all" → `DELETE /api/vocabulary`

---

### 3. Reader View (`#reader-view`)

Displays articles in an `<iframe>` that loads proxied HTML from `GET /api/fetch?url=`.

**Iframe loading flow:**
1. Set `iframe.src = ''` to reset
2. Fetch proxied HTML from `/api/fetch?url=<url>`
3. Write HTML into iframe via `srcdoc` or blob URL
4. On `iframe.onload`: fetch saved scroll position from `GET /api/reading-list/scroll?url=<url>`, post `{ type: 'scroll-to', pct, y }` message to iframe
5. Mark article as read via `PATCH /api/reading-list/:id`

**Back button:** returns to reading list view, saves scroll position immediately.

---

## Translation Popup

Triggered when user selects text inside the iframe. The iframe's injected script posts `{ type: 'word-selected', word, sentence }` to the parent. App shows a popup with translation.

**Popup DOM structure:**
```html
<div class="translation-popup">
  <div class="popup-header">        <!-- flex-shrink: 0 -->
    <span class="popup-word">…</span>
    <button class="popup-close">×</button>
  </div>
  <div class="popup-content">       <!-- overflow-y: auto; flex: 1; min-height: 0 -->
    <div class="popup-translation">…</div>
    <div class="popup-sentence-es">…</div>
    <div class="popup-sentence-en">…</div>
    <button class="save-vocab-btn">Save to vocabulary</button>
  </div>
</div>
```

**Layout rules (critical):**
- `.translation-popup`: `display: flex; flex-direction: column; max-height: 80vh; overflow: hidden`
- `popup.style.display = 'flex'` when shown (NOT `'block'` — that breaks the flex layout)
- `.popup-content`: `overflow-y: auto; flex: 1; min-height: 0; -webkit-overflow-scrolling: touch; overscroll-behavior: contain`

**Dismiss:**
- `×` button
- Swipe down on the drag handle area (NOT on `.popup-content` — that area scrolls)
- Touch outside popup

**Save to vocab:** calls `POST /api/vocabulary` with word, translation, sentence, sentenceTranslation, url.

---

## Scroll Position Sync

Enables reading to resume at the same position across devices (phone → laptop etc.).

**How it works:**
- Iframe posts `{ type: 'scroll-update', y, pct }` messages on scroll (throttled)
  - `pct = scrollY / Math.max(1, scrollHeight - innerHeight)` — fractional 0–1
- App stores `iframeScrollPct` locally
- Every 15 seconds: `POST /api/reading-list/scroll` with `{ url, scrollPct }`
- On `visibilitychange` (page hidden): `navigator.sendBeacon(...)` with same payload
- On article open: fetch saved `scrollPct` → post `{ type: 'scroll-to', pct }` to iframe

**Why fractional:** pixel positions differ across screen widths (same article has different total height on phone vs laptop). Fractional position (0–1) is device-independent.

---

## In-iframe Injected Script

Appended by the server to every proxied page. Provides:

**Link interception:**
- All `<a href>` converted to `<a data-href onclick=...>` that post `{ type: 'link-clicked', href }` to parent instead of navigating
- Long-press (600ms) or right-click on links → shows floating context menu: "Open article" / "Save for Later"

**Text selection:**
- `mouseup` and `selectionchange` (debounced 600ms) → post `{ type: 'word-selected', word, sentence }`
- `getSentence(word, container)`: walks up DOM from selection to find containing `<p>`, `<li>`, etc. Falls back to wider `<div>` if text < 80 chars. Returns sentence containing the selected word, or first 300 chars.

**Scroll reporting:**
- `scroll` event (passive, throttled 200ms) → post `{ type: 'scroll-update', y: scrollY, pct }`

**Scroll-to (on load):**
- Listens for `{ type: 'scroll-to', pct, y }` message from parent
- Computes `target = pct * (scrollHeight - innerHeight)`
- Calls `tryScroll(4)` with 400ms retry — stops retrying if user touches screen
- Retry is necessary because article images load async, changing total height

---

## State Object

```javascript
const state = {
  currentView: 'reading-list',   // 'reading-list' | 'vocabulary' | 'reader'
  currentUrl: null,              // URL of article open in reader
  currentArticleId: null,        // reading-list entry id
  readingList: [],               // cached from last fetch
  vocabulary: [],                // cached from last fetch
};
```

---

## API Base

```javascript
const API_BASE = 'https://api.felasfa.app';
```

All fetch calls include `credentials: 'include'` only where needed (none currently, but CORS is configured to support it).

---

## Bookmarklet

A one-liner that posts the current tab's URL to `POST /api/reading-list`:

```javascript
javascript:(function(){
  fetch('https://api.felasfa.app/api/reading-list',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({url:location.href})
  }).then(r=>r.json()).then(d=>alert(d.duplicate?'Already saved!':'Saved: '+d.title));
})();
```
