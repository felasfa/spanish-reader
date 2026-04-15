# Spanish Reader

A personal tool for reading Spanish-language web content with inline translation, a saved-article queue, vocabulary tracking, and automatic import of Spanish newsletters from Gmail.

---

## Features

### Search / URL Entry
Enter any URL to fetch and display the article in a clean reader view. Links within the article open in the same reader; text can be selected to trigger inline translation.

### Read Later
Save articles to a personal reading queue. Articles can be added by:
- Entering a URL on the search screen
- Using a browser **bookmarklet** (drag from the search screen to your bookmarks bar) to save the current page from any site
- Automatic **Gmail import** (see below)

Each saved article shows a title, thumbnail, and AI-generated Spanish-language summary. Articles are marked as read after opening and can be deleted from the list.

### Gmail Newsletter Import
Scans a Gmail inbox via IMAP for unread Spanish-language newsletters and automatically adds them to the reading list. Useful for newsletters that arrive by email rather than having a browsable web page. Detection is heuristic — Spanish characters and common Spanish words are used to identify relevant messages.

### Inline Translation
Select any word or phrase in the reader view to get an instant translation panel powered by Claude. The panel shows the word translation, the full sentence translation, and a button to save the word to vocabulary.

### Vocabulary List
Words saved during reading are stored in a personal vocabulary list with the original Spanish word, its translation, the sentence it appeared in, and a link back to the source article. The list can be cleared or individual entries deleted.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (SPA — public/index.html + public/js/app.js)           │
│  Hosted on Netlify (static)                                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ API calls
          ┌────────────────┴──────────────┐
          │                               │
          ▼                               ▼
┌─────────────────────┐       ┌───────────────────────┐
│  Netlify Function   │       │  VPS (api.felasfa.app) │
│  /api/fetch         │       │  Node/Express, PM2     │
│  (article proxy)    │       │                        │
└─────────────────────┘       │  /api/reading-list     │
                              │  /api/vocabulary       │
                              │  /api/translate        │
                              │  /api/gmail-import     │
                              │  /api/reading-list/    │
                              │    scroll              │
                              └───────────────────────┘
```

### Backend options

The Express server (`server/server.js`) handles all stateful operations: reading list, vocabulary, translation, Gmail import, and scroll-position sync. It is currently deployed on a DigitalOcean VPS managed by PM2, with Nginx as a reverse proxy and Let's Encrypt SSL.

**Alternatively**, all of these endpoints can be implemented as Netlify Functions (stubs already exist in `netlify/functions/`) and hosted entirely on Netlify without a separate VPS. The trade-off is that Netlify Functions are stateless — data would need to be stored externally (e.g. in GitHub via the Contents API, which the server already supports as a migration path).

### Data storage

The VPS server stores data in local JSON files:
- `server/data/reading-list.json` — saved articles
- `server/data/vocabulary.json` — saved words
- `server/data/scroll-positions.json` — per-article scroll position (for cross-device sync)

A one-time migration from GitHub-hosted JSON (the previous storage backend) runs automatically on first start if local files are absent.

### Article fetching

The `/api/fetch` endpoint proxies the target URL, rewrites image/stylesheet URLs to absolute paths, removes scripts and CSP headers, strips email-client hidden elements, and injects a small interaction script that enables text selection, link interception, and scroll reporting — all needed because the article is displayed in a sandboxed `<iframe>`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS, single-page app |
| Static hosting | Netlify |
| API server | Node.js + Express |
| Process manager | PM2 |
| Reverse proxy | Nginx + Let's Encrypt |
| Translation & summaries | Anthropic Claude API (Sonnet for translation, Haiku for summaries) |
| HTML parsing | Cheerio |
| Gmail access | ImapFlow + mailparser |

---

## Environment Variables

### VPS server (`server/.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port for the Express server. Default: `3000` |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for translation and article summarisation |
| `GITHUB_TOKEN` | No | GitHub personal access token (repo read+write). Only needed if using GitHub as a data store instead of local files |
| `GITHUB_OWNER` | No | GitHub username. Default: `felasfa` |
| `GITHUB_REPO` | No | GitHub repository name. Default: `spanish-reader` |
| `GITHUB_DATA_BRANCH` | No | Branch to read/write data files. Default: `main` |
| `GMAIL_APP_PASSWORD` | Yes (for Gmail import) | Gmail App Password (not your account password). Enable 2FA and generate one at myaccount.google.com/apppasswords |
| `CORS_ORIGINS` | No | Comma-separated list of additional allowed origins, e.g. `https://myapp.netlify.app` |

### Netlify (environment variables in Netlify dashboard)

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Only if using Netlify Functions for translate | Claude API key |

Copy `server/.env.example` to `server/.env` and fill in the values before starting the server.

---

## Running locally

```bash
# Install dependencies
npm install
cd server && npm install

# Start the API server
cd server
cp .env.example .env   # fill in values
node server.js         # or: pm2 start server.js

# Serve the frontend (any static server)
npx serve public
# or open public/index.html directly in a browser
```

The frontend expects the API at `https://api.felasfa.app` by default. To point it at a local server, update `API_BASE` in `public/js/app.js`.
