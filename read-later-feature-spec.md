# Read Later — Feature Specification

> Generated from the `spanish-reader` project.  
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

## 2. Architecture

### Backend: Express server on a VPS

All API routes are served by an Express.js server running on a DigitalOcean VPS (Ubuntu 24.04, $6/month). The server is managed by **PM2** and sits behind **Nginx** as a reverse proxy with a Let's Encrypt SSL certificate.

```
Browser (felasfa.netlify.app)
        │
        │  HTTPS  →  api.felasfa.app  (Nginx, port 443)
        │                │
        │                ▼
        │           Express server (PM2, port 3000)
        │                │
        │         ┌──────┴──────────────┐
        │         │                     │
        │    GitHub API            Claude API
        │  (data storage)       (summaries + translation)
        │
Netlify (static hosting only — HTML, CSS, JS)
```

**Key architectural decisions:**
- Netlify hosts only the static frontend (free tier, zero function invocations)
- The VPS handles all server-side work at a flat $6/month regardless of usage
- Secrets (GitHub token, Claude key, Gmail password) never leave the server
- CORS is configured to allow `*.netlify.app` origins

### Frontend: Netlify static hosting

The browser app (`public/`) is deployed to Netlify as a static site. All API calls use an `API_BASE` constant pointing to the VPS:

```javascript
const API_BASE = 'https://api.felasfa.app';
```

Every `fetch` call is prefixed: `fetch(`${API_BASE}/api/reading-list`)`.

---

## 3. Data Storage

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

### GitHub write pattern

Every write is a `PUT` to `https://api.github.com/repos/{owner}/{repo}/contents/data/reading-list.json` with:
- `content`: base64-encoded JSON (2-space pretty-printed)
- `sha`: the current file SHA (required by GitHub to detect conflicts)
- `branch`: read from `GITHUB_DATA_BRANCH` env var (always `main`)

---

## 4. Backend API

Implemented as Express routes in `server/server.js`, served at `https://api.felasfa.app`.

### Endpoints

#### `GET /api/reading-list`
Returns the full list as a JSON array, newest first.

#### `POST /api/reading-list`
Saves a new article. Request body: `{ "url": "https://..." }`

The server:
1. Checks for duplicates (returns `{ "duplicate": true }` if already saved)
2. Fetches the article page and extracts `og:title`, `og:image`, `og:description`, `og:site_name`
3. Falls back to `<h1>` / `<title>` for title; searches `article img` for image if `og:image` is absent
4. Calls Claude Haiku to generate a Spanish summary if `og:description` is missing or too short
5. Writes the new entry to the top of the JSON file via GitHub Contents API

Returns the saved entry object, or `{ "duplicate": true }`.

#### `PATCH /api/reading-list/:id`
Marks a single article as read (`read: true`). No request body needed.

#### `DELETE /api/reading-list/:id`
Removes one article by id.

#### `DELETE /api/reading-list`
Clears the entire list (writes `[]`).

### Environment variables (server `.env`)

| Variable | Purpose |
|----------|---------|
| `PORT` | Port Express listens on (default: 3000) |
| `GITHUB_TOKEN` | Personal access token with `repo` or `contents:write` scope |
| `GITHUB_OWNER` | Repository owner |
| `GITHUB_REPO` | Repository name |
| `GITHUB_DATA_BRANCH` | Branch where data files live (set to `main`) |
| `ANTHROPIC_API_KEY` | For Claude Haiku summary generation |
| `GMAIL_APP_PASSWORD` | Gmail App Password for IMAP import |
| `CORS_ORIGINS` | Comma-separated extra allowed origins (optional; `*.netlify.app` is always allowed) |

### npm dependencies (`server/package.json`)

```json
"@anthropic-ai/sdk": "^0.39.0",
"cheerio": "^1.0.0",
"cors": "^2.8.5",
"dotenv": "^16.4.5",
"express": "^4.19.2",
"imapflow": "^1.0.169",
"mailparser": "^3.7.1"
```

---

## 5. VPS Setup (reference)

The following steps provision a fresh Ubuntu 24.04 VPS to serve the API:

```bash
# 1. System update
apt update && apt upgrade -y

# 2. Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 3. PM2 (global process manager)
npm install -g pm2

# 4. Clone repo, install deps, configure .env
git clone https://github.com/YOUR_ORG/YOUR_REPO.git ~/spanish-reader
cd ~/spanish-reader/server
npm install
cp .env.example .env
nano .env   # fill in all values

# 5. Start with PM2 and enable on reboot
pm2 start server.js --name spanish-reader-api
pm2 save
pm2 startup   # run the printed command to enable systemd

# 6. Nginx + SSL
apt install -y nginx certbot python3-certbot-nginx
# create /etc/nginx/sites-available/api.example.com (see below)
ln -s /etc/nginx/sites-available/api.example.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d api.example.com --non-interactive --agree-tos -m you@email.com
```

