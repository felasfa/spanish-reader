# Read Later — Feature Specification

> Generated from the `spanish-reader` Netlify/GitHub project.  
> Use this document to instruct Claude Code when implementing the same feature in a different repository.

---

## 1. Overview

**Read Later** is a personal article-saving queue. Users save URLs (manually, via a browser bookmarklet, or via automatic Gmail newsletter import), and the list persists in a flat JSON file stored in the GitHub repository via the GitHub Contents API. No database is required.

Key capabilities:
- Save any URL with one tap
- Auto-fetch article title, thumbnail, one-sentence summary, and source name
- Mark articles as read (visual dim + unread badge count in nav)
- Remove individual articles or clear all
- Import Spanish-language newsletters directly from Gmail
- Mobile-first card layout with thumbnail, summary, source, and date
- Browser bookmarklet for saving from any browser tab

---

## 2. Data Storage

Articles are stored as a JSON array in `data/reading-list.json` in the GitHub repository, read and written via the GitHub Contents API. Each entry is a plain object.

### Entry schema

```json
{
  "id":        1712345678901,
  "url":       "https://elpais.com/...",
  "title":     "Testigo de todas las vidas de Nicolás Maduro",
  "image":     "https://static.elpais.com/.../photo.jpg",
  "summary":   "Un periodista relata cuatro décadas junto a Maduro.",
  "siteName":  "El País",
  "dateAdded": "2026-04-09T14:23:00.000Z",
  "read":      false,
  "source":    "gmail"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | integer | `Date.now()` at creation time — used as a stable unique key |
| `url` | string | Canonical article URL |
| `title` | string | From `og:title`, fallback to `<h1>` or `<title>` |
| `image` | string | From `og:image` or `twitter:image`; empty string if none |
| `summary` | string | From `og:description` if 25–300 chars; otherwise Claude Haiku generates a ≤20-word Spanish sentence |
| `siteName` | string | From `og:site_name`; falls back to cleaned hostname at display time |
| `dateAdded` | ISO 8601 string | Server time at save |
| `read` | boolean | `false` until user opens the article |
| `source` | string | `"gmail"` for newsletter imports; absent for manually saved |

---

## 3. Backend API

Implemented as a single Netlify Function at `netlify/functions/reading-list.js`, routed via `netlify.toml`:

```toml
[[redirects]]
  from = "/api/reading-list"
  to   = "/.netlify/functions/reading-list"
  status = 200

[[redirects]]
  from = "/api/reading-list/*"
  to   = "/.netlify/functions/reading-list"
  status = 200
```

### Endpoints

#### `GET /api/reading-list`
Returns the full list as a JSON array, newest first.

```json
[{ "id": 1712345678901, "url": "...", ... }, ...]
```

#### `POST /api/reading-list`
Saves a new article. Request body: `{ "url": "https://..." }`

The server:
1. Checks for duplicates (returns `{ "duplicate": true }` if already saved)
2. Fetches the article page and extracts `og:title`, `og:image`, `og:description`, `og:site_name`
3. Falls back to `<h1>` / `<title>` for title; searches `article img` for image if og:image is absent
4. Calls Claude Haiku to generate a Spanish summary if `og:description` is missing or too short
5. Writes the new entry to the top of the JSON file via GitHub Contents API

Returns the saved entry object, or `{ "duplicate": true }`.

#### `PATCH /api/reading-list/:id`
Marks a single article as read (`read: true`). No request body needed.

#### `DELETE /api/reading-list/:id`
Removes one article by id.

#### `DELETE /api/reading-list`
Clears the entire list (writes `[]`).

### GitHub Contents API write pattern

Every write is a `PUT` to `https://api.github.com/repos/{owner}/{repo}/contents/data/reading-list.json` with:
- `content`: base64-encoded JSON (2-space pretty-printed)
- `sha`: the current file SHA (required by GitHub to detect conflicts)
- `branch`: auto-detected (checks `GITHUB_DATA_BRANCH` env var, then `BRANCH`, then first branch returned by the list-branches API)

