// gitboard — a tiny local web dashboard for the git status of every repo under a root,
// and (since 2026-09-16) which Jayverse dev servers are up on this machine.
// Zero dependencies: Node built-ins only. Read-only (never runs a git command that writes).
//
//   node server.mjs                 # scans ~/work, ~/worktree, ~/work-codex; serves on :4321
//   PORT=5000 node server.mjs       # different port
//   GITBOARD_ROOTS=~/work:~/src node server.mjs   # scan multiple roots (colon-separated)

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4321;
const MAX_DEPTH = Number(process.env.GITBOARD_DEPTH) || 4;

// Roots to scan (colon-separated; ~ expands to home). Each root renders as its own section.
const DEFAULT_ROOTS = ['work', 'worktree', 'work-codex'].map((d) => join(homedir(), d)).join(':');
const ROOTS = (process.env.GITBOARD_ROOTS || DEFAULT_ROOTS)
  .split(':')
  .filter(Boolean)
  .map((p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p));

// Directory names we never descend into.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'vendor',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', 'target', '.turbo',
]);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// --- git helpers ---------------------------------------------------------

// Run a git command in a repo. Read-only by construction (callers pass read-only verbs).
function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').toString() });
    });
  });
}

// Walk the roots looking for directories that contain a `.git` (dir OR file, so worktrees count).
// Once a repo is found we stop descending into it (its nested repos are submodules/worktrees).
async function discover() {
  const found = [];
  const seen = new Set();
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    if (existsSync(join(dir, '.git'))) {
      if (!seen.has(dir)) { seen.add(dir); found.push(dir); }
      return; // don't descend into a repo
    }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  for (const root of ROOTS) {
    if (existsSync(root)) await walk(root, 0);
  }
  found.sort();
  return found;
}

// Parse `git status --porcelain=v1 -b` into branch info + file buckets.
function parseStatus(text) {
  const lines = text.split('\n');
  const info = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, staged: [], modified: [], untracked: [] };
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      let rest = line.slice(3);
      if (rest.startsWith('HEAD (no branch)')) { info.detached = true; info.branch = 'HEAD'; continue; }
      const noCommits = rest.match(/^No commits yet on (.+)$/);
      if (noCommits) { info.branch = noCommits[1].trim(); continue; }
      const bracket = rest.match(/\[(.+)\]\s*$/);
      if (bracket) {
        const a = bracket[1].match(/ahead (\d+)/); const b = bracket[1].match(/behind (\d+)/);
        if (a) info.ahead = Number(a[1]);
        if (b) info.behind = Number(b[1]);
        rest = rest.slice(0, bracket.index).trim();
      }
      if (rest.includes('...')) { const [br, up] = rest.split('...'); info.branch = br; info.upstream = up.trim(); }
      else info.branch = rest.trim();
      continue;
    }
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code === '??') { info.untracked.push(path); continue; }
    const index = code[0], work = code[1];
    if (index !== ' ' && index !== '?') info.staged.push({ path, code });
    if (work !== ' ' && work !== '?') info.modified.push({ path, code });
  }
  return info;
}

function parseCommit(line) {
  if (!line) return null;
  const [hash, subject, when, author] = line.split('\u0000');
  return { hash, subject, when, author };
}

// Which scanned root a repo sits under (longest match wins) — the UI groups by this.
function rootOf(dir) {
  const hits = ROOTS.filter((r) => dir === r || dir.startsWith(r + '/'));
  hits.sort((a, b) => b.length - a.length);
  return hits[0] || dirname(dir);
}

