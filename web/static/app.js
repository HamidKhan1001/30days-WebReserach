/* last30days — app.js v2 */
'use strict';

const $ = id => document.getElementById(id);

// ── DOM ──────────────────────────────────────
const topicInput       = $('topicInput');
const searchBtn        = $('searchBtn');
const emitSelect       = $('emitSelect');
const competitorsCheck = $('competitorsCheck');
const viewSearch       = $('viewSearch');
const viewResearch     = $('viewResearch');
const viewBrief        = $('viewBrief');
const researchTopic    = $('researchTopic');
const progressFill     = $('progressFill');
const sourceTags       = $('sourceTags');
const logBody          = $('logBody');
const statusBadge      = $('statusBadge');
const resultCard       = $('resultCard');
const placeholderCard  = $('placeholderCard');
const resultFile       = $('resultFile');
const viewBriefBtn     = $('viewBriefBtn');
const linkedinShareBtn = $('linkedinShareBtn');
const newResearchBtn   = $('newResearchBtn');
const newSearchBtn     = $('newSearchBtn');
const briefBackBtn     = $('briefBackBtn');
const briefLinkedinBtn = $('briefLinkedinBtn');
const briefFrame       = $('briefFrame');
const briefTopic       = $('briefTopic');
const topbarTitle      = $('topbarTitle');
const sidebarToggle    = $('sidebarToggle');
const sidebarHistory   = $('sidebarHistory');
const sidebar          = document.querySelector('.sidebar');
const linkedinModal    = $('linkedinModal');
const linkedinText     = $('linkedinText');
const charCount        = $('charCount');
const modalClose       = $('modalClose');
const copyPostBtn      = $('copyPostBtn');
const openLinkedinBtn  = $('openLinkedinBtn');
const sourceCards      = document.querySelectorAll('.source-card');
const chips            = document.querySelectorAll('.chip');

// ── State ─────────────────────────────────────
let currentSlug    = null;
let currentTopic   = null;
let currentOutput  = '';
let progressVal    = 0;
let progressTimer  = null;
let activeES       = null;
const addedTags    = new Set();

// ── Views ─────────────────────────────────────
function showView(name) {
  [viewSearch, viewResearch, viewBrief].forEach(v => v.classList.add('view--hidden'));
  if (name === 'search')   { viewSearch.classList.remove('view--hidden');   topbarTitle.textContent = 'Research'; }
  if (name === 'research') { viewResearch.classList.remove('view--hidden'); topbarTitle.textContent = currentTopic || 'Researching…'; }
  if (name === 'brief')    { viewBrief.classList.remove('view--hidden');    topbarTitle.textContent = currentTopic || 'Brief'; }
}

// ── Progress ──────────────────────────────────
function startProgress() {
  progressVal = 2;
  progressFill.style.width = '2%';
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const gap = 90 - progressVal;
    progressVal += gap * 0.035;
    progressFill.style.width = progressVal.toFixed(1) + '%';
  }, 350);
}

function finishProgress() {
  clearInterval(progressTimer);
  progressVal = 100;
  progressFill.style.width = '100%';
}

// ── Log ───────────────────────────────────────
function appendLog(text, cls = '') {
  const el = document.createElement('span');
  el.className = 'log-line ' + cls;
  el.textContent = text;
  logBody.appendChild(el);
  logBody.scrollTop = logBody.scrollHeight;
}

function logClass(line) {
  if (/error|fail|exception/i.test(line)) return 'error';
  if (/\bwarn/i.test(line))               return 'warn';
  if (/✅|✓|complete|done|success/i.test(line)) return 'ok';
  if (/reddit|youtube|tiktok|twitter|github|polymarket|hacker|hn\b/i.test(line)) return 'source';
  if (/fetch|search|query|plan|scan/i.test(line)) return 'info';
  return '';
}

// ── Source cards + tags ───────────────────────
const SOURCE_RE = {
  reddit:      /reddit|r\//i,
  twitter:     /\btwitter\b|\bx\b|tweet|bird/i,
  youtube:     /youtube|yt.dlp|transcript/i,
  tiktok:      /tiktok/i,
  hackernews:  /hacker.?news|hackernews|\bhn\b/i,
  github:      /github/i,
  polymarket:  /polymarket/i,
  globe:       /grounding|web search|brave/i,
};

