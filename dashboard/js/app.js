/* ============================================================
   CompanyHunter — app.js
   ------------------------------------------------------------
   Sections:
     1. DOM refs & state
     2. Utilities (escape, debounce, formatting)
     3. Local storage layer (history + favorites)
     4. PRH API fetching
     5. Rendering (toolbar, cards, pager, AI panel)
     6. Event wiring
     7. Boot
   ============================================================ */

/* ---------- 1. DOM refs & state ---------- */

const searchForm       = document.getElementById('search-form');
const submitBtn        = document.getElementById('submit-btn');
const clearBtn         = document.getElementById('clear-btn');
const locationInput    = document.getElementById('location');
const businessLineInput= document.getElementById('mainBusinessLine');
const resultsDiv       = document.getElementById('results');
const statusText       = document.getElementById('status');

const state = {
  // Which saved search is currently active (null = none)
  activeSearchId: null,

  // View state for the results panel
  query: '',
  sort: 'name',          // name | city | businessLine | aiScore
  page: 1,
  pageSize: 50,

  // Cached copy of the active search's companies (synced from localStorage)
  companies: [],

  // Favorites are global across searches (keyed by businessId)
  favorites: new Set(loadJSON('favorites', [])),

  // AI results keyed by businessId -> { score, verdict, reason, evidence }
  aiScores: loadJSON('aiScores', {})
};

/* ---------- 2. Utilities ---------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}
const escapeAttr = escapeHtml;

function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorage write failed', e);
  }
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('fi-FI', {
      dateStyle: 'short',
      timeStyle: 'short'
    });
  } catch {
    return iso;
  }
}

/* ---------- 3. Local storage layer ---------- */

/*
  searchHistory: [
    {
      id, location, businessLine, fetchedAt,
      companies: [{ businessId, name, businessLine, city, street, postCode }]
    },
    ...
  ]
  Capped at 20 most recent.
*/
const HISTORY_KEY = 'searchHistory';
const HISTORY_LIMIT = 20;

function getSearchHistory() {
  return loadJSON(HISTORY_KEY, []);
}

function saveSearchHistory(history) {
  saveJSON(HISTORY_KEY, history.slice(0, HISTORY_LIMIT));
}

function addSearchToHistory(location, businessLine, companies) {
  const history = getSearchHistory();
  const entry = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    location,
    businessLine,
    fetchedAt: new Date().toISOString(),
    companies
  };
  history.unshift(entry);
  saveSearchHistory(history);
  return entry;
}

function deleteSearchFromHistory(id) {
  const history = getSearchHistory().filter(h => h.id !== id);
  saveSearchHistory(history);
}

function clearAllData() {
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem('favorites');
  localStorage.removeItem('aiScores');
  // legacy key from previous version
  localStorage.removeItem('savedCompanies');
  state.favorites = new Set();
  state.aiScores = {};
  state.activeSearchId = null;
  state.companies = [];
}

function loadActiveSearch(id) {
  const entry = getSearchHistory().find(h => h.id === id);
  if (!entry) return null;
  state.activeSearchId = id;
  state.companies = entry.companies || [];
  state.page = 1;
  state.query = '';
  return entry;
}

/* ---------- 4. PRH API fetching ---------- */

