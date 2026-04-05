const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATA_DIR = path.join(__dirname, 'data');
const VOCAB_FILE = path.join(DATA_DIR, 'vocabulary.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(VOCAB_FILE)) fs.writeFileSync(VOCAB_FILE, '[]');

function readVocab() {
  return JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
}

function writeVocab(vocab) {
  fs.writeFileSync(VOCAB_FILE, JSON.stringify(vocab, null, 2));
}

// Resolve a URL relative to a base
function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

// Proxy: fetch and process a URL
app.get('/api/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es,en;q=0.5',
      },
      follow: 10,
      timeout: 15000,
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Fetch failed: ${response.statusText}` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Make all resource URLs absolute
    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (src && !src.startsWith('data:')) $(el).attr('src', resolveUrl(src, url));
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const resolved = srcset.split(',').map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [resolveUrl(u, url), ...rest].join(' ');
        }).join(', ');
        $(el).attr('srcset', resolved);
      }
    });

    $('source').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const resolved = srcset.split(',').map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [resolveUrl(u, url), ...rest].join(' ');
        }).join(', ');
        $(el).attr('srcset', resolved);
      }
    });

    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) $(el).attr('href', resolveUrl(href, url));
    });

    $('link[rel="icon"], link[rel="shortcut icon"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) $(el).attr('href', resolveUrl(href, url));
    });

    // Remove scripts to prevent conflicts, but keep noscript content
    $('script').remove();

    // Remove problematic meta tags that might interfere
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    // Inject interaction script before </body>
    const interactionScript = `
<style>
  .sr-word-highlight {
    background-color: rgba(255, 220, 0, 0.4);
    border-radius: 2px;
    cursor: pointer;
  }
</style>
<script>
(function() {
  function getTextAndSentence(selection) {
    if (!selection || selection.isCollapsed) return null;
    const word = selection.toString().trim();
    if (!word) return null;

    // Walk up to find paragraph-level text
    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentNode;

    // Try to get surrounding sentence
    let text = '';
    const walker = document.createTreeWalker(
      container.closest('p, li, td, div, h1, h2, h3, h4, h5, h6, article, section, span') || container,
      NodeFilter.SHOW_TEXT,
      null
    );
    let node;
    while ((node = walker.nextNode())) {
      text += node.textContent;
    }
    if (!text) text = container.innerText || container.textContent || '';

    // Find sentence containing the selected word
    const sentenceRegex = /[^.!?¡¿]*[.!?]*/g;
    let sentence = text.trim();
    let match;
    while ((match = sentenceRegex.exec(text)) !== null) {
      if (match[0].includes(word)) {
        sentence = match[0].trim();
        break;
      }
    }

    return { word, sentence: sentence || text.trim() };
  }

  document.addEventListener('mouseup', function(e) {
    const selection = window.getSelection();
    const result = getTextAndSentence(selection);
    if (!result) return;
    window.parent.postMessage({ type: 'word-selected', word: result.word, sentence: result.sentence }, '*');
  });

  // Touch support
  document.addEventListener('touchend', function(e) {
    setTimeout(function() {
      const selection = window.getSelection();
      const result = getTextAndSentence(selection);
      if (!result) return;
      window.parent.postMessage({ type: 'word-selected', word: result.word, sentence: result.sentence }, '*');
    }, 100);
  });
})();
</script>`;

    $('body').append(interactionScript);

    // Add a base tag to help relative URLs in inline styles etc.
    if ($('base').length === 0) {
      $('head').prepend(`<base href="${url}">`);
    }

    res.json({ html: $.html(), url });
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Translation via Claude
app.post('/api/translate', async (req, res) => {
  const { word, sentence } = req.body;
  if (!word) return res.status(400).json({ error: 'Word required' });

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are a Spanish-to-English translator. Translate the following:

Spanish word: "${word}"
Spanish sentence: "${sentence || word}"

Respond ONLY with valid JSON in this exact format:
{
  "wordTranslation": "English translation of the word",
  "sentenceTranslation": "English translation of the sentence"
}`
      }]
    });

    const content = message.content[0].text.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Translation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Vocabulary CRUD
app.get('/api/vocabulary', (req, res) => {
  res.json(readVocab());
});

app.post('/api/vocabulary', (req, res) => {
  const { word, translation, sentence, sentenceTranslation, url } = req.body;
  if (!word) return res.status(400).json({ error: 'Word required' });

  const vocab = readVocab();
  const entry = {
    id: Date.now(),
    word,
    translation,
    sentence: sentence || '',
    sentenceTranslation: sentenceTranslation || '',
    url: url || '',
    date: new Date().toISOString()
  };
  vocab.unshift(entry);
  writeVocab(vocab);
  res.json(entry);
});

app.delete('/api/vocabulary/:id', (req, res) => {
  let vocab = readVocab();
  vocab = vocab.filter(v => v.id !== parseInt(req.params.id));
  writeVocab(vocab);
  res.json({ success: true });
});

app.delete('/api/vocabulary', (req, res) => {
  writeVocab([]);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Spanish Reader running on http://localhost:${PORT}`));
