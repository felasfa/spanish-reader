// ─── GitHub helpers ───────────────────────────────────────────────────────────
const GH_OWNER = process.env.GITHUB_OWNER || 'felasfa';
const GH_REPO  = process.env.GITHUB_REPO  || 'spanish-reader';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API_KEY || process.env.GH_TOKEN;
const GH_BASE  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;

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

// ─── Handler ─────────────────────────────────────────────────────────────────
const VOCAB_FILE = 'data/vocabulary.json';

exports.handler = async (event) => {
  const method  = event.httpMethod;
  const parts   = (event.path || '').split('/').filter(Boolean);
  const last    = parts[parts.length - 1];
  const idParam = /^\d+$/.test(last) ? parseInt(last, 10) : null;

  const ok  = (body) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const err = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) });

  try {
    if (method === 'GET') {
      const { data } = await ghRead(VOCAB_FILE);
      return ok(data);
    }

    if (method === 'POST') {
      const { word, translation, sentence, sentenceTranslation, url } = JSON.parse(event.body || '{}');
      if (!word) return err(400, 'word required');
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
      return ok(entry);
    }

    if (method === 'DELETE' && idParam) {
      const { data, sha } = await ghRead(VOCAB_FILE);
      await ghWrite(VOCAB_FILE, data.filter(v => v.id !== idParam), sha, 'Remove vocabulary entry');
      return ok({ success: true });
    }

    if (method === 'DELETE') {
      const { sha } = await ghRead(VOCAB_FILE);
      await ghWrite(VOCAB_FILE, [], sha, 'Clear vocabulary');
      return ok({ success: true });
    }

    return err(405, 'Method Not Allowed');
  } catch (e) {
    console.error('vocabulary:', e);
    return err(500, e.message);
  }
};
