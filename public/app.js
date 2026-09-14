// gitboard front-end: poll /api/repos, render cards, expand one on click.
const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const metaEl = document.getElementById('meta');
const rootsEl = document.getElementById('roots');
const q = document.getElementById('q');
const dirtyOnly = document.getElementById('dirtyOnly');
const auto = document.getElementById('auto');
const refreshBtn = document.getElementById('refresh');

let repos = [];
let roots = [];                // scanned roots, in server order — one section each
let home = '';                 // for shortening /Users/jay/... to ~/...
const openPaths = new Set();   // which repo detail panels are expanded
let timer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tilde = (p) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);

function trackHtml(r) {
  if (r.detached) return '<span class="track">detached HEAD</span>';
  if (!r.upstream) return '<span class="track">no upstream</span>';
  const parts = [];
  if (r.ahead) parts.push(`<span class="ahead">↑${r.ahead}</span>`);
  if (r.behind) parts.push(`<span class="behind">↓${r.behind}</span>`);
  if (!parts.length) parts.push('in sync');
  return `<span class="track" title="vs ${esc(r.upstream)}">${parts.join(' ')}</span>`;
}

function countsHtml(c) {
  const bits = [];
  if (c.staged) bits.push(`<span class="s">●${c.staged} staged</span>`);
  if (c.modified) bits.push(`<span class="m">●${c.modified} modified</span>`);
  if (c.untracked) bits.push(`<span class="u">●${c.untracked} untracked</span>`);
  return bits.length ? `<div class="counts">${bits.join('')}</div>` : '';
}

// A linked worktree names its main repo; a main repo names how many hang off it.
function linkHtml(r) {
  if (r.worktree) return `<span class="wt" title="linked worktree of ${esc(r.worktree.mainPath)}">⧉ ${esc(r.worktree.mainName)}</span>`;
  if (r.worktrees) return `<span class="wt ghost" title="has ${r.worktrees} linked worktree(s)">⧉ ${r.worktrees}</span>`;
  return '';
}

function cardHtml(r) {
  const cls = r.dirty ? 'dirty' : 'clean';
  const branchCls = r.detached ? 'branch detached' : 'branch';
  const last = r.last
    ? `<div class="last"><span class="h">${esc(r.last.hash)}</span><span class="subj">${esc(r.last.subject)}</span><span>· ${esc(r.last.when)}</span></div>`
    : `<div class="last">no commits yet</div>`;
  return `
    <div class="card ${cls}" data-path="${esc(r.path)}">
      <div class="card-head">
        <div class="name-row">
          <span class="name">${esc(r.name)}</span>
          <span class="parent">${esc(r.parent)}/</span>
          ${linkHtml(r)}
          <span class="badge ${cls}">${r.dirty ? 'DIRTY' : 'clean'}</span>
        </div>
        <div class="row2">
          <span class="${branchCls}">⎇ ${esc(r.branch)}</span>
          ${trackHtml(r)}
          ${countsHtml(r.counts)}
        </div>
        ${last}
      </div>
      <div class="detail" data-detail hidden></div>
    </div>`;
}

function filtered() {
  const term = q.value.trim().toLowerCase();
  return repos.filter((r) => {
    if (dirtyOnly.checked && !r.dirty) return false;
    const hay = `${r.name} ${r.parent} ${r.worktree ? r.worktree.mainName : ''}`.toLowerCase();
    if (term && !hay.includes(term)) return false;
    return true;
  });
}