### Environment variables required

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` | Personal access token with `repo` or `contents:write` scope |
| `GITHUB_OWNER` | Repository owner (default: repo owner) |
| `GITHUB_REPO` | Repository name |
| `GITHUB_DATA_BRANCH` | (optional) Explicit branch name for data storage |
| `ANTHROPIC_API_KEY` | For Claude Haiku summary generation |

### npm dependencies

```json
"cheerio": "^1.0.0",
"@anthropic-ai/sdk": "^0.20.0"
```

---

## 4. Frontend — HTML Structure

```html
<!-- Nav badge (shows unread count dot) -->
<button class="nav-link nav-btn" id="nav-reading-list">
  <svg><!-- bookmark icon --></svg>
  <span class="nav-label">Read Later</span>
  <span class="vocab-count" id="nav-rl-count" style="display:none"></span>
</button>

<!-- Read Later view -->
<div id="view-reading-list" class="view">
  <div class="rl-header">
    <div>
      <h2>Read Later</h2>
      <p id="rl-subtitle">Articles saved for later</p>
    </div>
    <div class="rl-header-actions">
      <button class="btn btn-outline" id="rl-gmail-import">
        <!-- envelope icon --> Check Gmail
      </button>
      <button class="btn btn-danger" id="rl-clear">
        <!-- trash icon --> Clear All
      </button>
    </div>
  </div>

  <!-- Loading spinner -->
  <div id="rl-loading" class="rl-loading" style="display:none">
    <div class="spinner"></div>
  </div>

  <!-- Empty state -->
  <div id="rl-empty" class="vocab-empty" style="display:none">
    <svg><!-- bookmark icon, large --></svg>
    <h3>Nothing saved yet</h3>
    <p>Paste a URL and tap Read Later, or hold a link while reading.</p>
    <button class="btn btn-primary" id="rl-go-read">Start Reading</button>
  </div>

  <!-- Article list (populated by JS) -->
  <div id="rl-list" class="rl-list"></div>
</div>
```

### Article card HTML (generated by JavaScript)

Each card rendered by `renderReadingList()`:

```html
<div class="rl-item [rl-read]" data-id="1712345678901" data-url="https://...">

  <!-- Thumbnail (clickable) -->
  <div class="rl-thumb-wrap" role="button" tabindex="0" aria-label="Read article">
    <!-- If image URL exists: -->
    <img class="rl-thumb" src="..." alt="" loading="lazy" onerror="this.style.display='none'">
    <!-- If no image: -->
    <div class="rl-thumb rl-thumb-placeholder">
      <svg><!-- image placeholder icon --></svg>
    </div>
  </div>

  <!-- Content -->
  <div class="rl-content">
    <div class="rl-title" role="button" tabindex="0">Article title here</div>
    <div class="rl-summary [rl-unread]">One-sentence summary…</div>
    <div class="rl-meta">
      <span class="rl-domain">elpais.com</span>
      <span class="rl-date">Apr 9, 2026</span>
    </div>
  </div>

  <!-- Remove button -->
  <button class="rl-remove-btn" data-id="1712345678901" title="Remove">
    <svg><!-- × icon --></svg>
  </button>
</div>
```

---

## 5. Visual Design

### Layout

- View container: `max-width: 860px`, centered, `padding: 32px 24px`
- Header: flexbox, space-between, wraps on mobile; left = title + subtitle, right = action buttons
- List: vertical flex column, `border-radius: 12px`, `overflow: hidden`, thin border + subtle shadow; items separated by a 1px hairline

### Article card

```
┌──────────────────────────────────────────────────────┐
│ [72×72 thumb] Title of the article (bold, 2 lines)   │
│               ┌─────────────────────────────┐  ×    │
│               │ Summary sentence (unread bg) │       │
│               └─────────────────────────────┘       │
│               elpais.com · Apr 9, 2026               │
└──────────────────────────────────────────────────────┘
```

- **Thumbnail**: 72×72px, `object-fit: cover`, 6px border-radius; placeholder SVG in `var(--surface-2)` when absent
- **Title**: 15px, `font-weight: 600`, clamps to 2 lines; turns primary red on hover
- **Summary (unread)**: pale amber background (`#fff9e6`), left orange border (`3px solid #f4a261`), 4px vertical padding; transitions away when marked read
- **Summary (read)**: plain text, no background
- **Meta**: 11px muted text for source name + date
- **Read state** (`.rl-read`): entire card at `opacity: 0.6`
- **Remove button**: muted ×, appears at right edge; on hover turns danger red

