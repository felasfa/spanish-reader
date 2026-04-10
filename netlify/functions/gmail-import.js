const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Config ──────────────────────────────────────────────────────────────────
const GMAIL_USER = 'felasfa@gmail.com';
const GH_OWNER   = process.env.GITHUB_OWNER || 'felasfa';
const GH_REPO    = process.env.GITHUB_REPO  || 'spanish-reader';
const GH_TOKEN   = process.env.GITHUB_TOKEN;
const GH_BASE    = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;
const RL_FILE    = 'data/reading-list.json';

// ─── GitHub helpers (same pattern as other functions) ────────────────────────
let _branch = null;
async function getDataBranch() {
  if (_branch) return _branch;
  if (process.env.GITHUB_DATA_BRANCH) { _branch = process.env.GITHUB_DATA_BRANCH; return _branch; }
  const candidates = [process.env.BRANCH, process.env.HEAD].filter(Boolean);
  for (const b of candidates) {
    const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/branches/${encodeURIComponent(b)}`, { headers: ghHeaders() });
    if (r.ok) { _branch = b; return _branch; }
  }
  const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/branches`, { headers: ghHeaders() });
  if (r.ok) { const bs = await r.json(); if (bs.length) { _branch = bs[0].name; return _branch; } }
  _branch = 'main'; return _branch;
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'spanish-reader/1.0',
  };
}