// Bucket by scanned root, keeping the server's root order; unknown roots trail.
function groupsOf(list) {
  const map = new Map();
  for (const r of list) {
    const key = r.root || '(other)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  const known = roots.filter((k) => map.has(k));
  const extra = [...map.keys()].filter((k) => !known.includes(k)).sort();
  return [...known, ...extra].map((key) => ({ key, items: map.get(key) }));
}

function groupHtml(g) {
  // A root holding only linked worktrees is tinted, so it reads as derived, not primary.
  const allWt = g.items.every((r) => r.worktree);
  const dirty = g.items.filter((r) => r.dirty).length;
  const count = `${g.items.length} ${g.items.length === 1 ? 'repo' : 'repos'}${dirty ? ` · ${dirty} dirty` : ''}`;
  return `
    <section class="group${allWt ? ' worktrees' : ''}">
      <div class="group-head">
        <span class="group-title">${allWt ? '<span class="icon">⧉</span>' : ''}${esc(tilde(g.key))}</span>
        <span class="rule"></span>
        <span class="group-count">${count}</span>
      </div>
      <div class="grid">${g.items.map(cardHtml).join('')}</div>
    </section>`;
}

function render() {
  const list = filtered();
  // dirty first, then name
  list.sort((a, b) => (b.dirty - a.dirty) || a.name.localeCompare(b.name));
  if (!list.length) {
    grid.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = repos.length ? 'No repos match the filter.' : 'No git repos found under the scanned roots.';
    return;
  }
  emptyEl.hidden = true;
  grid.innerHTML = groupsOf(list).map(groupHtml).join('');
  for (const path of openPaths) {
    const card = grid.querySelector(`.card[data-path="${CSS.escape(path)}"]`);
    if (card) loadDetail(card, path);
  }
}

function fileList(items, cls) {
  if (!items.length) return '';
  const li = items.map((f) => `<li><span class="code">${esc(f.code)}</span><span>${esc(f.path)}</span></li>`).join('');
  return `<ul class="files ${cls}">${li}</ul>`;
}

async function loadDetail(card, path) {
  const box = card.querySelector('[data-detail]');
  box.hidden = false;
  if (!box.dataset.loaded) box.innerHTML = '<span class="spin">Loading…</span>';
  try {
    const d = await fetch(`/api/repo?path=${encodeURIComponent(path)}`).then((r) => r.json());
    box.dataset.loaded = '1';
    const changed = d.staged.length + d.modified.length + d.untracked.length;
    const filesSection = changed
      ? `<section><h4>Changed files (${changed})</h4>
           ${fileList(d.staged, 'staged')}${fileList(d.modified, 'modified')}${fileList(d.untracked, 'untracked')}</section>`
      : '<section><h4>Changed files</h4><div class="spin">Working tree clean.</div></section>';
    const branches = d.branches.map((b) =>
      `<span class="b ${b.current ? 'current' : ''}">${esc(b.name)}${b.upstream ? ` → ${esc(b.upstream)}` : ''}</span>`).join('');
    const commits = d.commits.map((c) =>
      `<li><span class="h">${esc(c.hash)}</span><span class="subj">${esc(c.subject)}</span><span>${esc(c.when)}</span></li>`).join('');
    box.innerHTML = `
      ${filesSection}
      <section><h4>Branches (${d.branches.length})</h4><div class="branches">${branches}</div></section>
      <section><h4>Recent commits</h4><ul class="commits">${commits}</ul></section>`;
  } catch {
    box.innerHTML = '<span class="spin">Failed to load detail.</span>';
  }
}

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const path = card.dataset.path;
  const box = card.querySelector('[data-detail]');
  if (openPaths.has(path)) { openPaths.delete(path); box.hidden = true; }
  else { openPaths.add(path); loadDetail(card, path); }
});

async function load() {
  metaEl.textContent = 'refreshing…';
  try {
    const data = await fetch('/api/repos').then((r) => r.json());
    repos = data.repos || [];
    roots = data.roots || [];
    home = data.home || '';
    rootsEl.textContent = roots.map(tilde).join('  ·  ');
    const dirty = repos.filter((r) => r.dirty).length;
    const wt = repos.filter((r) => r.worktree).length;
    const wtBit = wt ? ` · ${wt} ${wt === 1 ? 'worktree' : 'worktrees'}` : '';
    metaEl.textContent = `${repos.length} repos${wtBit} · ${dirty} dirty · ${new Date().toLocaleTimeString()}`;
    render();
  } catch {
    metaEl.textContent = 'failed to reach server';
  }
}

function schedule() {
  clearInterval(timer);
  if (auto.checked) timer = setInterval(load, 5000);
}

q.addEventListener('input', render);
dirtyOnly.addEventListener('change', render);
auto.addEventListener('change', schedule);
refreshBtn.addEventListener('click', load);

load();
schedule();