### Color tokens used

```css
--primary:       #c62828   /* red — brand, highlights */
--text:          #212529
--text-2:        #495057
--text-muted:    #868e96
--surface:       #ffffff
--surface-2:     #f1f3f5
--border:        #dee2e6
--border-light:  #e9ecef
--danger:        #d32f2f
--danger-light:  #ffebee
```

### Nav badge

A small filled white circle (8×8px) shown next to the "Read Later" nav button when unread articles exist. Hidden when count is 0.

---

## 6. Frontend JavaScript

### State

The reading list count is maintained with `updateRLCount()` which fetches the list and shows the nav dot if `list.filter(i => !i.read).length > 0`.

### Functions

#### `addToReadingList(url)`
Called when the user saves a URL. Shows a "Fetching article info…" toast, POSTs to `/api/reading-list`, shows "Saved!" or "Already saved" toast on completion.

#### `loadReadingList()`
Called when the Read Later view becomes active. Shows spinner, GETs `/api/reading-list`, calls `renderReadingList()`, hides spinner.

#### `renderReadingList(list)`
Builds and injects the card HTML. After injection:
- Attaches click handlers to `.rl-thumb-wrap`, `.rl-title`, `.rl-summary` → opens the article and fires a fire-and-forget PATCH to mark as read
- Attaches click handlers to `.rl-remove-btn` → fires DELETE and removes the card from the DOM
- Updates subtitle count and shows empty state if list becomes empty

#### Source name display

```javascript
function cleanDomain(hostname) {
  // Strip all subdomains: nl.nytimes.com → nytimes.com
  // Keep 3 parts for country-code SLDs: bbc.co.uk stays bbc.co.uk
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  if (['co','com','net','org','gov','edu','ac'].includes(sld) && tld.length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

const domain     = cleanDomain(new URL(item.url).hostname);
const sourceName = item.siteName || domain;   // prefer og:site_name
```

---

## 7. URL Parameter Bookmarklet

When the app loads and `?url=https://...` is in the query string, it automatically saves that URL to the reading list and navigates to the Read Later view. This enables a browser bookmarklet:

```javascript
javascript:(function(){
  window.open('https://YOUR-APP.netlify.app/?url='+encodeURIComponent(location.href));
})();
```

**Implementation:**

```javascript
(function handleUrlParam() {
  const params  = new URLSearchParams(window.location.search);
  const urlParam = params.get('url');
  if (!urlParam) return;
  history.replaceState({}, '', window.location.pathname); // clean the address bar
  addToReadingList(urlParam).then(() => {
    loadReadingList();
    showView('reading-list');
  });
})();
```

---

## 8. Gmail Newsletter Import

An optional sub-feature. A scheduled Netlify Function (`netlify/functions/gmail-import.js`) checks a Gmail inbox via IMAP, finds Spanish-language newsletters, extracts the article URL and thumbnail, and appends them to the reading list.

### How it triggers

- **Scheduled**: cron `0 8,11,15,21 * * *` (4am, 7am, 11am, 5pm ET)
- **Manual**: "Check Gmail" button in the Read Later header POSTs to `/api/gmail-import`

```toml
[functions."gmail-import"]
  timeout = 26
  schedule = "0 8,11,15,21 * * *"

[[redirects]]
  from = "/api/gmail-import"
  to   = "/.netlify/functions/gmail-import"
  status = 200
```

### Detection logic

