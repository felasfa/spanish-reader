const GH_OWNER = process.env.GITHUB_OWNER || 'felasfa';
const GH_REPO  = process.env.GITHUB_REPO  || 'spanish-reader';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_API_KEY || process.env.GH_TOKEN;
const GH_BASE  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;
const DATA_PATH = 'data/site-settings.json';

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

async function ghRead() {
  const branch = await getDataBranch();
  const res = await fetch(`${GH_BASE}/${DATA_PATH}?ref=${branch}`, { headers: ghHeaders() });
  if (res.status === 404) return { data: {}, sha: null };
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const file = await res.json();
  return {
    data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
    sha: file.sha,
  };
}

async function ghWrite(data, sha) {
  const branch = await getDataBranch();
  const body = {
    message: 'Update site settings',
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(`${GH_BASE}/${DATA_PATH}`, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub write ${res.status}`);
}

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  if (event.httpMethod === 'GET') {
    try {
      const { data } = await ghRead();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod === 'PATCH') {
    try {
      const updates = JSON.parse(event.body || '{}');
      const { data, sha } = await ghRead();
      const merged = { ...data, ...updates };
      await ghWrite(merged, sha);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(merged) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
};