**Nginx config template** (`/etc/nginx/sites-available/api.example.com`):
```nginx
server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
}
```
Certbot rewrites this file to add the HTTPS block automatically.

### Deploying updates

```bash
cd ~/spanish-reader && git pull
cp server/server.js ~/api/server.js   # if server files are served from ~/api
pm2 restart spanish-reader-api
```

---

## 6. Frontend — HTML Structure

```html
<!-- Nav: home icon (left edge) | brand | Read Later | Vocabulary | Search -->
<nav class="navbar">
  <div class="nav-left">
    <a href="https://example.com" class="nav-link" id="nav-home">
      <svg><!-- home icon --></svg>
      <span class="nav-label">Homepage</span>
    </a>
    <div class="nav-brand">
      <svg><!-- book icon --></svg>
      <span class="nav-brand-text">App Name</span>
    </div>
  </div>
  <div class="nav-links">
    <button class="nav-link nav-btn" id="nav-reading-list">
      <svg><!-- bookmark icon --></svg>
      <span class="nav-label">Read Later</span>
      <span class="vocab-count" id="nav-rl-count" style="display:none"></span>
    </button>
    <button class="nav-link nav-btn" id="nav-vocabulary">...</button>
    <button class="nav-link nav-btn" id="nav-new-url">
      <svg><!-- search icon --></svg>
      <span class="nav-label">New URL</span>
    </button>
  </div>
</nav>

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

  <div id="rl-loading" class="rl-loading" style="display:none">
    <div class="spinner"></div>
  </div>

  <div id="rl-empty" class="vocab-empty" style="display:none">
    <svg><!-- bookmark icon, large --></svg>
    <h3>Nothing saved yet</h3>
    <p>Paste a URL and tap Read Later, or hold a link while reading.</p>
    <button class="btn btn-primary" id="rl-go-read">Start Reading</button>
  </div>

  <div id="rl-list" class="rl-list"></div>
</div>
```

### Article card HTML (generated by JavaScript)

```html
<div class="rl-item [rl-read]" data-id="1712345678901" data-url="https://...">
  <div class="rl-thumb-wrap" role="button" tabindex="0" aria-label="Read article">
    <img class="rl-thumb" src="..." alt="" loading="lazy" onerror="this.style.display='none'">
    <!-- or placeholder if no image: -->
    <div class="rl-thumb rl-thumb-placeholder">
      <svg><!-- image placeholder icon --></svg>
    </div>
  </div>
  <div class="rl-content">
    <div class="rl-title" role="button" tabindex="0">Article title here</div>
    <div class="rl-summary [rl-unread]">One-sentence summary…</div>
    <div class="rl-meta">
      <span class="rl-domain">elpais.com</span>
      <span class="rl-date">Apr 9, 2026</span>
    </div>
  </div>
  <button class="rl-remove-btn" data-id="1712345678901" title="Remove">
    <svg><!-- × icon --></svg>
  </button>
</div>
```

---

## 7. Visual Design

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

## 8. Frontend JavaScript

### API base constant

```javascript
const API_BASE = 'https://api.example.com';  // your VPS domain
```

All fetch calls use this: `fetch(`${API_BASE}/api/reading-list`)`.

### Unread count — in-memory tracking

The unread count is **not** fetched separately. It is derived once when the list loads, then maintained in memory:

```javascript
let rlUnreadCount = 0;

function updateRLCount() {
  $('nav-rl-count').style.display = rlUnreadCount > 0 ? 'inline-block' : 'none';
}

// On list load:
rlUnreadCount = list.filter(i => !i.read).length;
updateRLCount();

// On mark-as-read:
rlUnreadCount = Math.max(0, rlUnreadCount - 1);
updateRLCount();

// On remove (if unread):
rlUnreadCount = Math.max(0, rlUnreadCount - 1);
updateRLCount();

// On add:
rlUnreadCount++;
updateRLCount();

// On clear:
rlUnreadCount = 0;
updateRLCount();
```

This avoids an extra network call every time an action is taken.

### Functions

#### `addToReadingList(url)`
Shows "Fetching article info…" toast, POSTs to `/api/reading-list`, shows "Saved!" or "Already saved" toast.

#### `loadReadingList()`
Shows spinner, GETs `/api/reading-list`, sets `rlUnreadCount`, calls `renderReadingList()`.

#### `renderReadingList(list)`
Builds and injects card HTML. After injection:
- Click on `.rl-thumb-wrap`, `.rl-title`, `.rl-summary` → open article + fire-and-forget PATCH to mark read
- Click on `.rl-remove-btn` → DELETE + remove card from DOM
- Updates subtitle count and shows empty state if needed

#### Source name display

```javascript
function cleanDomain(hostname) {
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
const sourceName = item.siteName || domain;
```

### Default view

On page load, show the Read Later list immediately:

```javascript
/* ===== Init ===== */
updateVocabCount();
loadReadingList();
showView('reading-list');
```

