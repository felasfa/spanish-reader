const cheerio = require('cheerio');

function resolveUrl(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

const INTERACTION_SCRIPT = `
<style>
  ::selection { background: rgba(198,40,40,.2); }
</style>
<script>
(function () {
  function getSentence(selectionText, container) {
    let text = '';
    const walker = document.createTreeWalker(
      container.closest('p,li,td,h1,h2,h3,h4,h5,h6,article,blockquote,section') || container,
      NodeFilter.SHOW_TEXT
    );
    let n;
    while ((n = walker.nextNode())) text += n.textContent;
    if (!text) text = container.innerText || container.textContent || selectionText;

    // Find sentence containing the selection
    const sentences = text.match(/[^.!?¡¿\n]+[.!?\n]*/g) || [];
    for (const s of sentences) {
      if (s.includes(selectionText)) return s.trim();
    }
    return text.trim().slice(0, 300);
  }

  function onSelectionEnd() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const word = sel.toString().trim();
    if (!word) return;

    const range = sel.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentNode;

    const sentence = getSentence(word, container);
    window.parent.postMessage({ type: 'word-selected', word, sentence }, '*');
  }

  document.addEventListener('mouseup', onSelectionEnd);
  document.addEventListener('touchend', function () {
    setTimeout(onSelectionEnd, 120);
  });
})();
</script>`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const url = (event.queryStringParameters || {}).url;
  if (!url) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'URL required' }) };
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Remote server returned ${response.status}: ${response.statusText}` }),
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Make image src/srcset absolute
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

    // Make stylesheet hrefs absolute
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) $(el).attr('href', resolveUrl(href, url));
    });

    // Remove scripts (prevent conflicts) and CSP meta tags
    $('script').remove();
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    // Add base tag so remaining relative URLs resolve correctly
    if ($('base').length === 0) {
      $('head').prepend(`<base href="${url}">`);
    }

    $('body').append(INTERACTION_SCRIPT);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: $.html(), url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
