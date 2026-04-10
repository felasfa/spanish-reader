/* ===== State ===== */
const state = {
  currentView: 'url',
  previousView: 'url',
  currentUrl: '',
  pendingTranslation: null,
  readerHistory: [],   // URL stack for back-navigation within reader
};

let rlUnreadCount = 0; // tracked in memory — no extra API call needed

/* ===== Helpers ===== */
function $(id) { return document.getElementById(id); }

function showView(name) {
  if (state.currentView !== name) state.previousView = state.currentView;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`view-${name}`).classList.add('active');
  state.currentView = name;
}

$('reader-share').addEventListener('click', async () => {
  const url = state.currentUrl;
  if (!url) return;
  if (navigator.share) {
    try {
      await navigator.share({ url, title: $('reader-url-display').textContent || url });
    } catch (e) {
      if (e.name !== 'AbortError') showToast('Share failed', 'error');
    }
  } else {
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied!', 'success');
    } catch {
      showToast('Copy not supported', 'error');
    }
  }
});

$('reader-back').addEventListener('click', () => {
  if (state.readerHistory.length > 0) {
    loadUrl(state.readerHistory.pop(), false);
  } else {
    showView(state.previousView || 'url');
  }
});

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Strip subdomains: nl.nytimes.com → nytimes.com, t.newsletter.elpais.com → elpais.com
// Keeps 2 parts normally; keeps 3 for country-code SLDs like bbc.co.uk
function cleanDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  // Country-code SLDs: co.uk, com.br, co.jp, etc.
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  if (['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(sld) && tld.length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function showError(el, msg) { el.textContent = msg; el.style.display = 'block'; }
function hideError(el)       { el.style.display = 'none'; }

/* ===== Toast ===== */
let toastTimer;
function showToast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast toast-${type}`;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3000);
}

/* ===== Navigation ===== */
$('nav-new-url').addEventListener('click', () => showView('url'));

$('nav-reading-list').addEventListener('click', () => {
  loadReadingList();
  showView('reading-list');
});

$('nav-vocabulary').addEventListener('click', () => {
  loadVocabulary();
  showView('vocabulary');
});

$('vocab-go-read').addEventListener('click', () => showView('url'));
$('rl-go-read').addEventListener('click', () => showView('url'));

/* ===== URL Suggestions ===== */
document.querySelectorAll('.suggestion-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    $('url-input').value = chip.dataset.url;
    loadUrl(chip.dataset.url);
  });
});

/* ===== URL Submission ===== */
async function loadUrl(url, addToHistory = true) {
  if (!url) return;
  hideError($('url-error'));
  $('url-read-now').disabled = true;
  $('url-read-now').textContent = 'Loading…';

  try {
    const res  = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load page');

    // Track navigation history so back works correctly
    if (state.currentView === 'reader') {
      if (addToHistory && state.currentUrl) state.readerHistory.push(state.currentUrl);
    } else {
      state.readerHistory = []; // fresh entry into reader, clear old history
    }

    state.currentUrl = url;
    $('reader-url-display').textContent = url;
    showView('reader');
    $('reader-loading').style.display = 'flex';
    $('reader-iframe').style.visibility = 'hidden';

    const iframe = $('reader-iframe');
    iframe.srcdoc = data.html;
    iframe.onload = () => {
      $('reader-loading').style.display = 'none';
      iframe.style.visibility = 'visible';
    };
  } catch (e) {
    showError($('url-error'), `Error: ${e.message}`);
    showView('url');
  } finally {
    $('url-read-now').disabled = false;
    $('url-read-now').innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12,5 19,12 12,19"/></svg> Read Now`;
  }
}

$('url-read-now').addEventListener('click', () => {
  const url = $('url-input').value.trim();
  if (!url) { showError($('url-error'), 'Please enter a URL'); return; }
  loadUrl(url);
});

$('url-save-later').addEventListener('click', () => {
  const url = $('url-input').value.trim();
  if (!url) { showError($('url-error'), 'Please enter a URL'); return; }
  addToReadingList(url).then(() => {
    loadReadingList();
    showView('reading-list');
  });
});

$('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('url-read-now').click();
});