async function fetchCompanies(location = '', mainBusinessLine = '', onProgress) {
  const baseUrl = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies';
  let page = 1;
  const allCompanies = [];
  let firstPageRaw = null;

  while (true) {
    const params = new URLSearchParams({ page });
    if (location) params.append('location', location);
    if (mainBusinessLine) params.append('mainBusinessLine', mainBusinessLine);

    const url = `${baseUrl}?${params.toString()}`;
    onProgress?.(page, allCompanies.length);

    const response = await fetch(url, { headers: { accept: 'application/json' } });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `PRH API returned ${response.status} ${response.statusText}${details ? `: ${details}` : ''}`
      );
    }

    const data = await response.json();
    if (!Array.isArray(data.companies)) {
      throw new Error('PRH API response did not contain a companies list.');
    }
    const companies = data.companies;
    if (companies.length === 0) break;

    // Detect pagination loop
    const currentRaw = JSON.stringify(data);
    if (page > 1 && currentRaw === firstPageRaw) break;
    if (page === 1) firstPageRaw = currentRaw;

    // Clean fields
    const cleaned = companies.map(c => {
      const fiDesc = c.mainBusinessLine?.descriptions?.find(d => d.languageCode === '1')?.description;
      const mainDesc = c.mainBusinessLine?.descriptions?.[0]?.description;
      const addr = c.addresses?.[0];
      const cityFi = addr?.postOffices?.find(p => p.languageCode === '1')?.city;

      const streetParts = [addr?.street, addr?.buildingNumber, addr?.entrance]
        .filter(Boolean)
        .join(' ');

      return {
        businessId: c.businessId?.value || null,
        name: c.names?.[0]?.name || null,
        businessLine: fiDesc || mainDesc || null,
        city: cityFi || null,
        street: streetParts || null,
        postCode: addr?.postCode || null
      };
    });

    allCompanies.push(...cleaned);
    page++;

    // Safety valve to avoid infinite loops on bad API behaviour
    if (page > 500) break;
  }

  // Dedupe by businessId
  const uniqueMap = new Map();
  for (const item of allCompanies) {
    if (item.businessId && !uniqueMap.has(item.businessId)) {
      uniqueMap.set(item.businessId, item);
    }
  }
  return Array.from(uniqueMap.values());
}

/* ---------- 5. Rendering ---------- */

function getFilteredSorted() {
  const { companies, query, sort } = state;
  const q = query.trim().toLowerCase();

  let list = companies.filter(c => {
    if (!q) return true;
    return (
      (c.name || '').toLowerCase().includes(q) ||
      (c.city || '').toLowerCase().includes(q) ||
      (c.businessLine || '').toLowerCase().includes(q) ||
      (c.businessId || '').toLowerCase().includes(q) ||
      (c.postCode || '').toLowerCase().includes(q)
    );
  });

  list = list.slice().sort((a, b) => {
    if (sort === 'aiScore') {
      const sa = state.aiScores[a.businessId]?.score ?? -1;
      const sb = state.aiScores[b.businessId]?.score ?? -1;
      return sb - sa;
    }
    return (a[sort] || '').localeCompare(b[sort] || '', 'fi');
  });

  return list;
}

function renderAll() {
  renderSidebar();
  renderResults();
}