async function ghRead(path) {
  const branch = await getDataBranch();
  const res = await fetch(`${GH_BASE}/${path}?ref=${branch}`, { headers: ghHeaders() });
  if (res.status === 404) return { data: [], sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}: ${await res.text()}`);
  const file = await res.json();
  return {
    data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
    sha: file.sha,
  };
}

async function ghWrite(path, data, sha, message) {
  const branch = await getDataBranch();
  const body = {
    message,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(`${GH_BASE}/${path}`, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`GitHub write ${res.status}: ${e.message || JSON.stringify(e)}`);
  }
  return res.json();
}

// ─── Spanish detection ────────────────────────────────────────────────────────
// Accented/special chars are a strong signal; fall back to keyword frequency
function isSpanishContent(text) {
  // Strong signal: accented chars or inverted punctuation
  if (/[ñáéíóúüÁÉÍÓÚÜ¿¡]/.test(text)) return true;
  const lower = text.toLowerCase();
  // Spanish words that rarely appear as standalone words in English text
  const keywords = [
    'el', 'la', 'de', 'un', 'una', 'con', 'que', 'por',    // articles / prepositions
    'del', 'las', 'los', 'hay', 'muy', 'como', 'para', 'pero', 'este', 'esta',
    'sobre', 'entre', 'cuando', 'mundo', 'hace', 'nuevo', 'nueva',
    'noticias', 'semana', 'edición', 'gobierno', 'internacional', // common in newsletters
  ];
  return keywords.filter(w => new RegExp(`\\b${w}\\b`).test(lower)).length >= 2;
}

// ─── URL extraction ───────────────────────────────────────────────────────────
// Priority 1: "view in browser" link (shows the full newsletter as a web page)
// Priority 2: first meaningful article link
function extractNewsletterUrl(html) {
  if (!html) return null;
  const $ = cheerio.load(html);

  const viewPattern = /ver\s*(en\s*(el\s*)?navegador|en\s*la\s*web|online)|versión\s*web|web\s*version|view\s*(in\s*(your\s*)?browser|on\s*the\s*web|online|this\s*email)|si\s*no\s*puedes?\s*ver/i;
  let url = null;

  $('a[href]').each((_, el) => {
    if (url) return false;
    const href = $(el).attr('href') || '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (href.startsWith('http') && viewPattern.test(text)) url = href;
  });
  if (url) return url;

  const skip = /unsubscrib|track|click\.|open\.|pixel|logo|icon|manage|preference|footer|privacy|terms|contact|social|facebook|twitter|instagram|linkedin/i;
  $('a[href]').each((_, el) => {
    if (url) return false;
    const href = $(el).attr('href') || '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (href.startsWith('http') && !skip.test(href) && text.length >= 15) url = href;
  });
  return url;
}

// ─── Metadata + summary ───────────────────────────────────────────────────────
async function fetchMeta(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SpanishReader/1.0)',
        'Accept-Language': 'es,en;q=0.5',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const og = (p) => $(`meta[property="${p}"]`).attr('content') || $(`meta[name="${p}"]`).attr('content') || '';
    const title       = (og('og:title') || $('h1').first().text() || $('title').text() || '').trim();
    const image       = og('og:image') || og('twitter:image') || '';
    const description = (og('og:description') || og('description')).trim();
    const siteName    = og('og:site_name').trim();
    return { title, image: image.startsWith('http') ? image : '', description, siteName };
  } catch {
    return null;
  }
}

async function getSummary(meta, emailSubject) {
  if (meta?.description && meta.description.length >= 25 && meta.description.length <= 300) {
    return meta.description;
  }
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `Escribe una frase en español (máximo 20 palabras) que resuma este boletín:\nTítulo: "${emailSubject}"${meta?.title && meta.title !== emailSubject ? '\nArtículo: "' + meta.title + '"' : ''}\nResponde solo con la frase.`,
      }],
    });
    return msg.content[0].text.trim();
  } catch {
    return '';
  }
}

// ─── Find first article link by headline text (long anchor, not a CTA) ───────
// Works even with tracking URLs like click.nytimes.com — fetchOgImage follows redirects.
function extractArticleLinkUrl(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const skipText = /shop\s*now|buy\s*now|learn\s*more|subscribe|unsubscrib|click\s*here|view\s*(online|in\s*browser)|sign\s*up|manage|privacy|terms|follow\s*us|see\s*all|read\s*more/i;
  let found = null;
  $('a[href]').each((_, el) => {
    if (found) return false;
    const href = $(el).attr('href') || '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    // Headline links have substantial text and aren't call-to-action buttons
    if (href.startsWith('http') && text.length >= 30 && !skipText.test(text)) found = href;
  });
  return found;
}

// Fast og:image fetch — follows redirects (handles tracking URLs) with a short timeout
async function fetchOgImage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpanishReader/1.0)' },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const html = await res.text();
    const $ = cheerio.load(html);
    const image = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || '';
    return image.startsWith('http') ? image : '';
  } catch { return ''; }
}

// ─── Extract best editorial image from email HTML ────────────────────────────
function extractEmailImage(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  const skipSrc = /logo|icon|avatar|signature|spacer|pixel|tracking|badge|unsubscri|header|footer/i;
  const skipAlt = /logo|subscribe|advertisement|sponsor|shop|sale|promo|offer/i;

  let best = null;
  let bestScore = -1;

  $('img[src]').each((_, el) => {
    const src    = $(el).attr('src') || '';
    const alt    = $(el).attr('alt') || '';
    const width  = parseInt($(el).attr('width')  || '0', 10);
    const height = parseInt($(el).attr('height') || '0', 10);

    if (!src.startsWith('http')) return;
    if (skipSrc.test(src) || skipAlt.test(alt)) return;
    if (width  > 0 && width  < 80) return;
    if (height > 0 && height < 80) return;

    // Skip when the parent link points to a shopping/commercial URL
    const parentHref = ($(el).closest('a').attr('href') || '').toLowerCase();
    if (/shop|store|buy|cart|sale|promo|discount|subscribe|offer/i.test(parentHref)) return;

    let score = 0;
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio > 3.5) return;          // skip banner ads (very wide)
      if (height < 100) return;          // skip short strips
      score = width * height;            // prefer larger images
      if (ratio >= 0.75 && ratio <= 2.5) score *= 2; // bonus for photo-like aspect ratio
    } else {
      score = 5000;                      // unknown size — neutral
    }

    if (score > bestScore) { bestScore = score; best = src; }
  });

  return best || '';
}

// ─── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Accept POST (manual "Check Gmail" button) or scheduled invocation (GET/no method)
  const method = event.httpMethod || 'GET';
  if (method !== 'POST' && method !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ok  = (body) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const err = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) });

  if (!process.env.GMAIL_APP_PASSWORD) return err(500, 'GMAIL_APP_PASSWORD not configured');

  const imap = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });

  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX');

    try {
      // ── Step 1: count inbox messages ─────────────────────────────────────
      const status = await imap.status('INBOX', { messages: true });
      const total  = status.messages;
      if (total === 0) return ok({ imported: 0, message: 'Inbox is empty' });

      // Scan all messages (inbox is small; cap at 200 to be safe)
      const start = Math.max(1, total - 199);

      // ── Step 2: fetch headers as Buffer — check for newsletter markers ────
      const candidates = [];
      for await (const msg of imap.fetch(`${start}:${total}`, {
        envelope: true,
        headers: true,   // returns Buffer — parse with string search
        uid: true,
      })) {
        // msg.headers is a Buffer; convert to lowercase string for searching
        const rawHeaders = msg.headers ? msg.headers.toString('utf8').toLowerCase() : '';
        const isNewsletter = rawHeaders.includes('list-unsubscribe:') || rawHeaders.includes('list-id:');
        if (!isNewsletter) continue;

        // Subject + sender must suggest Spanish content
        const fromName    = msg.envelope.from?.[0]?.name || '';
        const fromAddress = msg.envelope.from?.[0]?.address || '';
        const subject     = msg.envelope.subject || '';
        const combined    = `${subject} ${fromName} ${fromAddress}`;

        if (isSpanishContent(combined)) {
          candidates.push({ uid: msg.uid, subject: subject.trim() });
        }
      }

      if (!candidates.length) {
        return ok({ imported: 0, message: 'No Spanish newsletters found in inbox' });
      }

      // ── Step 3: fetch full source for candidates ──────────────────────────
      const sources = new Map();
      for await (const msg of imap.fetch(
        candidates.map(c => c.uid),
        { source: true },
        { uid: true }
      )) {
        sources.set(msg.uid, msg.source);
      }

      // ── Step 4: parse HTML and extract URLs + metadata (parallel) ─────────
      const enriched = (await Promise.all(
        candidates.map(async (c) => {
          const source = sources.get(c.uid);
          if (!source) return null;
          try {
            const mail = await simpleParser(source);
            const html = mail.html || mail.textAsHtml || '';
            const url  = extractNewsletterUrl(html);
            if (!url) return null;

            const meta    = await fetchMeta(url);
            const hostname = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
            const title   = (meta?.title && meta.title.length > 5 && !meta.title.includes(hostname))
              ? meta.title : c.subject;
            const summary  = await getSummary(meta, c.subject);
            const siteName = meta?.siteName || '';

            // Image: try newsletter page og:image → first article's og:image → email HTML scan
            let image = meta?.image || '';
            if (!image) {
              const articleUrl = extractArticleLinkUrl(html);
              if (articleUrl) image = await fetchOgImage(articleUrl);
            }
            if (!image) image = extractEmailImage(html);

            return { uid: c.uid, url, title, image, siteName, summary };
          } catch (e) {
            console.error(`Failed to process newsletter uid=${c.uid}:`, e.message);
            return null;
          }
        })
      )).filter(Boolean);

      if (!enriched.length) {
        return ok({ imported: 0, message: 'Could not extract article URLs from newsletters' });
      }

      // ── Step 5: deduplicate against existing list, write in one commit ────
      const { data, sha } = await ghRead(RL_FILE);
      const existingUrls  = new Set(data.map(i => i.url));

      const newEntries   = [];
      const toArchive    = []; // UIDs of all newsletters to archive (new + already imported)

      for (let i = 0; i < enriched.length; i++) {
        const item = enriched[i];
        if (existingUrls.has(item.url)) {
          // Already in reading list from a previous import — just archive it
          toArchive.push(item.uid);
          continue;
        }
        newEntries.push({
          id:        Date.now() + i,
          url:       item.url,
          title:     item.title,
          image:     item.image,
          summary:   item.summary,
          siteName:  item.siteName,
          dateAdded: new Date().toISOString(),
          read:      false,
          source:    'gmail',
        });
        toArchive.push(item.uid);
        existingUrls.add(item.url); // prevent self-duplicates within this batch
      }

      if (newEntries.length > 0) {
        await ghWrite(
          RL_FILE,
          [...newEntries, ...data],
          sha,
          `Import ${newEntries.length} newsletter(s) from Gmail`
        );
      }

      // Archive all matched newsletters (mark read + move out of inbox)
      if (toArchive.length > 0) {
        await imap.messageFlagsAdd(toArchive, ['\\Seen'], { uid: true });
        try {
          await imap.messageMove(toArchive, '[Gmail]/All Mail', { uid: true });
        } catch (e) {
          console.warn('Archive move failed (non-fatal):', e.message);
        }
      }

      return ok({
        imported: newEntries.length,
        archived: toArchive.length,
      });

    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('gmail-import error:', e);
    return err(500, e.message);
  } finally {
    try { await imap.logout(); } catch {}
  }
};