/* ===== Messages from iframe ===== */
window.addEventListener('message', async (event) => {
  if (!event.data) return;

  if (event.data.type === 'word-selected') {
    const { word, sentence } = event.data;
    if (!word || word.length > 200) return;
    showTranslationPopup(word, sentence);
  }

  if (event.data.type === 'link-clicked') {
    const { href } = event.data;
    if (href && href.startsWith('http')) {
      $('url-input').value = href;
      loadUrl(href);
    }
  }

  if (event.data.type === 'save-for-later') {
    const { href } = event.data;
    if (href && href.startsWith('http')) {
      await addToReadingList(href);
    }
  }
});

/* ===== Translation Popup ===== */
function showTranslationPopup(word, sentence) {
  const popup = $('translation-popup');

  // Render multi-word selections as tappable chips so user can pick one word to save
  const wordEl = $('popup-word');
  if (word.includes(' ')) {
    wordEl.innerHTML = word.replace(
      /([\u00C0-\u024F\w]+)/g,
      '<span class="popup-word-chip">$1</span>'
    );
    wordEl.querySelectorAll('.popup-word-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        showTranslationPopup(chip.textContent, sentence);
      });
    });
  } else {
    wordEl.textContent = word;
  }

  $('popup-loading').style.display = 'flex';
  $('popup-content').style.display = 'none';
  $('popup-error').style.display = 'none';
  $('popup-saved').style.display = 'none';
  $('popup-save').style.display = 'inline-flex';
  popup.style.display = 'block';
  state.pendingTranslation = { word, sentence };

  fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word, sentence }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      $('popup-word-translation').textContent = data.wordTranslation;
      $('popup-sentence-es').textContent = sentence || '';
      $('popup-sentence-en').textContent = data.sentenceTranslation;
      state.pendingTranslation = { word, sentence, wordTranslation: data.wordTranslation, sentenceTranslation: data.sentenceTranslation };
      $('popup-loading').style.display = 'none';
      $('popup-content').style.display = 'block';
    })
    .catch(e => {
      $('popup-loading').style.display = 'none';
      $('popup-error').textContent = `Translation failed: ${e.message}`;
      $('popup-error').style.display = 'block';
    });
}

$('popup-close').addEventListener('click', () => { $('translation-popup').style.display = 'none'; });

/* ===== Save to Vocabulary (GitHub API) ===== */
$('popup-save').addEventListener('click', async () => {
  const t = state.pendingTranslation;
  if (!t) return;
  try {
    const res = await fetch('/api/vocabulary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        word: t.word, translation: t.wordTranslation,
        sentence: t.sentence, sentenceTranslation: t.sentenceTranslation,
        url: state.currentUrl,
      }),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Save failed'); }
    $('popup-save').style.display = 'none';
    $('popup-saved').style.display = 'flex';
    updateVocabCount();
  } catch (e) {
    $('popup-error').textContent = `Save failed: ${e.message}`;
    $('popup-error').style.display = 'block';
  }
});

/* ===== Vocabulary (GitHub API) ===== */
async function updateVocabCount() {
  try {
    const res   = await fetch('/api/vocabulary');
    const vocab = await res.json();
    const lastViewed = localStorage.getItem('vocabLastViewed') || '0';
    const hasNew = vocab.some(e => e.date && e.date > lastViewed);
    $('nav-vocab-count').style.display = hasNew ? 'inline-block' : 'none';
  } catch { /* ignore */ }
}

async function loadVocabulary() {
  $('vocab-loading').style.display = 'flex';
  $('vocab-table-wrap').style.display = 'none';
  $('vocab-empty').style.display = 'none';
  try {
    const res   = await fetch('/api/vocabulary');
    const vocab = await res.json();
    renderVocabulary(vocab);
  } catch (e) {
    console.error('Failed to load vocabulary', e);
  } finally {
    $('vocab-loading').style.display = 'none';
  }
}

