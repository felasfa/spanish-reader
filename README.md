# Spanish Reader

A personal web app for reading Spanish-language articles with AI-powered word translation and vocabulary tracking. Built as a lightweight, self-hosted tool — no database required.

## What it does

- **Read any article**: Paste a URL to fetch and display the page in a clean reader view
- **Instant translations**: Tap any Spanish word to get an English translation powered by the Claude API
- **Vocabulary tracker**: Looked-up words are saved to a personal vocabulary list
- **Reading list**: Save URLs manually, via a browser bookmarklet, or by auto-importing Spanish newsletters from Gmail
- **Resume where you left off**: Scroll positions sync across devices
- **Article metadata**: Auto-fetches title, thumbnail, one-sentence summary, and source name for each saved article

## Architecture

```
Browser (Netlify — static hosting, free tier)
    │
    └─► Express API (DigitalOcean VPS, $6/month)
            ├── Claude API (translations & summaries)
            ├── Gmail IMAP (newsletter import)
            └── Local JSON files (reading list, vocabulary, scroll positions)
```

**Frontend** — Vanilla HTML/CSS/JS served from Netlify. No framework, no build step.  
**Backend** — Node.js + Express, managed by PM2 behind Nginx with Let's Encrypt SSL.  
**Storage** — Flat JSON files on the VPS. No database needed.

## Setup

### Backend

```bash
cd server
cp .env.example .env   # fill in your API keys
npm install
node server.js         # or: pm2 start server.js --name spanish-reader
```

Required environment variables (see `server/.env.example`):

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key for translations |
| `GMAIL_APP_PASSWORD` | Gmail App Password for newsletter import |
| `CORS_ORIGINS` | Comma-separated list of allowed frontend origins |
| `PORT` | Port for the Express server (default: 3000) |

### Frontend

Deploy the `public/` folder to any static host (Netlify, GitHub Pages, etc.). Update `netlify.toml` or your host's redirect config to point API calls to your VPS URL.

## Using as a template

This repo is designed to be reused. The `read-later-feature-spec.md` file contains a full specification that can be used to implement the same reading list + translation pattern in a different project.
