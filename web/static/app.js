/* last30days web UI — frontend logic */
'use strict';

// ── DOM refs ─────────────────────────────────────────────
const $  = id => document.getElementById(id);
const searchForm      = $('searchForm');
const topicInput      = $('topicInput');
const searchBtn       = $('searchBtn');
const competitorsCheck = $('competitorsCheck');
const emitSelect      = $('emitSelect');
const researchOverlay = $('researchOverlay');
const researchTopic   = $('researchTopic');
const progressFill    = $('progressFill');
const progressSources = $('progressSources');
const logBody         = $('logBody');
const logBadge        = $('logBadge');
const resultArea      = $('resultArea');
const resultSub       = $('resultSub');
const viewBriefBtn    = $('viewBriefBtn');
const newResearchBtn  = $('newResearchBtn');
const researchClose   = $('researchClose');
const historyToggle   = $('historyToggle');
const historyPanel    = $('historyPanel');
const historyClose    = $('historyClose');
const historyBackdrop = $('historyBackdrop');
const historyList     = $('historyList');
const briefModal      = $('briefModal');
const briefIframe     = $('briefIframe');
const briefBack       = $('briefBack');
const briefModalTitle = $('briefModalTitle');
const sourceItems     = document.querySelectorAll('.source-item');
const chips           = document.querySelectorAll('.chip');

// ── State ────────────────────────────────────────────────
let currentJobId = null;
let currentResultPath = null;
let currentEventSource = null;
let progressValue = 0;
let progressInterval = null;

// ── Source mapping ───────────────────────────────────────
const SOURCE_PATTERNS = {
  reddit:     /reddit|r\//i,
  x:          /\btwitter\b|\bx\b|tweet|bird/i,
  youtube:    /youtube|yt-dlp|transcript/i,
  tiktok:     /tiktok/i,
  hn:         /hacker news|hackernews/i,
  github:     /github/i,
  polymarket: /polymarket/i,
  web:        /grounding|web search|brave/i,
};

function highlightSource(line) {
  for (const [src, re] of Object.entries(SOURCE_PATTERNS)) {
    if (re.test(line)) {
      const el = document.querySelector(`.source-item[data-src="${src}"]`);
      if (el && !el.classList.contains('active')) {
        el.classList.add('active');
        setTimeout(() => el.classList.replace('active', 'found'), 2000);
      }
    }
  }
}

function resetSources() {
  sourceItems.forEach(el => {
    el.classList.remove('active', 'found');
  });
}

// ── Progress simulation ──────────────────────────────────
function startProgress() {
  progressValue = 0;
  progressFill.style.width = '0%';
  clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    // Asymptotic approach to 90% — real completion sets 100%
    const remaining = 90 - progressValue;
    progressValue += remaining * 0.04;
    progressFill.style.width = `${progressValue.toFixed(1)}%`;
  }, 400);
}

function completeProgress() {
  clearInterval(progressInterval);
  progressValue = 100;
  progressFill.style.width = '100%';
}

// ── Log helpers ──────────────────────────────────────────
function appendLog(text, cls = '') {
  const line = document.createElement('span');
  line.className = `log-line ${cls}`;
  line.textContent = text;
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;
}

function classifyLog(line) {
  if (/error|fail|exception/i.test(line)) return 'log-error';
  if (/warn/i.test(line))                  return 'log-warn';
  if (/✅|done|complete|success/i.test(line)) return 'log-ok';
  if (/reddit|youtube|tiktok|twitter|github|polymarket|hacker/i.test(line)) return 'log-source';
  if (/\bfetch|\bsearch|\bquery|\bplan/i.test(line)) return 'log-info';
  return '';
}

// ── Source tags in progress bar ──────────────────────────
const _addedTags = new Set();
function maybeAddSourceTag(line) {
  const map = {
    'Reddit':      '🔴 Reddit',
    'YouTube':     '▶ YouTube',
    'X / Twitter': '𝕏 X',
    'TikTok':      '♪ TikTok',
    'Hacker News': '▲ HN',
    'GitHub':      '⌥ GitHub',
    'Polymarket':  '📊 Poly',
    'Web':         '🌐 Web',
  };
  for (const [key, label] of Object.entries(map)) {
    if (line.includes(key) && !_addedTags.has(key)) {
      _addedTags.add(key);
      const tag = document.createElement('span');
      tag.className = 'progress-source-tag';
      tag.textContent = label;
      progressSources.appendChild(tag);
    }
  }
}

// ── Open/close overlay ───────────────────────────────────
function openOverlay(topic) {
  researchTopic.textContent = topic;
  logBody.innerHTML = '';
  progressSources.innerHTML = '';
  resultArea.style.display = 'none';
  logBadge.textContent = 'running';
  logBadge.className = 'log-badge running';
  _addedTags.clear();
  researchOverlay.classList.add('open');
  startProgress();
  resetSources();
}