function renderVocabulary(vocab) {
  $('vocab-subtitle').textContent = vocab.length
    ? `${vocab.length} word${vocab.length !== 1 ? 's' : ''} in your collection`
    : "Words you've looked up while reading";

  if (vocab.length === 0) {
    $('vocab-empty').style.display = 'flex';
    $('vocab-table-wrap').style.display = 'none';
    return;
  }
  $('vocab-empty').style.display = 'none';
  $('vocab-table-wrap').style.display = 'block';

  const lastViewed = localStorage.getItem('vocabLastViewed') || '0';

  $('vocab-tbody').innerHTML = vocab.map(e => {
    const domain  = e.url ? (() => { try { return new URL(e.url).hostname; } catch { return e.url; } })() : null;
    const isNew   = e.date && e.date > lastViewed;
    return `<tr class="${isNew ? 'vocab-new' : ''}">
      <td><span class="vocab-word">${escapeHtml(e.word)}</span></td>
      <td><span class="vocab-translation">${escapeHtml(e.translation || '—')}</span></td>
      <td><span class="vocab-sentence-es">${escapeHtml(e.sentence || '—')}</span></td>
      <td class="vocab-source-date">
        ${domain ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>` : '—'}
        ${e.date ? `<br><span class="vocab-date-text">${formatDate(e.date)}</span>` : ''}
      </td>
      <td><button class="vocab-delete-btn" data-id="${e.id}" title="Delete" aria-label="Delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3,6 5,6 21,6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button></td>
    </tr>`;
  }).join('');

  $('vocab-tbody').querySelectorAll('.vocab-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteVocabEntry(btn.dataset.id));
  });

  // Clear highlights and badge 2 seconds after the list opens
  if ($('vocab-tbody').querySelector('.vocab-new')) {
    setTimeout(() => {
      $('vocab-tbody').querySelectorAll('.vocab-new').forEach(r => r.classList.remove('vocab-new'));
      localStorage.setItem('vocabLastViewed', new Date().toISOString());
      $('nav-vocab-count').style.display = 'none';
    }, 2000);
  }
}

async function deleteVocabEntry(id) {
  await fetch(`/api/vocabulary/${id}`, { method: 'DELETE' });
  loadVocabulary();
  updateVocabCount();
}

$('vocab-clear').addEventListener('click', async () => {
  if (!confirm('Clear all vocabulary entries? This cannot be undone.')) return;
  await fetch('/api/vocabulary', { method: 'DELETE' });
  loadVocabulary();
  updateVocabCount();
});

$('vocab-export').addEventListener('click', async () => {
  const res   = await fetch('/api/vocabulary');
  const vocab = await res.json();
  if (!vocab.length) { alert('No vocabulary to export.'); return; }
  const headers = ['Word', 'Translation', 'Spanish Sentence', 'English Sentence', 'URL', 'Date'];
  const rows = vocab.map(e =>
    [e.word, e.translation, e.sentence, e.sentenceTranslation, e.url,
     e.date ? new Date(e.date).toLocaleDateString() : '']
    .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
  );
  const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `spanish-vocabulary-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ===== Reading List (GitHub API) ===== */
async function addToReadingList(url) {
  showToast('Fetching article info…', 'info');
  try {
    const res  = await fetch('/api/reading-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save');
    if (data.duplicate) {
      showToast('Already in your Read Later list', 'info');
    } else {
      showToast('Saved to Read Later!', 'success');
      rlUnreadCount++;
      updateRLCount();
    }
  } catch (e) {
    showToast(`Could not save: ${e.message}`, 'error');
  }
}

function updateRLCount() {
  $('nav-rl-count').style.display = rlUnreadCount > 0 ? 'inline-block' : 'none';
}

async function loadReadingList() {
  $('rl-loading').style.display = 'flex';
  $('rl-list').innerHTML = '';
  $('rl-empty').style.display = 'none';
  try {
    const res  = await fetch('/api/reading-list');
    const list = await res.json();
    rlUnreadCount = list.filter(i => !i.read).length;
    updateRLCount();
    renderReadingList(list);
  } catch (e) {
    console.error('Failed to load reading list', e);
  } finally {
    $('rl-loading').style.display = 'none';
  }
}

function renderReadingList(list) {
  $('rl-subtitle').textContent = list.length
    ? `${list.length} article${list.length !== 1 ? 's' : ''} saved`
    : 'Articles saved for later';

  if (list.length === 0) {
    $('rl-empty').style.display = 'flex';
    $('rl-list').innerHTML = '';
    return;
  }
  $('rl-empty').style.display = 'none';

  $('rl-list').innerHTML = list.map(item => {
    const domain     = (() => { try { return cleanDomain(new URL(item.url).hostname); } catch { return item.url; } })();
    const sourceName = item.siteName || domain;
    const thumb  = item.image
      ? `<img class="rl-thumb" src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="rl-thumb rl-thumb-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg></div>`;

    return `<div class="rl-item ${item.read ? 'rl-read' : ''}" data-id="${item.id}" data-url="${escapeHtml(item.url)}">
      <div class="rl-thumb-wrap" role="button" tabindex="0" aria-label="Read article">
        ${thumb}
      </div>
      <div class="rl-content">
        <div class="rl-title" role="button" tabindex="0">${escapeHtml(item.title)}</div>
        <div class="rl-summary ${item.read ? '' : 'rl-unread'}">${escapeHtml(item.summary || '')}</div>
        <div class="rl-meta">
          <span class="rl-domain">${escapeHtml(sourceName)}</span>
          <span class="rl-date">${item.dateAdded ? formatDate(item.dateAdded) : ''}</span>
        </div>
      </div>
      <button class="rl-remove-btn" data-id="${item.id}" title="Remove" aria-label="Remove">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`;
  }).join('');

  // Click handlers — open article and mark as read
  $('rl-list').querySelectorAll('.rl-thumb-wrap, .rl-title, .rl-summary').forEach(el => {
    el.addEventListener('click', async () => {
      const item  = el.closest('.rl-item');
      const id    = parseInt(item.dataset.id, 10);
      const url   = item.dataset.url;
      // Mark as read (fire-and-forget)
      fetch(`/api/reading-list/${id}`, { method: 'PATCH' }).then(() => {
        if (!item.classList.contains('rl-read')) {
          rlUnreadCount = Math.max(0, rlUnreadCount - 1);
          updateRLCount();
        }
        item.classList.add('rl-read');
        item.querySelector('.rl-summary')?.classList.remove('rl-unread');
      });
      $('url-input').value = url;
      loadUrl(url);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') el.click(); });
  });

  // Remove buttons
  $('rl-list').querySelectorAll('.rl-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = parseInt(btn.dataset.id, 10);
      const item = btn.closest('.rl-item');
      if (!item.classList.contains('rl-read')) {
        rlUnreadCount = Math.max(0, rlUnreadCount - 1);
        updateRLCount();
      }
      await fetch(`/api/reading-list/${id}`, { method: 'DELETE' });
      item.remove();
      // Re-check empty
      if (!$('rl-list').querySelector('.rl-item')) {
        $('rl-empty').style.display = 'flex';
      }
      // Update subtitle count
      const remaining = $('rl-list').querySelectorAll('.rl-item').length;
      $('rl-subtitle').textContent = remaining
        ? `${remaining} article${remaining !== 1 ? 's' : ''} saved`
        : 'Articles saved for later';
    });
  });
}

$('rl-clear').addEventListener('click', async () => {
  if (!confirm('Remove all saved articles?')) return;
  await fetch('/api/reading-list', { method: 'DELETE' });
  rlUnreadCount = 0;
  updateRLCount();
  loadReadingList();
});

$('rl-gmail-import').addEventListener('click', async () => {
  const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  const lastCheck  = parseInt(localStorage.getItem('gmailLastCheck') || '0', 10);
  const elapsed    = Date.now() - lastCheck;
  if (elapsed < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
    showToast(`Checked recently — try again in ${remaining} min`, 'info');
    return;
  }

  const btn = $('rl-gmail-import');
  btn.disabled = true;
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Checking…`;
  showToast('Checking Gmail inbox…', 'info');
  try {
    const res  = await fetch('/api/gmail-import', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    localStorage.setItem('gmailLastCheck', Date.now().toString());
    if (data.imported === 0 && !data.archived) {
      showToast(data.message || 'No new Spanish newsletters found', 'info');
    } else {
      const parts = [];
      if (data.imported > 0) parts.push(`Imported ${data.imported} newsletter${data.imported !== 1 ? 's' : ''}`);
      if (data.archived > 0) parts.push(`archived ${data.archived}`);
      showToast(parts.join(', ') + '!', 'success');
      if (data.imported > 0) {
        rlUnreadCount += data.imported;
        updateRLCount();
        loadReadingList();
      }
    }
  } catch (e) {
    showToast(`Gmail import failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> Check Gmail`;
  }
});

/* ===== URL parameter: ?url=... adds to Read Later ===== */
(function handleUrlParam() {
  const params  = new URLSearchParams(window.location.search);
  const urlParam = params.get('url');
  if (!urlParam) return;
  // Clean the URL bar immediately
  history.replaceState({}, '', window.location.pathname);
  addToReadingList(urlParam).then(() => {
    loadReadingList();
    showView('reading-list');
  });
})();

/* ===== Init ===== */
updateVocabCount();
