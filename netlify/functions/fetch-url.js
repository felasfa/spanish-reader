const cheerio = require('cheerio');

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
  /* Suppress iOS native link preview/callout so our menu can appear */
  a[data-href] { -webkit-touch-callout: none; }
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
  // ── Context menu ──────────────────────────────────────────────
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

  // Dismiss on outside click/touch
  document.addEventListener('click',   function (e) { if (!e.target.closest('#_sr_menu')) hideMenu(); });
  document.addEventListener('touchend', function (e) { if (!e.target.closest('#_sr_menu')) hideMenu(); }, { passive: true });

  // Desktop right-click on a link
  document.addEventListener('contextmenu', function (e) {
    var a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    showMenu(a.getAttribute('data-href'), e.clientX, e.clientY);
  });

  // Mobile: tap on a link → show our menu immediately.
  // This intercepts the touch before iOS can show its native link preview.
  var touchStartX = 0, touchStartY = 0;
  document.addEventListener('touchstart', function (e) {
    var a = e.target.closest('a[data-href]');
    if (!a) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    var a = e.target.closest('a[data-href]');
    if (!a) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (dx * dx + dy * dy < 100) { // within ~10 px → it's a tap, not a scroll
      e.preventDefault();          // block iOS callout and the subsequent click
      window._srLongPress = true;  // guard the inline onclick too
      showMenu(a.getAttribute('data-href'), touchStartX, touchStartY);
    }
  }, false);

  // ── Text selection ────────────────────────────────────────────
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
    // Clear selection to dismiss iOS native context menu before it appears
    sel.removeAllRanges();
  }

  document.addEventListener('mouseup', function () { setTimeout(sendSelection, 20); });

  var selTimer;
  document.addEventListener('selectionchange', function () {
    clearTimeout(selTimer);
    selTimer = setTimeout(sendSelection, 600);
  });

  // ── Scroll position reporting ─────────────────────────────────────
  var scrollReportTimer;
  document.addEventListener('scroll', function () {
    clearTimeout(scrollReportTimer);
    scrollReportTimer = setTimeout(function () {
      window.parent.postMessage({ type: 'scroll-update', y: window.scrollY }, '*');
    }, 150);
  }, { passive: true });

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'scroll-to') window.scrollTo(0, e.data.y);
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
    const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-US,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com/',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
    };

    const response = await fetch(url, {
      headers: reqHeaders,
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

    // ── Newsletter / email HTML cleanup ───────────────────────────────────────
    // Remove hidden elements (email clients hide these; browsers show them as blank space)
    $('[style]').each((_, el) => {
      const style = $(el).attr('style') || '';
      if (/display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0|overflow\s*:\s*hidden[\s;]/.test(style)) {
        $(el).remove();
      }
    });
    // Remove tracking pixel images (1×1 or 0×0)
    $('img').each((_, el) => {
      const w = parseInt($(el).attr('width') || '99', 10);
      const h = parseInt($(el).attr('height') || '99', 10);
      if (w <= 1 || h <= 1) $(el).remove();
    });
    // Collapse empty structural elements that create vertical blank space
    $('div, td, th, section, footer').each((_, el) => {
      if ($(el).text().trim() === '' && $(el).find('img').length === 0) {
        $(el).remove();
      }
    });
    // Reset newsletter wrapper heights/padding so content flows naturally
    $('head').append(`<style>
      html, body { height: auto !important; min-height: 0 !important; }
      body { padding: 0 !important; margin: 0 !important; }
      table { height: auto !important; }
      td, th { height: auto !important; }
    </style>`);

    if ($('base').length === 0) {
      $('head').prepend(`<base href="${url}">`);
    }

    // Rewrite links: store absolute href in data-href; onclick checks _srLongPress
    // so that a long-press shows the context menu instead of navigating.
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:') ||
          href.startsWith('mailto:') || href.startsWith('tel:')) return;
      const absolute = resolveUrl(href, url);
      if (!absolute.startsWith('http')) return;
      const esc = absolute.replace(/'/g, '%27');
      $(el).attr('href', '#');
      $(el).attr('data-href', absolute);
      // If _srLongPress is set, the context menu is already visible — skip navigation
      $(el).attr('onclick', `event.preventDefault();if(!window._srLongPress){window.parent.postMessage({type:'link-clicked',href:'${esc}'},'*');}window._srLongPress=false;return false;`);
    });

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