const TAG_LABELS = {
  reddit: 'Reddit', twitter: 'X / Twitter', youtube: 'YouTube',
  tiktok: 'TikTok', hackernews: 'HN', github: 'GitHub',
  polymarket: 'Polymarket', globe: 'Web',
};

function pingSource(line) {
  for (const [src, re] of Object.entries(SOURCE_RE)) {
    if (!re.test(line)) continue;
    const card = document.querySelector(`.source-card[data-src="${src}"]`);
    if (card && !card.classList.contains('pinging') && !card.classList.contains('found')) {
      card.classList.add('pinging');
      setTimeout(() => card.classList.replace('pinging', 'found'), 1800);
    }
    if (!addedTags.has(src)) {
      addedTags.add(src);
      const tag = document.createElement('span');
      tag.className = 'src-tag';
      tag.innerHTML = `<span data-icon="${src}"></span>${TAG_LABELS[src]}`;
      sourceTags.appendChild(tag);
      // inject icon
      const ico = tag.querySelector('[data-icon]');
      if (ico && window.Icons?.[src]) ico.innerHTML = window.Icons[src];
    }
  }
}

function resetSources() {
  sourceCards.forEach(c => c.classList.remove('pinging', 'found'));
}

// ── Search ─────────────────────────────────────
async function doSearch(topic) {
  topic = topic.trim();
  if (!topic) { topicInput.focus(); return; }

  currentTopic = topic;
  currentSlug  = null;
  currentOutput = '';
  addedTags.clear();
  logBody.innerHTML = '';
  sourceTags.innerHTML = '';
  resultCard.style.display = 'none';
  placeholderCard.style.display = '';
  statusBadge.textContent = 'running';
  statusBadge.className = 'status-badge running';
  researchTopic.textContent = topic;
  searchBtn.disabled = true;
  resetSources();
  showView('research');
  startProgress();

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
    streamJob(job_id);
  } catch (e) {
    appendLog('Error: ' + e.message, 'error');
    statusBadge.textContent = 'error';
    statusBadge.className = 'status-badge error';
    finishProgress();
    searchBtn.disabled = false;
  }
}

function streamJob(jobId) {
  if (activeES) activeES.close();
  const es = new EventSource(`/api/stream/${jobId}`);
  activeES = es;

  es.addEventListener('status', e => appendLog(JSON.parse(e.data), 'info'));

  es.addEventListener('log', e => {
    const line = JSON.parse(e.data);
    appendLog(line, logClass(line));
    pingSource(line);
  });

  es.addEventListener('chunk', e => {
    currentOutput += JSON.parse(e.data);
  });

  es.addEventListener('done', e => {
    const raw = JSON.parse(e.data);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    finishProgress();
    statusBadge.textContent = 'done';
    statusBadge.className = 'status-badge done';
    appendLog('Research complete', 'ok');
    es.close();
    activeES = null;

    currentSlug = data.slug || '';
    resultFile.textContent = data.filename || '';
    placeholderCard.style.display = 'none';
    resultCard.style.display = '';
    searchBtn.disabled = false;

    viewBriefBtn.onclick    = () => openBrief(data.slug, currentTopic);
    linkedinShareBtn.onclick = () => openLinkedinModal();

    addToHistory(currentTopic, data.slug);
  });

  es.addEventListener('error', e => {
    let msg = 'Unknown error';
    try { msg = JSON.parse(e.data); } catch {}
    finishProgress();
    statusBadge.textContent = 'error';
    statusBadge.className = 'status-badge error';
    appendLog('Error: ' + msg, 'error');
    placeholderCard.style.display = 'none';
    es.close();
    activeES = null;
    searchBtn.disabled = false;
  });
}

// ── Brief ──────────────────────────────────────
function openBrief(slug, topic) {
  briefTopic.textContent = topic || slug;
  briefFrame.src = `/api/brief/${encodeURIComponent(slug)}`;
  briefLinkedinBtn.onclick = () => openLinkedinModal();
  showView('brief');
}

// ── LinkedIn modal ──────────────────────────────
function openLinkedinModal() {
  const post = buildLinkedinPost();
  linkedinText.value = post;
  charCount.textContent = post.length;
  linkedinModal.classList.add('open');
}

