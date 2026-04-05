/* ===== State ===== */
const state = {
  currentView: 'url',
  currentUrl: '',
  pendingTranslation: null, // { word, sentence, wordTranslation, sentenceTranslation }
};

/* ===== Helpers ===== */
function $(id) { return document.getElementById(id); }

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`view-${name}`).classList.add('active');
  state.currentView = name;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError(el) {
  el.style.display = 'none';
}

/* ===== Navigation ===== */
$('nav-new-url').addEventListener('click', () => showView('url'));
$('nav-vocabulary').addEventListener('click', () => {
  loadVocabulary();
  showView('vocabulary');
});
$('vocab-go-read').addEventListener('click', () => showView('url'));

/* ===== URL Suggestions ===== */
document.querySelectorAll('.suggestion-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    $('url-input').value = chip.dataset.url;
    loadUrl(chip.dataset.url);
  });
});

/* ===== URL Submission ===== */
async function loadUrl(url) {
  if (!url) return;

  hideError($('url-error'));
  $('url-submit').disabled = true;
  $('url-submit').textContent = 'Loading…';

  try {
    const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load page');

    state.currentUrl = url;
    $('reader-url-display').textContent = url;

    // Show loading state in reader
    showView('reader');
    $('reader-loading').style.display = 'flex';
    $('reader-iframe').style.visibility = 'hidden';

    // Set iframe content
    const iframe = $('reader-iframe');
    iframe.srcdoc = data.html;

    iframe.onload = () => {
      $('reader-loading').style.display = 'none';
      iframe.style.visibility = 'visible';
    };

  } catch (err) {
    showError($('url-error'), `Error: ${err.message}`);
    showView('url');
  } finally {
    $('url-submit').disabled = false;
    $('url-submit').innerHTML = `Leer <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12,5 19,12 12,19"/></svg>`;
  }
}

$('url-submit').addEventListener('click', () => {
  const url = $('url-input').value.trim();
  if (!url) { showError($('url-error'), 'Please enter a URL'); return; }
  loadUrl(url);
});

$('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('url-submit').click();
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
});

/* ===== Translation Popup ===== */
function showTranslationPopup(word, sentence) {
  const popup = $('translation-popup');
  $('popup-word').textContent = word;
  $('popup-loading').style.display = 'flex';
  $('popup-content').style.display = 'none';
  $('popup-error').style.display = 'none';
  $('popup-saved').style.display = 'none';
  $('popup-save').style.display = 'inline-flex';

  popup.style.display = 'block';
  state.pendingTranslation = { word, sentence };

  // Fetch translation
  fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word, sentence }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);

      $('popup-word-translation').textContent = data.wordTranslation;
      $('popup-sentence-es').textContent = sentence;
      $('popup-sentence-en').textContent = data.sentenceTranslation;

      state.pendingTranslation = {
        word,
        sentence,
        wordTranslation: data.wordTranslation,
        sentenceTranslation: data.sentenceTranslation,
      };

      $('popup-loading').style.display = 'none';
      $('popup-content').style.display = 'block';
    })
    .catch(err => {
      $('popup-loading').style.display = 'none';
      $('popup-error').textContent = `Translation failed: ${err.message}`;
      $('popup-error').style.display = 'block';
    });
}

$('popup-close').addEventListener('click', () => {
  $('translation-popup').style.display = 'none';
});

/* ===== Save to Vocabulary ===== */
$('popup-save').addEventListener('click', async () => {
  const t = state.pendingTranslation;
  if (!t) return;

  try {
    const res = await fetch('/api/vocabulary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        word: t.word,
        translation: t.wordTranslation,
        sentence: t.sentence,
        sentenceTranslation: t.sentenceTranslation,
        url: state.currentUrl,
      }),
    });

    if (!res.ok) throw new Error('Failed to save');

    $('popup-save').style.display = 'none';
    $('popup-saved').style.display = 'flex';
    updateVocabCount();

  } catch (err) {
    $('popup-error').textContent = `Save failed: ${err.message}`;
    $('popup-error').style.display = 'block';
  }
});

/* ===== Vocabulary Count Badge ===== */
async function updateVocabCount() {
  try {
    const res = await fetch('/api/vocabulary');
    const vocab = await res.json();
    const count = vocab.length;
    const badge = $('nav-vocab-count');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  } catch { /* ignore */ }
}

/* ===== Vocabulary View ===== */
async function loadVocabulary() {
  try {
    const res = await fetch('/api/vocabulary');
    const vocab = await res.json();
    renderVocabulary(vocab);
  } catch (err) {
    console.error('Failed to load vocabulary', err);
  }
}

function renderVocabulary(vocab) {
  const subtitle = $('vocab-subtitle');
  subtitle.textContent = vocab.length
    ? `${vocab.length} word${vocab.length !== 1 ? 's' : ''} in your collection`
    : "Words you've looked up while reading";

  if (vocab.length === 0) {
    $('vocab-empty').style.display = 'flex';
    $('vocab-table-wrap').style.display = 'none';
    return;
  }

  $('vocab-empty').style.display = 'none';
  $('vocab-table-wrap').style.display = 'block';

  const tbody = $('vocab-tbody');
  tbody.innerHTML = vocab.map(entry => {
    const domain = entry.url ? (() => { try { return new URL(entry.url).hostname; } catch { return entry.url; } })() : '—';
    return `<tr data-id="${entry.id}">
      <td><span class="vocab-word">${escapeHtml(entry.word)}</span></td>
      <td><span class="vocab-translation">${escapeHtml(entry.translation || '—')}</span></td>
      <td><span class="vocab-sentence-es">${escapeHtml(entry.sentence || '—')}</span></td>
      <td><span class="vocab-sentence-en">${escapeHtml(entry.sentenceTranslation || '—')}</span></td>
      <td class="vocab-source">${entry.url ? `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener" title="${escapeHtml(entry.url)}">${escapeHtml(domain)}</a>` : '—'}</td>
      <td class="vocab-date">${entry.date ? formatDate(entry.date) : '—'}</td>
      <td>
        <button class="vocab-delete-btn" data-id="${entry.id}" title="Delete" aria-label="Delete entry">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3,6 5,6 21,6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.vocab-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await deleteVocabEntry(id);
    });
  });
}

async function deleteVocabEntry(id) {
  try {
    await fetch(`/api/vocabulary/${id}`, { method: 'DELETE' });
    loadVocabulary();
    updateVocabCount();
  } catch (err) {
    console.error('Delete failed', err);
  }
}

/* ===== Clear All Vocabulary ===== */
$('vocab-clear').addEventListener('click', async () => {
  if (!confirm('Clear all vocabulary entries? This cannot be undone.')) return;
  try {
    await fetch('/api/vocabulary', { method: 'DELETE' });
    loadVocabulary();
    updateVocabCount();
  } catch (err) {
    console.error('Clear failed', err);
  }
});

/* ===== Export CSV ===== */
$('vocab-export').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/vocabulary');
    const vocab = await res.json();
    if (!vocab.length) { alert('No vocabulary to export.'); return; }

    const headers = ['Word', 'Translation', 'Spanish Sentence', 'English Sentence', 'URL', 'Date'];
    const rows = vocab.map(e => [
      e.word, e.translation, e.sentence, e.sentenceTranslation, e.url,
      e.date ? new Date(e.date).toLocaleDateString() : ''
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`));

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spanish-vocabulary-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export failed', err);
  }
});

/* ===== Init ===== */
updateVocabCount();
