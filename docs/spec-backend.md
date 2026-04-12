# Spanish Reader — Backend Specification

## Architecture

Express.js server running on a VPS, managed by pm2. Deployed at `https://api.felasfa.app`.

```
server/
  server.js              # single-file Express app
  scroll-positions.json  # local filesystem (gitignored)
  data/
    reading-list.json    # local filesystem (gitignored)
    vocabulary.json      # local filesystem (gitignored)
```

Data is stored on the VPS local filesystem as JSON files. On first boot, the server performs a one-time migration from GitHub (where data was previously stored via the GitHub Contents API).

**Why not GitHub API for storage:** Every write creates a git commit → Netlify watches the repo → triggers a deploy on every user action. Moved to local filesystem to stop this.

---

## CORS

```javascript
app.use(cors({
  origin(origin, cb) { cb(null, true); },  // allow all origins (bookmarklet runs on 3rd-party sites)
  credentials: true,   // CRITICAL: Safari sends credentials; server must reflect specific origin
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
```

**Safari requirement:** Safari sends `credentials: 'include'` automatically on cross-origin requests. If the server responds with `Access-Control-Allow-Origin: *` (not the specific origin) or omits `Access-Control-Allow-Credentials: true`, Safari silently drops the response. The `credentials: true` option in cors() causes it to reflect the request's `Origin` header instead of `*`.

---

## Data Storage Helpers

```javascript
const DATA_DIR    = path.join(__dirname, 'data');
const RL_LOCAL    = path.join(DATA_DIR, 'reading-list.json');
const VOCAB_LOCAL = path.join(DATA_DIR, 'vocabulary.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function localRead(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function localWrite(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
```

**Startup migration (one-time):**
```javascript
async function migrateIfNeeded(localFile, ghPath) {
  if (fs.existsSync(localFile)) return;
  try {
    const { data } = await ghRead(ghPath);
    localWrite(localFile, Array.isArray(data) ? data : []);
    console.log(`Migrated ${ghPath} → ${localFile}`);
  } catch (e) {
    console.warn(`Migration failed: ${e.message}`);
    localWrite(localFile, []);
  }
}

Promise.all([
  migrateIfNeeded(RL_LOCAL, 'data/reading-list.json'),
  migrateIfNeeded(VOCAB_LOCAL, 'data/vocabulary.json'),
]);
```

---

## Endpoints

### `GET /api/fetch?url=<url>`

Proxies an external URL, transforms HTML for iframe display.

**Transformations:**
- Resolve all relative `img src`, `srcset`, `link href` to absolute URLs (using `<base>` element + manual resolution)
- Remove `<script>` tags, CSP meta tags, X-Frame-Options meta tags
- Remove hidden elements (inline `display:none`, `visibility:hidden`, `max-height:0`)
- Remove 1×1 tracking pixels
- Inject `INTERACTION_SCRIPT` (link interception, text selection, scroll reporting — see frontend spec)
- Convert all `<a href>` to `data-href` with onclick posting to parent
- Add CSS reset to fix height/overflow issues in email newsletters

**Returns:** `{ html: string, url: string }`

---

### `POST /api/translate`

Translates a Spanish word in context using Claude.

**Request:** `{ word: string, sentence?: string }`

**Claude prompt:**
```
You are a Spanish-to-English translator.
Spanish word: "<word>"
Spanish sentence: "<sentence>"
Respond ONLY with valid JSON: { "wordTranslation": "...", "sentenceTranslation": "..." }
```

**Model:** `claude-sonnet-4-6` (best quality for nuanced translation)
**Max tokens:** 512

**Returns:** `{ wordTranslation: string, sentenceTranslation: string }`

---

### `GET /api/vocabulary`

Returns all saved vocabulary entries, newest first.

**Returns:** `Array<VocabEntry>`

```typescript
interface VocabEntry {
  id: number;           // Date.now() at creation
  word: string;
  translation: string;
  sentence: string;            // Spanish sentence containing the word
  sentenceTranslation: string; // English translation of the sentence
  url: string;                 // article URL where word was found
  date: string;                // ISO timestamp
}
```

---

### `POST /api/vocabulary`

Adds a new vocabulary entry.

**Request:** `{ word, translation, sentence, sentenceTranslation, url }`

**Returns:** the created `VocabEntry`

---