function buildLinkedinPost() {
  if (!currentOutput && !currentTopic) return '';
  // Extract key clusters from output
  const clusters = [];
  const lines = currentOutput.split('\n');
  let inCluster = false;
  for (const line of lines) {
    if (/^### \d+\./.test(line)) {
      const title = line.replace(/^### \d+\.\s*/, '').replace(/\(score.*/, '').trim();
      if (title && !title.includes('score') && title.length > 5) clusters.push(title);
      if (clusters.length >= 3) break;
    }
  }

  const bullets = clusters.length
    ? clusters.map(c => `• ${c}`).join('\n')
    : '• Searched Reddit, YouTube, HN, GitHub & more\n• Ranked by real engagement, not editors';

  return `What's the internet saying about "${currentTopic}"?

I used an AI research tool that searched Reddit, YouTube, Hacker News, GitHub, and Polymarket in parallel — here's what people are actually talking about:

${bullets}

This is what social listening looks like when it's powered by real engagement data, not editorial picks.

#AI #Research #${currentTopic?.replace(/\s+/g, '') || 'Tech'} #Innovation`;
}

function closeLinkedinModal() {
  linkedinModal.classList.remove('open');
}

// ── History ────────────────────────────────────
const localHistory = JSON.parse(localStorage.getItem('l30d_history') || '[]');

function addToHistory(topic, slug) {
  const existing = localHistory.findIndex(h => h.slug === slug);
  if (existing !== -1) localHistory.splice(existing, 1);
  localHistory.unshift({ topic, slug, ts: Date.now() });
  if (localHistory.length > 20) localHistory.pop();
  localStorage.setItem('l30d_history', JSON.stringify(localHistory));
  renderHistory();
}

function renderHistory() {
  if (!localHistory.length) {
    sidebarHistory.innerHTML = '<div class="sidebar-empty">No searches yet</div>';
    return;
  }
  sidebarHistory.innerHTML = localHistory.slice(0, 12).map(h => `
    <button class="sidebar-history-item" data-slug="${h.slug}" data-topic="${escHtml(h.topic)}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${escHtml(h.topic)}
    </button>
  `).join('');
  sidebarHistory.querySelectorAll('.sidebar-history-item').forEach(el => {
    el.addEventListener('click', () => openBrief(el.dataset.slug, el.dataset.topic));
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Events ─────────────────────────────────────
document.querySelector('#searchBox form')?.addEventListener('submit', e => { e.preventDefault(); doSearch(topicInput.value); });
// No form, use keydown
topicInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(topicInput.value); });
searchBtn.addEventListener('click', () => doSearch(topicInput.value));

chips.forEach(chip => {
  chip.addEventListener('click', () => { topicInput.value = chip.dataset.topic; doSearch(chip.dataset.topic); });
});

newSearchBtn.addEventListener('click', () => { showView('search'); topicInput.focus(); });
newResearchBtn.addEventListener('click', () => { showView('search'); topicInput.focus(); });
briefBackBtn.addEventListener('click', () => { showView('research'); briefFrame.src = 'about:blank'; });

sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('collapsed'));

modalClose.addEventListener('click', closeLinkedinModal);
linkedinModal.addEventListener('click', e => { if (e.target === linkedinModal) closeLinkedinModal(); });

linkedinText.addEventListener('input', () => { charCount.textContent = linkedinText.value.length; });

copyPostBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(linkedinText.value).then(() => {
    copyPostBtn.innerHTML = `<span data-icon="check"></span>Copied!`;
    if (window.Icons?.check) copyPostBtn.querySelector('[data-icon=check]').innerHTML = window.Icons.check;
    setTimeout(() => {
      copyPostBtn.innerHTML = `<span data-icon="copy"></span>Copy text`;
      if (window.Icons?.copy) copyPostBtn.querySelector('[data-icon=copy]').innerHTML = window.Icons.copy;
    }, 2000);
  });
});

openLinkedinBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(linkedinText.value).catch(() => {});
  window.open('https://www.linkedin.com/feed/', '_blank');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (linkedinModal.classList.contains('open')) { closeLinkedinModal(); return; }
    if (!viewBrief.classList.contains('view--hidden')) { showView('research'); briefFrame.src = 'about:blank'; return; }
  }
  if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    showView('search');
    topicInput.focus();
  }
});

// ── Init ───────────────────────────────────────
renderHistory();