1. Fetch all inbox messages (up to 200), checking raw headers for `list-unsubscribe:` or `list-id:` (newsletter markers)
2. Check subject + sender for Spanish content: accented characters (`ñáéíóúü¿¡`) or ≥2 Spanish keyword matches from a curated list
3. For candidates, fetch the full message source, parse HTML with `mailparser` + `cheerio`
4. Extract the "view in browser" URL (looking for phrases like "ver en el navegador", "view in browser") as the canonical article URL
5. Fetch that URL's `og:title`, `og:image`, `og:description`, `og:site_name`
6. If no `og:image`, scan the email HTML for the first image that is ≥100px in each dimension and not banner-shaped (aspect ratio ≤ 3:1)
7. Generate a Spanish summary via Claude Haiku if `og:description` is absent

### After import

- Newly imported articles are prepended to the reading list
- Newsletters already in the list are skipped (deduplication by URL)
- All matched emails are marked as read and moved to `[Gmail]/All Mail`

### Additional environment variables

| Variable | Purpose |
|----------|---------|
| `GMAIL_APP_PASSWORD` | Gmail App Password (2FA must be on; generate at myaccount.google.com/apppasswords) |

### npm dependencies (additional)

```json
"imapflow": "^1.0.0",
"mailparser": "^3.7.0"
```

---

## 9. Complete CSS for the Read Later View

```css
/* ===== Read Later View ===== */
#view-reading-list { padding: 32px 24px; max-width: 860px; margin: 0 auto; }

.rl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  flex-wrap: wrap;
  gap: 16px;
}
.rl-header h2 { font-size: 24px; font-weight: 700; letter-spacing: -0.4px; }
.rl-header p  { color: var(--text-muted); font-size: 14px; margin-top: 4px; }
.rl-header-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.rl-loading { display: flex; justify-content: center; padding: 40px 0; }

.rl-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
  border: 1px solid var(--border);
}

.rl-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 16px;
  background: var(--surface);
  transition: background 0.12s;
  position: relative;
}
.rl-item + .rl-item { border-top: 1px solid var(--border-light); }
.rl-item.rl-read { opacity: 0.6; }

.rl-thumb-wrap { flex-shrink: 0; cursor: pointer; }

.rl-thumb {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 6px;
  display: block;
  background: var(--surface-2);
}

.rl-thumb-placeholder {
  width: 72px;
  height: 72px;
  border-radius: 6px;
  background: var(--surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.rl-content { flex: 1; min-width: 0; }

.rl-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
  margin-bottom: 5px;
  cursor: pointer;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rl-title:hover { color: var(--primary); }

.rl-summary {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  margin-bottom: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.2s, padding 0.2s;
}
.rl-summary.rl-unread {
  background: #fff9e6;
  padding: 4px 7px;
  border-left: 3px solid #f4a261;
}

.rl-meta { display: flex; gap: 10px; align-items: center; }
.rl-domain { font-size: 11px; color: var(--text-muted); }
.rl-date   { font-size: 11px; color: var(--text-muted); }

.rl-remove-btn {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: color 0.15s, background 0.15s;
  align-self: center;
}
.rl-remove-btn:hover { color: var(--danger); background: var(--danger-light); }
```

---

## 10. Adapting to a Different Stack

### If you're not using Netlify Functions

Replace the serverless function with any server-side route. The API contract (methods, paths, request/response shapes) stays the same.

### If you're not storing data in GitHub

Swap `ghRead` / `ghWrite` for any key-value store (Supabase, PlanetScale, Upstash Redis, a local SQLite file, etc.). The entry schema does not change.

### If you don't need Gmail import

Omit `gmail-import.js` and remove the "Check Gmail" button. Everything else is self-contained.

### If you don't need AI summaries

Remove the Claude Haiku call in `getSummary()` and fall back entirely to `og:description`, or leave the summary field empty.

### Minimum viable version

1. One API endpoint (GET + POST + DELETE)
2. One JSON file (or equivalent) for storage
3. `fetchMeta()` to extract title/image/description from any URL
4. The HTML card list with the CSS above

The Gmail import, bookmarklet, and AI summaries are all independent enhancements layered on top.