### `DELETE /api/vocabulary/:id`

Deletes a single vocabulary entry by id.

---

### `DELETE /api/vocabulary`

Clears all vocabulary entries.

---

### `GET /api/reading-list`

Returns all reading-list entries, newest first.

**Returns:** `Array<ReadingListEntry>`

```typescript
interface ReadingListEntry {
  id: number;           // Date.now() at creation
  url: string;
  title: string;
  image: string;        // og:image or first suitable img
  summary: string;      // og:description or Claude-generated Spanish summary
  siteName: string;     // og:site_name
  dateAdded: string;    // ISO timestamp
  read: boolean;
  source?: 'gmail';     // present for Gmail-imported entries
}
```

---

### `POST /api/reading-list`

Adds an article by URL. Fetches metadata and generates a Spanish summary.

**Request:** `{ url: string }`

**Flow:**
1. Check for duplicate → return `{ duplicate: true }` if exists
2. `fetchMeta(url)` — fetches HTML, extracts og:title, og:image, og:description, og:site_name
3. `getSummary(meta, url)` — uses og:description if 25–300 chars, otherwise asks Claude Haiku for a ≤20-word Spanish summary
4. Save entry, return it

**Claude model for summaries:** `claude-haiku-4-5-20251001` (fast, cheap)

**Returns:** the created `ReadingListEntry`

---

### `PATCH /api/reading-list/:id`

Marks an article as read (`read: true`).

---

### `DELETE /api/reading-list/:id`

Removes a single entry.

---

### `DELETE /api/reading-list`

Clears all entries.

---

### `GET /api/reading-list/scroll?url=<url>`

Returns the saved fractional scroll position for a URL.

**Returns:** `{ scrollPct: number }` (0–1, default 0)

---

### `POST /api/reading-list/scroll` (also `PATCH`)

Saves the scroll position for a URL. Both POST and PATCH are accepted (sendBeacon uses POST; fetch-based saves use POST too).

**Request:** `{ url: string, scrollPct: number }`

**Storage:** `server/scroll-positions.json` (separate from data/ — stored relative to server.js `__dirname`)

**Returns:** `{ success: true }`

---

### `GET /api/debug/scroll`

Returns the full scroll-positions store (all URLs and their saved positions). Debug only.

---

### `POST /api/gmail-import`

Imports Spanish newsletters from Gmail inbox.

**Requires:** `GMAIL_APP_PASSWORD` env var (Gmail app password for `felasfa@gmail.com`)

**Flow:**
1. Connect to `imap.gmail.com:993` via ImapFlow
2. Fetch last 200 messages (headers only)
3. Filter to newsletter emails (`List-Unsubscribe:` or `List-Id:` header present)
4. Filter to Spanish content (`isSpanishContent()` — checks for Spanish characters/words in subject + sender)
5. Fetch full source for candidates
6. Parse each with `mailparser`, extract "view in browser" URL (`extractNewsletterUrl()`)
7. Fetch og metadata from the web URL
8. Generate Spanish summary via Claude Haiku if no suitable og:description
9. Add new entries to reading list (skip duplicates)
10. Mark processed emails as seen + move to All Mail

**URL extraction priority:**
1. Link text matching `/ver en (el )?navegador|versión web|view (in|on) (your |the )?(browser|web)/i`
2. First non-tracking link with text length ≥ 15 chars

**Returns:** `{ imported: number, archived: number }`

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default 3000) |
| `ANTHROPIC_API_KEY` | For /api/translate and summary generation |
| `GITHUB_TOKEN` | For startup migration only (reading existing data from GitHub) |
| `GITHUB_OWNER` | GitHub username (default: `felasfa`) |
| `GITHUB_REPO` | GitHub repo name (default: `spanish-reader`) |
| `GITHUB_DATA_BRANCH` | Branch where data was stored (default: `main`) |
| `GMAIL_APP_PASSWORD` | Gmail app password for IMAP access |
| `CORS_ORIGINS` | Comma-separated extra allowed origins |

---

## Deployment

- **Process manager:** pm2 (`pm2 restart spanish-reader-api`)
- **Deploy flow:** `git pull` → `cp server/server.js ~/api/server.js` → `pm2 restart`
- **Data persists** across deploys in `~/api/data/` (not in git)
- **Logs:** `pm2 logs spanish-reader-api`