// A LINKED worktree has a `.git` FILE holding `gitdir: <main>/.git/worktrees/<name>`.
// (A submodule also uses a .git file, but points at `.git/modules/…` — hence the marker check.)
// Reading the file beats shelling out to `git worktree list` for every repo.
const WT_MARKER = '/.git/worktrees/';
async function worktreeInfo(dir) {
  const gitPath = join(dir, '.git');
  let st;
  try { st = await stat(gitPath); } catch { return null; }
  if (!st.isFile()) return null;
  let text;
  try { text = await readFile(gitPath, 'utf8'); } catch { return null; }
  const m = text.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const gitdir = resolve(dir, m[1].trim());   // may be relative (git --relative-paths)
  const i = gitdir.indexOf(WT_MARKER);
  if (i === -1) return null;
  const mainPath = gitdir.slice(0, i);
  return { mainPath, mainName: basename(mainPath) };
}

async function summarize(dir) {
  const [statusRes, logRes, worktree] = await Promise.all([
    git(dir, ['status', '--porcelain=v1', '-b']),
    git(dir, ['log', '-1', '--format=%h%x00%s%x00%cr%x00%an']),
    worktreeInfo(dir),
  ]);
  const s = parseStatus(statusRes.out);
  const last = logRes.ok ? parseCommit(logRes.out.trim()) : null;
  const dirty = s.staged.length + s.modified.length + s.untracked.length > 0;
  return {
    path: dir,
    name: basename(dir),
    parent: basename(dirname(dir)),
    root: rootOf(dir),
    worktree,          // { mainPath, mainName } when this IS a linked worktree
    worktrees: 0,      // how many linked worktrees point AT this repo (filled in below)
    branch: s.branch || '(unknown)',
    upstream: s.upstream,
    detached: s.detached,
    ahead: s.ahead,
    behind: s.behind,
    counts: { staged: s.staged.length, modified: s.modified.length, untracked: s.untracked.length },
    dirty,
    last,
  };
}

async function detail(dir) {
  const [statusRes, branchRes, logRes] = await Promise.all([
    git(dir, ['status', '--porcelain=v1', '-b']),
    git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(HEAD)%00%(refname:short)%00%(upstream:short)', 'refs/heads/']),
    git(dir, ['log', '-15', '--format=%h%x00%s%x00%cr%x00%an']),
  ]);
  const s = parseStatus(statusRes.out);
  const branches = branchRes.out.split('\n').filter(Boolean).map((l) => {
    const [head, name, up] = l.split('\u0000');
    return { name, upstream: up, current: head.trim() === '*' };
  });
  const commits = logRes.out.split('\n').filter(Boolean).map(parseCommit);
  return {
    staged: s.staged, modified: s.modified, untracked: s.untracked.map((path) => ({ path, code: '??' })),
    branches, commits,
  };
}

// --- services ------------------------------------------------------------
//
// "Which parts of Jayverse are actually up on this machine right now?" (jay,
// 2026-09-16). gitboard already answers that question for repositories; a repo
// being clean tells you nothing about whether its dev server is running, and
// jay was checking seven ports by hand.
//
// Ports are the source of truth here, not a config file: a dev server is
// identified by the port it binds, and that is exactly what the browser will
// try too. Keep this list in step with `localPort` in rabbit's lib/jayverse.ts
// — that file decides where the portal's cards point when it is served from a
// local or Tailscale address, so a disagreement between the two shows up as a
// dead link on jay's phone.
//
// Read-only by construction, like the git half: a GET, or an eth_chainId,
// and nothing else.
const SERVICES = [
  { key: 'rabbit',   name: 'Rabbit',        port: 3100, repo: 'rabbit',           blurb: 'the portal — /chains, /live, /game' },
  { key: 'verex',    name: 'Verex web',     port: 3000, repo: 'verex',            blurb: 'prediction market UI' },
  { key: 'verexapi', name: 'Verex API',     port: 4000, repo: 'verex',            blurb: 'order book + settlement', path: '/health' },
  { key: 'token',    name: 'Token/Exchange',port: 3070, repo: 'jayverse-token',   blurb: 'JYVE · jUSD constant-product pool' },
  { key: 'defi',     name: 'DeFi — jeETH',  port: 3030, repo: 'jayverse-defi',    blurb: 'liquid-staking vault and wrapper' },
  { key: 'wallet',   name: 'Wallet',        port: 3060, repo: 'jayverse-wallet',  blurb: 'embedded wallet + MV3 extension' },
  { key: 'number',   name: 'Number',        port: 3090, repo: 'jayverse-number',  blurb: 'maths and investment notes' },
  { key: 'gitboard', name: 'gitboard',      port: 4321, repo: 'gitboard',         blurb: 'this dashboard' },
  // The chain, probed as a chain rather than as a web page: a 404 from an RPC
  // endpoint would look like "down" when it is simply not a website.
  { key: 'anvil',    name: 'Local Anvil',   port: 8545, repo: null, kind: 'rpc',  blurb: "jay's working chain — do not kill" },
];