function renderSidebar() {
  // We render the sidebar (search history) into the aside above the form,
  // injecting a container if it doesn't exist yet.
  let historyBox = document.getElementById('history-box');
  if (!historyBox) {
    historyBox = document.createElement('section');
    historyBox.id = 'history-box';
    historyBox.className = 'history-box';
    const aside = document.querySelector('aside');
    aside.insertBefore(historyBox, aside.firstChild);
  }

  const history = getSearchHistory();

  if (history.length === 0) {
    historyBox.innerHTML = `
      <h2>Saved searches</h2>
      <p class="muted small">No saved searches yet. Run a fetch to create one.</p>
    `;
    return;
  }

  historyBox.innerHTML = `
    <h2>Saved searches</h2>
    <ul class="history-list">
      ${history.map(h => {
        const active = h.id === state.activeSearchId ? 'is-active' : '';
        const label = [h.location, h.businessLine].filter(Boolean).join(' · ') || 'All companies';
        return `
          <li class="${active}">
            <button type="button" class="history-load" data-id="${escapeAttr(h.id)}">
              <span class="history-label">${escapeHtml(label)}</span>
              <span class="history-meta">${h.companies.length} companies · ${escapeHtml(formatDate(h.fetchedAt))}</span>
            </button>
            <button type="button" class="history-del" data-id="${escapeAttr(h.id)}" aria-label="Delete search">×</button>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function renderResults() {
  const { companies, page, pageSize } = state;

  if (!companies.length) {
    resultsDiv.innerHTML = `
      <div class="empty">
        <p>No companies loaded.</p>
        <p class="muted small">Use the form to fetch companies by location and business line.</p>
      </div>
    `;
    return;
  }

  const filtered = getFilteredSorted();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) state.page = safePage;

  const start = (safePage - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  const activeEntry = getSearchHistory().find(h => h.id === state.activeSearchId);
  const activeLabel = activeEntry
    ? [activeEntry.location, activeEntry.businessLine].filter(Boolean).join(' · ') || 'All'
    : '';

  resultsDiv.innerHTML = `
    <div class="results-header">
      <h2>Results <span class="muted small">${activeLabel ? '· ' + escapeHtml(activeLabel) : ''}</span></h2>
      <div class="results-toolbar">
        <input
          type="search"
          id="filter-input"
          placeholder="Filter by name, city, field, ID…"
          value="${escapeAttr(state.query)}"
          autocomplete="off"
        />
        <select id="sort-select">
          <option value="name"          ${state.sort==='name'?'selected':''}>Sort: Name</option>
          <option value="city"          ${state.sort==='city'?'selected':''}>Sort: City</option>
          <option value="businessLine"  ${state.sort==='businessLine'?'selected':''}>Sort: Field</option>
          <option value="aiScore"       ${state.sort==='aiScore'?'selected':''}>Sort: AI score</option>
        </select>
        <button type="button" id="export-json">Export JSON</button>
        <button type="button" id="export-csv">Export CSV</button>
      </div>
      <p class="results-count muted small">
        ${total} of ${companies.length} shown
        ${state.favorites.size ? ` · ${state.favorites.size} favorite${state.favorites.size>1?'s':''}` : ''}
      </p>
    </div>

    <div class="results-list">
      ${slice.map(renderCard).join('')}
    </div>

    ${totalPages > 1 ? `
      <nav class="pager">
        <button type="button" data-page="${safePage - 1}" ${safePage === 1 ? 'disabled' : ''}>‹ Prev</button>
        <span>Page ${safePage} / ${totalPages}</span>
        <button type="button" data-page="${safePage + 1}" ${safePage === totalPages ? 'disabled' : ''}>Next ›</button>
      </nav>
    ` : ''}
  `;

  statusText.textContent = `${total} companies match your filter.`;
}

function renderCard(c) {
  const isFav = state.favorites.has(c.businessId);
  const ai = state.aiScores[c.businessId];
  const address = [c.street, c.postCode, c.city].filter(Boolean).join(', ') || '—';

  return `
    <article class="card ${isFav ? 'is-fav' : ''}" data-id="${escapeAttr(c.businessId)}">
      <header class="card-head">
        <button type="button" class="fav-btn" data-id="${escapeAttr(c.businessId)}"
                aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
                aria-pressed="${isFav}">
          ${isFav ? '★' : '☆'}
        </button>
        <h3 class="card-title">${escapeHtml(c.name || 'Unnamed Company')}</h3>
        ${ai ? `<span class="ai-badge ai-${escapeAttr(ai.verdict || 'maybe')}" title="${escapeAttr(ai.reason || '')}">
                  AI ${ai.score ?? '?'}
                </span>` : ''}
      </header>
      <dl class="card-meta">
        <div><dt>Business ID</dt><dd>${escapeHtml(c.businessId || '—')}</dd></div>
        <div><dt>Field</dt><dd>${escapeHtml(c.businessLine || '—')}</dd></div>
        <div><dt>Address</dt><dd>${escapeHtml(address)}</dd></div>
      </dl>
      ${ai ? `<p class="ai-reason"><strong>AI:</strong> ${escapeHtml(ai.reason || '')}
        ${ai.evidence?.length ? ` <span class="muted small">(${ai.evidence.length} source${ai.evidence.length>1?'s':''})</span>` : ''}
      </p>` : ''}
      ${c.businessId ? `
        <a class="detail-link" target="_blank" rel="noopener"
           href="https://tietopalvelu.ytj.fi/yritys/${encodeURIComponent(c.businessId)}">
          View on YTJ ↗
        </a>` : ''}
    </article>
  `;
}

/* ---------- 6. Event wiring ---------- */

// Form submit: fetch from PRH, add to history, activate
searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const location = locationInput.value.trim();
  const businessLine = businessLineInput.value.trim();

  submitBtn.disabled = true;
  statusText.textContent = 'Fetching data, please wait…';

  try {
    const companies = await fetchCompanies(location, businessLine, (page, count) => {
      statusText.textContent = `Fetching page ${page}… (${count} so far)`;
    });

    if (companies.length === 0) {
      statusText.textContent = 'No companies found. Check the location / business line ID.';
      return;
    }

    const entry = addSearchToHistory(location, businessLine, companies);
    loadActiveSearch(entry.id);
    renderAll();
    statusText.textContent = `Saved ${companies.length} companies.`;
  } catch (error) {
    statusText.textContent = `Error: ${error.message}`;
    console.error(error);
  } finally {
    submitBtn.disabled = false;
  }
});