function closeOverlay() {
  researchOverlay.classList.remove('open');
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  clearInterval(progressInterval);
}

// ── Brief modal ──────────────────────────────────────────
function openBrief(path, topic) {
  briefModalTitle.textContent = topic || 'Brief';
  briefIframe.src = `/api/brief/${encodeURIComponent(path.split('/').pop().replace('-brief.html', '').replace('-raw.md', ''))}`;
  briefModal.classList.add('open');
}

function closeBrief() {
  briefModal.classList.remove('open');
  setTimeout(() => { briefIframe.src = 'about:blank'; }, 300);
}

// ── History panel ────────────────────────────────────────
function openHistory() {
  loadHistory();
  historyPanel.classList.add('open');
  historyBackdrop.classList.add('open');
}

function closeHistory() {
  historyPanel.classList.remove('open');
  historyBackdrop.classList.remove('open');
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const items = await res.json();
    if (!items.length) {
      historyList.innerHTML = '<div class="history-empty">No research yet</div>';
      return;
    }
    historyList.innerHTML = items.map(item => `
      <div class="history-item" data-slug="${item.slug}" data-type="${item.type}">
        <div class="history-item-icon">🔍</div>
        <div class="history-item-body">
          <div class="history-item-topic">${escapeHtml(item.topic)}</div>
          <div class="history-item-meta">${item.type === 'html' ? 'HTML brief' : 'Markdown'} · ${timeAgo(item.modified * 1000)}</div>
        </div>
      </div>
    `).join('');

    historyList.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', () => {
        closeHistory();
        const topicText = el.querySelector('.history-item-topic').textContent;
        openBrief(el.dataset.slug, topicText);
      });
    });
  } catch (e) {
    historyList.innerHTML = '<div class="history-empty">Failed to load</div>';
  }
}

// ── Search ───────────────────────────────────────────────
async function doSearch(topic) {
  if (!topic.trim()) { topicInput.focus(); return; }
  topic = topic.trim();

  openOverlay(topic);
  searchBtn.disabled = true;

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        emit: emitSelect.value,
        competitors: competitorsCheck.checked,
      }),
    });
    const { job_id, error } = await res.json();
    if (error) throw new Error(error);
    currentJobId = job_id;
    streamJob(job_id, topic);
  } catch (e) {
    appendLog(`Error: ${e.message}`, 'log-error');
    logBadge.textContent = 'error';
    logBadge.className = 'log-badge error';
    searchBtn.disabled = false;
  }
}

function streamJob(jobId, topic) {
  const es = new EventSource(`/api/stream/${jobId}`);
  currentEventSource = es;

  es.addEventListener('status', e => {
    appendLog(JSON.parse(e.data), 'log-info');
  });

  es.addEventListener('log', e => {
    const line = JSON.parse(e.data);
    appendLog(line, classifyLog(line));
    highlightSource(line);
    maybeAddSourceTag(line);
  });

  es.addEventListener('chunk', e => {
    // stdout chunks — just track progress
  });

  es.addEventListener('done', e => {
    const raw = JSON.parse(e.data);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    completeProgress();
    logBadge.textContent = 'done';
    logBadge.className = 'log-badge done';
    appendLog('✅ Research complete', 'log-ok');
    es.close();

    currentResultPath = data.result_path;
    resultSub.textContent = data.filename || (data.result_path ? data.result_path.split('/').pop() : '');
    resultArea.style.display = 'block';
    searchBtn.disabled = false;

    viewBriefBtn.onclick = () => openBrief(data.slug || topic, topic);
  });

  es.addEventListener('error', e => {
    let msg = 'Unknown error';
    try { msg = JSON.parse(e.data); } catch {}
    completeProgress();
    logBadge.textContent = 'error';
    logBadge.className = 'log-badge error';
    appendLog(`Error: ${msg}`, 'log-error');
    es.close();
    searchBtn.disabled = false;
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return;
    es.close();
  };
}

// ── Utils ────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs/24)}d ago`;
}

// ── Events ───────────────────────────────────────────────
searchForm.addEventListener('submit', e => {
  e.preventDefault();
  doSearch(topicInput.value);
});

chips.forEach(chip => {
  chip.addEventListener('click', () => {
    topicInput.value = chip.dataset.topic;
    doSearch(chip.dataset.topic);
  });
});

researchClose.addEventListener('click', closeOverlay);
newResearchBtn.addEventListener('click', () => { closeOverlay(); topicInput.focus(); });

historyToggle.addEventListener('click', openHistory);
historyClose.addEventListener('click', closeHistory);
historyBackdrop.addEventListener('click', closeHistory);

briefBack.addEventListener('click', closeBrief);

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (briefModal.classList.contains('open')) { closeBrief(); return; }
    if (historyPanel.classList.contains('open')) { closeHistory(); return; }
    if (researchOverlay.classList.contains('open')) { closeOverlay(); return; }
  }
  // Focus search with /
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
    e.preventDefault();
    topicInput.focus();
  }
});
