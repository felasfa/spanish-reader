const { getStore } = require('@netlify/blobs');

const BLOB_KEY = 'entries';

async function getVocab(store) {
  try {
    const raw = await store.get(BLOB_KEY, { type: 'text' });
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveVocab(store, vocab) {
  await store.set(BLOB_KEY, JSON.stringify(vocab));
}

exports.handler = async (event) => {
  const store = getStore('vocabulary');
  const method = event.httpMethod;

  // Extract optional :id from path  e.g. /api/vocabulary/123
  const pathParts = (event.path || '').split('/').filter(Boolean);
  const idParam = pathParts[pathParts.length - 1];
  const hasId = idParam && /^\d+$/.test(idParam);

  try {
    if (method === 'GET') {
      const vocab = await getVocab(store);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vocab) };
    }

    if (method === 'POST') {
      const { word, translation, sentence, sentenceTranslation, url } = JSON.parse(event.body || '{}');
      if (!word) return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'word is required' }) };

      const vocab = await getVocab(store);
      const entry = {
        id: Date.now(),
        word,
        translation: translation || '',
        sentence: sentence || '',
        sentenceTranslation: sentenceTranslation || '',
        url: url || '',
        date: new Date().toISOString(),
      };
      vocab.unshift(entry);
      await saveVocab(store, vocab);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) };
    }

    if (method === 'DELETE') {
      if (hasId) {
        // Delete single entry
        const id = parseInt(idParam, 10);
        const vocab = await getVocab(store);
        await saveVocab(store, vocab.filter(v => v.id !== id));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
      } else {
        // Clear all
        await saveVocab(store, []);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
      }
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
