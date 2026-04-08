const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');

// ─── GitHub helpers ───────────────────────────────────────────────────────────
const GH_OWNER = process.env.GITHUB_OWNER || 'felasfa';
const GH_REPO  = process.env.GITHUB_REPO  || 'spanish-reader';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API_KEY || process.env.GH_TOKEN;
const GH_BASE  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;

// Auto-detect the correct branch (cached per Lambda warm instance).
// Priority: explicit env var → Netlify BRANCH → first branch returned by API.
let _branch = null;
async function getDataBranch() {
  if (_branch) return _branch;
  if (process.env.GITHUB_DATA_BRANCH) { _branch = process.env.GITHUB_DATA_BRANCH; return _branch; }

  const candidates = [process.env.BRANCH, process.env.HEAD].filter(Boolean);
  for (const b of candidates) {
    const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/branches/${encodeURIComponent(b)}`, { headers: ghHeaders() });
    if (r.ok) { _branch = b; return _branch; }
  }
  // Fall back to whichever branch the repo actually has
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
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub write ${res.status}: ${err.message || JSON.stringify(err)}`);
  }
  return res.json();
}

// ─── Article metadata ─────────────────────────────────────────────────────────
async function fetchMeta(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SpanishReader/1.0)',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es,en;q=0.5',
    },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Could not fetch article: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const og = (prop) =>
    $(`meta[property="${prop}"]`).attr('content') ||
    $(`meta[name="${prop}"]`).attr('content') || '';

  const title = (og('og:title') || $('h1').first().text() || $('title').text() || new URL(url).hostname).trim();

  let image = og('og:image') || og('twitter:image');
  if (!image) {
    // Find first meaningful image (skip tiny icons/logos)
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
  return { title, image, description };
}

async function getSummary(meta, url) {
  // Use og:description if it looks like a real sentence
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

// ─── Handler ─────────────────────────────────────────────────────────────────
const RL_FILE = 'data/reading-list.json';

exports.handler = async (event) => {
  const method = event.httpMethod;
  const parts   = (event.path || '').split('/').filter(Boolean);
  const last    = parts[parts.length - 1];
  const idParam = /^\d+$/.test(last) ? parseInt(last, 10) : null;

  const ok  = (body) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const err = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) });

  try {
    // GET — list all
    if (method === 'GET') {
      const { data } = await ghRead(RL_FILE);
      return ok(data);
    }

    // POST — add article
    if (method === 'POST') {
      const { url } = JSON.parse(event.body || '{}');
      if (!url) return err(400, 'url required');

      const { data, sha } = await ghRead(RL_FILE);
      if (data.some(i => i.url === url)) return ok({ duplicate: true });

      const meta    = await fetchMeta(url);
      const summary = await getSummary(meta, url);

      const entry = {
        id: Date.now(),
        url,
        title:     meta.title,
        image:     meta.image || '',
        summary,
        dateAdded: new Date().toISOString(),
        read:      false,
      };
      data.unshift(entry);
      await ghWrite(RL_FILE, data, sha, `Add to reading list: ${meta.title}`);
      return ok(entry);
    }

    // PATCH /:id — mark as read
    if (method === 'PATCH' && idParam) {
      const { data, sha } = await ghRead(RL_FILE);
      const item = data.find(i => i.id === idParam);
      if (!item) return err(404, 'Not found');
      item.read = true;
      await ghWrite(RL_FILE, data, sha, 'Mark article as read');
      return ok(item);
    }

    // DELETE /:id — remove one
    if (method === 'DELETE' && idParam) {
      const { data, sha } = await ghRead(RL_FILE);
      await ghWrite(RL_FILE, data.filter(i => i.id !== idParam), sha, 'Remove from reading list');
      return ok({ success: true });
    }

    // DELETE — clear all
    if (method === 'DELETE') {
      const { sha } = await ghRead(RL_FILE);
      await ghWrite(RL_FILE, [], sha, 'Clear reading list');
      return ok({ success: true });
    }

    return err(405, 'Method Not Allowed');
  } catch (e) {
    console.error('reading-list:', e);
    return err(500, e.message);
  }
};