// A remote we depend on but do not run. Listed because "is it me or is it
// them" is the first question when a local page shows no chain data.
const REMOTE = [
  { key: 'devnet', name: 'Jayverse devnet', url: 'https://devnet.jaylabs.xyz/status', blurb: 'hosted Anvil, chain 313370' },
];

async function timed(fn) {
  const t0 = Date.now();
  try { const v = await fn(); return { ...v, ms: Date.now() - t0 }; }
  catch (e) { return { state: 'down', detail: String((e && e.message) || e), ms: Date.now() - t0 }; }
}

/** A dev server answering on a port. Anything below 500 counts as up — a
 *  redirect or a 404 is still a live server, and several of these redirect. */
function probeHttp(url) {
  return timed(async () => {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
    return { state: res.status < 500 ? 'up' : 'error', code: res.status };
  });
}

/** A JSON-RPC endpoint. Reports the chain id, which is the useful fact. */
function probeRpc(url) {
  return timed(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(2500),
    });
    const body = await res.json();
    if (!body || !body.result) return { state: 'error', code: res.status, detail: 'no result' };
    return { state: 'up', code: res.status, detail: `chain ${parseInt(body.result, 16)}` };
  });
}

async function services() {
  const local = await Promise.all(SERVICES.map(async (svc) => {
    const url = `http://127.0.0.1:${svc.port}${svc.path || '/'}`;
    const r = svc.kind === 'rpc' ? await probeRpc(`http://127.0.0.1:${svc.port}`) : await probeHttp(url);
    return { ...svc, open: `http://127.0.0.1:${svc.port}`, ...r };
  }));
  const remote = await Promise.all(REMOTE.map(async (svc) => ({
    ...svc, open: svc.url, ...(await probeHttp(svc.url)),
  })));
  return { local, remote, generatedAt: new Date().toISOString() };
}

// --- http ----------------------------------------------------------------

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function serveStatic(res, name) {
  const file = join(HERE, 'public', name);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(name)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/repos') {
      const dirs = await discover();
      const repos = await Promise.all(dirs.map(summarize));
      // Back-link: a main repo shows how many linked worktrees it has.
      const byPath = new Map(repos.map((r) => [r.path, r]));
      for (const r of repos) {
        if (!r.worktree) continue;
        const main = byPath.get(r.worktree.mainPath);
        if (main) main.worktrees += 1;
      }
      return json(res, 200, { roots: ROOTS, home: homedir(), generatedAt: new Date().toISOString(), repos });
    }
    if (url.pathname === '/api/repo') {
      const path = url.searchParams.get('path') || '';
      // Only run git against a path we actually discovered — never arbitrary input.
      const dirs = await discover();
      if (!dirs.includes(path)) return json(res, 404, { error: 'unknown repo' });
      return json(res, 200, await detail(path));
    }
    if (url.pathname === '/api/services') return json(res, 200, await services());
    if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, 'index.html');
    if (url.pathname === '/app.js') return serveStatic(res, 'app.js');
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`gitboard → http://localhost:${PORT}`);
  console.log(`scanning: ${ROOTS.join(', ')}  (depth ${MAX_DEPTH})`);
});