---

## 9. URL Parameter Bookmarklet

When the app loads with `?url=https://...` in the query string, it automatically saves that URL:

```javascript
(function handleUrlParam() {
  const params   = new URLSearchParams(window.location.search);
  const urlParam = params.get('url');
  if (!urlParam) return;
  history.replaceState({}, '', window.location.pathname);
  addToReadingList(urlParam).then(() => {
    loadReadingList();
    showView('reading-list');
  });
})();
```

**Bookmarklet:**
```javascript
javascript:(function(){
  window.open('https://YOUR-APP.netlify.app/?url='+encodeURIComponent(location.href));
})();
```

---

## 10. Gmail Newsletter Import

A "Check Gmail" button in the Read Later header POSTs to `/api/gmail-import`. The server connects via IMAP, finds Spanish newsletters, and imports them.

### Detection logic

1. Fetch all inbox messages (up to 200), checking raw headers for `list-unsubscribe:` or `list-id:`
2. Check subject + sender for Spanish content: accented characters (`ñáéíóúü¿¡`) or ≥2 Spanish keyword matches
3. Fetch full message source for candidates, parse with `mailparser` + `cheerio`
4. Extract the "view in browser" URL as the canonical article URL
5. Fetch `og:title`, `og:image`, `og:description`, `og:site_name` from that URL
6. If no `og:image`, scan email HTML for first image ≥100px that isn't banner-shaped (aspect ratio ≤ 3:1)
7. Generate Spanish summary via Claude Haiku if `og:description` is absent

### After import

- New articles prepended to the reading list
- Already-imported URLs skipped (deduplicated by URL)
- All matched emails marked as read and moved to `[Gmail]/All Mail`

### Frontend cooldown (Gmail button)

To prevent hammering the IMAP server, the button enforces a 5-minute client-side cooldown via `localStorage`:

```javascript
const COOLDOWN_MS = 5 * 60 * 1000;
const lastCheck   = parseInt(localStorage.getItem('gmailLastCheck') || '0', 10);
if (Date.now() - lastCheck < COOLDOWN_MS) {
  showToast(`Checked recently — try again in ${remaining} min`, 'info');
  return;
}
// ...on success:
localStorage.setItem('gmailLastCheck', Date.now().toString());
```

---

## 11. Complete CSS for the Read Later View

```css
/* ===== Nav left group ===== */
.nav-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

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
  width: 72px; height: 72px;
  object-fit: cover; border-radius: 6px;
  display: block; background: var(--surface-2);
}

.rl-thumb-placeholder {
  width: 72px; height: 72px; border-radius: 6px;
  background: var(--surface-2);
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted);
}

.rl-content { flex: 1; min-width: 0; }

.rl-title {
  font-size: 15px; font-weight: 600; color: var(--text);
  line-height: 1.4; margin-bottom: 5px; cursor: pointer;
  display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.rl-title:hover { color: var(--primary); }

.rl-summary {
  font-size: 13px; color: var(--text-2); line-height: 1.5;
  margin-bottom: 6px;
  display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
  cursor: pointer; border-radius: 4px;
  transition: background 0.2s, padding 0.2s;
}
.rl-summary.rl-unread {
  background: #fff9e6; padding: 4px 7px;
  border-left: 3px solid #f4a261;
}

.rl-meta { display: flex; gap: 10px; align-items: center; }
.rl-domain, .rl-date { font-size: 11px; color: var(--text-muted); }

.rl-remove-btn {
  flex-shrink: 0; background: none; border: none;
  cursor: pointer; color: var(--text-muted); padding: 4px;
  border-radius: 4px; display: flex; align-items: center;
  transition: color 0.15s, background 0.15s; align-self: center;
}
.rl-remove-btn:hover { color: var(--danger); background: var(--danger-light); }
```

---

## 12. Adapting to a Different Stack

### If you're not using a VPS

Any server-side runtime works (Netlify Functions, AWS Lambda, Vercel Edge Functions, Cloudflare Workers). The API contract — methods, paths, request/response shapes — stays the same. The `API_BASE` constant in the frontend points to wherever the routes live.

### If you're not storing data in GitHub

Swap `ghRead` / `ghWrite` for any key-value store (Supabase, PlanetScale, Upstash Redis, SQLite, etc.). The entry schema does not change.

### If you don't need Gmail import

Omit the `gmail-import` route and remove the "Check Gmail" button. Everything else is self-contained.

### If you don't need AI summaries

Remove the Claude Haiku call in `getSummary()` and fall back entirely to `og:description`, or leave the summary field empty.

### Minimum viable version

1. One API route (GET + POST + DELETE)
2. One JSON file (or equivalent) for storage
3. `fetchMeta()` to extract title/image/description from any URL
4. The HTML card list with the CSS above

The Gmail import, bookmarklet, AI summaries, and VPS infrastructure are all independent enhancements layered on top.
