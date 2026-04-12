require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const cheerio  = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:8888',
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]);

app.use(cors({
  origin(origin, cb) {
    // Allow all origins — needed for the bookmarklet which runs on third-party sites.
    // The API holds only personal reading-list data so broad access is acceptable.
    cb(null, true);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ─── Request logger ───────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── GitHub helpers ───────────────────────────────────────────────────────────
const GH_OWNER   = process.env.GITHUB_OWNER || 'felasfa';
const GH_REPO    = process.env.GITHUB_REPO  || 'spanish-reader';
const GH_TOKEN   = process.env.GITHUB_TOKEN;
const GH_BASE    = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;
const DATA_BRANCH = process.env.GITHUB_DATA_BRANCH || 'main';

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
  const res = await fetch(`${GH_BASE}/${path}?ref=${DATA_BRANCH}`, { headers: ghHeaders() });
  if (res.status === 404) return { data: [], sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}: ${await res.text()}`);
  const file = await res.json();
  return {
    data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
    sha: file.sha,
  };
}

async function ghWrite(path, data, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: DATA_BRANCH,
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

// ─── /api/fetch ───────────────────────────────────────────────────────────────
function resolveUrl(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

const INTERACTION_SCRIPT = `
<style>
  ::selection { background: rgba(198,40,40,.2); }
  #_sr_menu {
    display: none; position: fixed; background: #fff;
    border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22);
    z-index: 2147483647; overflow: hidden; min-width: 195px;
    border: 1px solid rgba(0,0,0,.09);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  ._sr_mi {
    padding: 13px 16px; cursor: pointer; font-size: 15px;
    display: flex; align-items: center; gap: 10px; color: #1d1d1f;
    user-select: none; -webkit-user-select: none;
  }
  ._sr_mi:active { background: #f0f0f0; }
  ._sr_mi + ._sr_mi { border-top: 1px solid #f0f0f0; }
</style>
<div id="_sr_menu">
  <div class="_sr_mi" id="_sr_open">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
    Open article
  </div>
  <div class="_sr_mi" id="_sr_save">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
    Save for Later
  </div>
</div>
<script>
(function () {
  window._srLongPress = false;
  var menu   = document.getElementById('_sr_menu');
  var curHref = null;

  function showMenu(href, x, y) {
    curHref = href;
    var mw = 200, mh = 110;
    menu.style.left = Math.min(x, window.innerWidth  - mw - 12) + 'px';
    menu.style.top  = Math.min(y, window.innerHeight - mh - 12) + 'px';
    menu.style.display = 'block';
  }

  function hideMenu() { menu.style.display = 'none'; curHref = null; }

  document.getElementById('_sr_open').addEventListener('click', function (e) {
    e.stopPropagation();
    if (curHref) window.parent.postMessage({ type: 'link-clicked',   href: curHref }, '*');
    hideMenu();
  });
  document.getElementById('_sr_save').addEventListener('click', function (e) {
    e.stopPropagation();
    if (curHref) window.parent.postMessage({ type: 'save-for-later', href: curHref }, '*');
    hideMenu();
  });

  document.addEventListener('click',     function (e) { if (!e.target.closest('#_sr_menu')) hideMenu(); });
  document.addEventListener('touchstart', function (e) { if (!e.target.closest('#_sr_menu')) hideMenu(); }, { passive: true });

  document.addEventListener('contextmenu', function (e) {
    var a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    showMenu(a.getAttribute('data-href'), e.clientX, e.clientY);
  });

  var pressTimer;
  document.addEventListener('touchstart', function (e) {
    var a = e.target.closest('a[data-href]');
    if (!a) return;
    var href = a.getAttribute('data-href');
    var x = e.touches[0].clientX, y = e.touches[0].clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      window._srLongPress = true;
      showMenu(href, x, y);
    }, 600);
  }, false);

  document.addEventListener('touchmove', function () { clearTimeout(pressTimer); }, { passive: true });
  document.addEventListener('touchend',  function () { clearTimeout(pressTimer); }, false);

  function getSentence(selectionText, container) {
    var text = '';
    var walker = document.createTreeWalker(
      container.closest('p,li,td,h1,h2,h3,h4,h5,h6,article,blockquote,section') || container,
      NodeFilter.SHOW_TEXT
    );
    var n;
    while ((n = walker.nextNode())) text += n.textContent;
    if (!text) text = container.innerText || container.textContent || selectionText;
    var sentences = text.match(/[^.!?¡¿\\n]+[.!?\\n]*/g) || [];
    for (var i = 0; i < sentences.length; i++) {
      if (sentences[i].includes(selectionText)) return sentences[i].trim();
    }
    return text.trim().slice(0, 300);
  }

  function sendSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var word = sel.toString().trim();
    if (!word) return;
    var range = sel.getRangeAt(0);
    var container = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentNode;
    window.parent.postMessage({ type: 'word-selected', word: word, sentence: getSentence(word, container) }, '*');
  }

  document.addEventListener('mouseup', function () { setTimeout(sendSelection, 20); });

  var selTimer;
  document.addEventListener('selectionchange', function () {
    clearTimeout(selTimer);
    selTimer = setTimeout(sendSelection, 600);
  });
})();
</script>`;

app.get('/api/fetch', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Remote server returned ${response.status}: ${response.statusText}` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (src && !src.startsWith('data:')) $(el).attr('src', resolveUrl(src, url));
      const srcset = $(el).attr('srcset');
      if (srcset) {
        $(el).attr('srcset', srcset.split(',').map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [resolveUrl(u, url), ...rest].join(' ');
        }).join(', '));
      }
    });

    $('source').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (srcset) {
        $(el).attr('srcset', srcset.split(',').map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [resolveUrl(u, url), ...rest].join(' ');
        }).join(', '));
      }
    });

    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) $(el).attr('href', resolveUrl(href, url));
    });

    $('script').remove();
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    // Newsletter / email HTML cleanup
    $('[style]').each((_, el) => {
      const style = $(el).attr('style') || '';
      if (/display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0|overflow\s*:\s*hidden[\s;]/.test(style)) {
        $(el).remove();
      }
    });
    $('img').each((_, el) => {
      const w = parseInt($(el).attr('width') || '99', 10);
      const h = parseInt($(el).attr('height') || '99', 10);
      if (w <= 1 || h <= 1) $(el).remove();
    });
    $('div, td, th, section, footer').each((_, el) => {
      if ($(el).text().trim() === '' && $(el).find('img').length === 0) {
        $(el).remove();
      }
    });
    $('head').append(`<style>
      html, body { height: auto !important; min-height: 0 !important; }
      body { padding: 0 !important; margin: 0 !important; }
      table { height: auto !important; }
      td, th { height: auto !important; }
    </style>`);

    if ($('base').length === 0) {
      $('head').prepend(`<base href="${url}">`);
    }

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:') ||
          href.startsWith('mailto:') || href.startsWith('tel:')) return;
      const absolute = resolveUrl(href, url);
      if (!absolute.startsWith('http')) return;
      const esc = absolute.replace(/'/g, '%27');
      $(el).attr('href', '#');
      $(el).attr('data-href', absolute);
      $(el).attr('onclick', `event.preventDefault();if(!window._srLongPress){window.parent.postMessage({type:'link-clicked',href:'${esc}'},'*');}window._srLongPress=false;return false;`);
    });

    $('body').append(INTERACTION_SCRIPT);

    res.json({ html: $.html(), url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/translate ───────────────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { word, sentence } = req.body || {};
  if (!word) return res.status(400).json({ error: 'word is required' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are a Spanish-to-English translator. Translate the following:

Spanish word: "${word}"
Spanish sentence: "${sentence || word}"

Respond ONLY with valid JSON in this exact format, no other text:
{
  "wordTranslation": "English translation of the word",
  "sentenceTranslation": "English translation of the sentence"
}`,
      }],
    });

    const text = message.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Unexpected response from Claude');

    res.setHeader('Content-Type', 'application/json');
    res.send(match[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/vocabulary ─────────────────────────────────────────────────────────
const VOCAB_FILE = 'data/vocabulary.json';

app.get('/api/vocabulary', async (_req, res) => {
  try {
    const { data } = await ghRead(VOCAB_FILE);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vocabulary', async (req, res) => {
  const { word, translation, sentence, sentenceTranslation, url } = req.body || {};
  if (!word) return res.status(400).json({ error: 'word required' });
  try {
    const { data, sha } = await ghRead(VOCAB_FILE);
    const entry = {
      id: Date.now(),
      word,
      translation: translation || '',
      sentence: sentence || '',
      sentenceTranslation: sentenceTranslation || '',
      url: url || '',
      date: new Date().toISOString(),
    };
    data.unshift(entry);
    await ghWrite(VOCAB_FILE, data, sha, `Add vocabulary: ${word}`);
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/vocabulary/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { data, sha } = await ghRead(VOCAB_FILE);
    await ghWrite(VOCAB_FILE, data.filter(v => v.id !== id), sha, 'Remove vocabulary entry');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/vocabulary', async (_req, res) => {
  try {
    const { sha } = await ghRead(VOCAB_FILE);
    await ghWrite(VOCAB_FILE, [], sha, 'Clear vocabulary');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/reading-list ────────────────────────────────────────────────────────
const RL_FILE = 'data/reading-list.json';

async function fetchMeta(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SpanishReader/1.0)',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es,en;q=0.5',
    },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Could not fetch article: ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const og = (prop) =>
    $(`meta[property="${prop}"]`).attr('content') ||
    $(`meta[name="${prop}"]`).attr('content') || '';

  const title = (og('og:title') || $('h1').first().text() || $('title').text() || new URL(url).hostname).trim();

  let image = og('og:image') || og('twitter:image');
  if (!image) {
    image = $('article img[src], main img[src], [class*="article"] img[src]').filter((_, el) => {
      const src = $(el).attr('src') || '';
      const w = parseInt($(el).attr('width') || '0', 10);
      return !src.includes('logo') && !src.includes('icon') && !src.includes('avatar') && (w === 0 || w > 100);
    }).first().attr('src') || $('img[src]').first().attr('src') || '';
  }
  if (image && !image.startsWith('http') && !image.startsWith('data:')) {
    try { image = new URL(image, url).href; } catch { image = ''; }
  }

  const description = (og('og:description') || og('description') || og('twitter:description')).trim();
  const siteName    = og('og:site_name').trim();
  return { title, image, description, siteName };
}

async function getSummary(meta, url) {
  if (meta.description && meta.description.length >= 25 && meta.description.length <= 300) {
    return meta.description;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `Escribe una frase en español (máximo 20 palabras) que resuma este artículo.\nTítulo: "${meta.title}"${meta.description ? '\nDescripción: "' + meta.description + '"' : ''}\nResponde solo con la frase.`,
    }],
  });
  return msg.content[0].text.trim();
}

app.get('/api/reading-list', async (_req, res) => {
  try {
    const { data } = await ghRead(RL_FILE);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reading-list', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { data, sha } = await ghRead(RL_FILE);
    if (data.some(i => i.url === url)) return res.json({ duplicate: true });

    const meta    = await fetchMeta(url);
    const summary = await getSummary(meta, url);
    const entry = {
      id: Date.now(),
      url,
      title:     meta.title,
      image:     meta.image || '',
      summary,
      siteName:  meta.siteName || '',
      dateAdded: new Date().toISOString(),
      read:      false,
    };
    data.unshift(entry);
    await ghWrite(RL_FILE, data, sha, `Add to reading list: ${meta.title}`);
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/reading-list/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { data, sha } = await ghRead(RL_FILE);
    const item = data.find(i => i.id === id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    item.read = true;
    await ghWrite(RL_FILE, data, sha, 'Mark article as read');
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/scroll — cross-device scroll position sync ────────────────────────
// Stored in data/scroll-positions.json as { "url": scrollY, ... }
// Works for any URL (not limited to reading-list items).
const SCROLL_FILE = 'data/scroll-positions.json';

app.get('/api/reading-list/scroll', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { data } = await ghRead(SCROLL_FILE);
    res.json({ scrollY: (data && data[url]) || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function handleScrollSave(req, res) {
  const { url, scrollY } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { data: positions, sha } = await ghRead(SCROLL_FILE);
    const store = positions || {};
    store[url] = Math.round(scrollY) || 0;
    await ghWrite(SCROLL_FILE, store, sha, 'Sync scroll position');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
app.patch('/api/reading-list/scroll', handleScrollSave);
app.post('/api/reading-list/scroll',  handleScrollSave);

app.delete('/api/reading-list/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { data, sha } = await ghRead(RL_FILE);
    await ghWrite(RL_FILE, data.filter(i => i.id !== id), sha, 'Remove from reading list');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/reading-list', async (_req, res) => {
  try {
    const { sha } = await ghRead(RL_FILE);
    await ghWrite(RL_FILE, [], sha, 'Clear reading list');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/gmail-import ────────────────────────────────────────────────────────
const GMAIL_USER = 'felasfa@gmail.com';

function isSpanishContent(text) {
  if (/[ñáéíóúüÁÉÍÓÚÜ¿¡]/.test(text)) return true;
  const lower = text.toLowerCase();
  const keywords = [
    'el', 'la', 'de', 'un', 'una', 'con', 'que', 'por',
    'del', 'las', 'los', 'hay', 'muy', 'como', 'para', 'pero', 'este', 'esta',
    'sobre', 'entre', 'cuando', 'mundo', 'hace', 'nuevo', 'nueva',
    'noticias', 'semana', 'edición', 'gobierno', 'internacional',
  ];
  return keywords.filter(w => new RegExp(`\\b${w}\\b`).test(lower)).length >= 2;
}

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

async function fetchMetaGmail(url) {
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

async function getSummaryGmail(meta, emailSubject) {
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

function extractEmailImage(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  const skip = /logo|icon|avatar|signature|spacer|pixel|tracking|badge/i;
  let found = '';
  $('img[src]').each((_, el) => {
    if (found) return false;
    const src    = $(el).attr('src') || '';
    const width  = parseInt($(el).attr('width')  || '0', 10);
    const height = parseInt($(el).attr('height') || '0', 10);
    if (!src.startsWith('http')) return;
    if (skip.test(src)) return;
    if (width  > 0 && width  < 100) return;
    if (height > 0 && height < 100) return;
    if (width > 0 && height > 0 && width / height > 3) return;
    found = src;
  });
  return found;
}

app.post('/api/gmail-import', async (_req, res) => {
  if (!process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: 'GMAIL_APP_PASSWORD not configured' });
  }

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
      const status = await imap.status('INBOX', { messages: true });
      const total  = status.messages;
      if (total === 0) return res.json({ imported: 0, message: 'Inbox is empty' });

      const start = Math.max(1, total - 199);

      const candidates = [];
      for await (const msg of imap.fetch(`${start}:${total}`, {
        envelope: true,
        headers: true,
        uid: true,
      })) {
        const rawHeaders = msg.headers ? msg.headers.toString('utf8').toLowerCase() : '';
        const isNewsletter = rawHeaders.includes('list-unsubscribe:') || rawHeaders.includes('list-id:');
        if (!isNewsletter) continue;

        const fromName    = msg.envelope.from?.[0]?.name || '';
        const fromAddress = msg.envelope.from?.[0]?.address || '';
        const subject     = msg.envelope.subject || '';
        const combined    = `${subject} ${fromName} ${fromAddress}`;

        if (isSpanishContent(combined)) {
          candidates.push({ uid: msg.uid, subject: subject.trim() });
        }
      }

      if (!candidates.length) {
        return res.json({ imported: 0, message: 'No Spanish newsletters found in inbox' });
      }

      const sources = new Map();
      for await (const msg of imap.fetch(
        candidates.map(c => c.uid),
        { source: true },
        { uid: true }
      )) {
        sources.set(msg.uid, msg.source);
      }

      const enriched = (await Promise.all(
        candidates.map(async (c) => {
          const source = sources.get(c.uid);
          if (!source) return null;
          try {
            const mail = await simpleParser(source);
            const html = mail.html || mail.textAsHtml || '';
            const url  = extractNewsletterUrl(html);
            if (!url) return null;

            const meta    = await fetchMetaGmail(url);
            const hostname = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
            const title   = (meta?.title && meta.title.length > 5 && !meta.title.includes(hostname))
              ? meta.title : c.subject;
            const summary  = await getSummaryGmail(meta, c.subject);
            const siteName = meta?.siteName || '';
            const image = meta?.image || extractEmailImage(html);

            return { uid: c.uid, url, title, image, siteName, summary };
          } catch (e) {
            console.error(`Failed to process newsletter uid=${c.uid}:`, e.message);
            return null;
          }
        })
      )).filter(Boolean);

      if (!enriched.length) {
        return res.json({ imported: 0, message: 'Could not extract article URLs from newsletters' });
      }

      const { data, sha } = await ghRead(RL_FILE);
      const existingUrls  = new Set(data.map(i => i.url));
      const newEntries    = [];
      const toArchive     = [];

      for (let i = 0; i < enriched.length; i++) {
        const item = enriched[i];
        if (existingUrls.has(item.url)) {
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
        existingUrls.add(item.url);
      }

      if (newEntries.length > 0) {
        await ghWrite(
          RL_FILE,
          [...newEntries, ...data],
          sha,
          `Import ${newEntries.length} newsletter(s) from Gmail`
        );
      }

      if (toArchive.length > 0) {
        await imap.messageFlagsAdd(toArchive, ['\\Seen'], { uid: true });
        try {
          await imap.messageMove(toArchive, '[Gmail]/All Mail', { uid: true });
        } catch (e) {
          console.warn('Archive move failed (non-fatal):', e.message);
        }
      }

      res.json({ imported: newEntries.length, archived: toArchive.length });

    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('gmail-import error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    try { await imap.logout(); } catch {}
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Spanish Reader API listening on port ${PORT}`);
  console.log(`Data branch: ${DATA_BRANCH}`);
});