// Clear all saved data
clearBtn.addEventListener('click', () => {
  if (!confirm('Delete all saved searches, favorites, and AI results?')) return;
  clearAllData();
  renderAll();
  statusText.textContent = 'All saved data cleared.';
});

// Delegated events for everything rendered inside #results
resultsDiv.addEventListener('input', debounce((e) => {
  if (e.target.id !== 'filter-input') return;
  state.query = e.target.value;
  state.page = 1;
  // Preserve focus + caret by re-rendering just the list, not the whole panel.
  // Simplest robust approach: re-render everything but restore focus.
  const caret = e.target.selectionStart;
  renderResults();
  const next = document.getElementById('filter-input');
  if (next) {
    next.focus();
    try { next.setSelectionRange(caret, caret); } catch {}
  }
}, 120));

resultsDiv.addEventListener('change', (e) => {
  if (e.target.id === 'sort-select') {
    state.sort = e.target.value;
    state.page = 1;
    renderResults();
  }
});

resultsDiv.addEventListener('click', (e) => {
  // Favorite toggle
  const favBtn = e.target.closest('.fav-btn');
  if (favBtn) {
    const id = favBtn.dataset.id;
    if (!id) return;
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    saveJSON('favorites', [...state.favorites]);
    renderResults();
    return;
  }

  // Pagination
  const pageBtn = e.target.closest('[data-page]');
  if (pageBtn && !pageBtn.disabled) {
    state.page = Number(pageBtn.dataset.page);
    renderResults();
    resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Export
  if (e.target.id === 'export-json') exportJSON();
  if (e.target.id === 'export-csv')  exportCSV();
});

// Delegated events for the sidebar history
document.addEventListener('click', (e) => {
  const loadBtn = e.target.closest('.history-load');
  if (loadBtn) {
    const entry = loadActiveSearch(loadBtn.dataset.id);
    if (entry) {
      locationInput.value = entry.location || '';
      businessLineInput.value = entry.businessLine || '';
      renderResults();
      statusText.textContent = `Loaded search with ${entry.companies.length} companies.`;
    }
    return;
  }

  const delBtn = e.target.closest('.history-del');
  if (delBtn) {
    const id = delBtn.dataset.id;
    if (!confirm('Delete this saved search?')) return;
    deleteSearchFromHistory(id);
    if (state.activeSearchId === id) {
      state.activeSearchId = null;
      state.companies = [];
    }
    renderAll();
  }
});

/* ---------- 7. Export helpers ---------- */

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJSON() {
  const data = getFilteredSorted();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(`companies-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
}

function exportCSV() {
  const data = getFilteredSorted();
  const header = ['businessId', 'name', 'businessLine', 'city', 'street', 'postCode'];
  const rows = data.map(c =>
    header.map(k => {
      const v = c[k] ?? '';
      // CSV-escape: wrap in quotes, double internal quotes
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  );
  const csv = [header.join(','), ...rows].join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(`companies-${stamp}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8');
}

/* ---------- 8. Boot ---------- */

(function boot() {
  // Prefer the most recent saved search, if any
  const history = getSearchHistory();
  if (history.length > 0) {
    const latest = history[0];
    loadActiveSearch(latest.id);
    locationInput.value = latest.location || '';
    businessLineInput.value = latest.businessLine || '';
  }
  renderAll();

  // Expose a small hook for the AI panel to consume later
  window.CompanyHunter = {
    state,
    getFilteredSorted,
    renderResults,
    renderAll,
    setAIScore(businessId, result) {
      state.aiScores[businessId] = result;
      saveJSON('aiScores', state.aiScores);
      renderResults();
    },
    clearAIScores() {
      state.aiScores = {};
      saveJSON('aiScores', {});
      renderResults();
    }
  };
})();