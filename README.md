# gitboard

A tiny local web dashboard that shows the git status of **every repo under a root** — current
branch, ahead/behind vs upstream, and changed files — so you don't have to `cd` around the
terminal to check them.

Zero dependencies (Node built-ins only). **Read-only**: it never runs a git command that writes.

## Run

```bash
node server.mjs           # scans ~/work, ~/worktree, ~/work-codex — opens on http://localhost:4321
# or
npm start
```

Then open http://localhost:4321.

## Options (env vars)

| Var | Default | What |
| --- | --- | --- |
| `PORT` | `4321` | HTTP port |
| `GITBOARD_ROOTS` | `~/work:~/worktree:~/work-codex` | Colon-separated roots to scan (e.g. `~/work:~/src`) |
| `GITBOARD_DEPTH` | `4` | How deep to look for `.git` under each root |

## What it shows

- **Sections:** one titled, rule-separated section per scanned root. A root that holds only linked
  worktrees (`~/worktree`, `~/work-codex`) is tinted, so derived checkouts never read as primary repos.
- **Worktrees:** a linked worktree's card carries a `⧉ <main repo>` chip; the main repo's card
  carries a `⧉ <n>` chip for how many hang off it. Filtering by a repo name also finds its worktrees.
- **Dashboard:** one card per repo — name, current branch, ahead/behind, a dirty/clean badge, and
  counts of staged / modified / untracked files, plus the last commit. Dirty repos sort first.
- **Click a card** to expand: the changed files grouped by state, the branch list (with upstreams),
  and recent commits.
- **Controls:** filter by name, "dirty only" toggle, auto-refresh (every 5s), manual refresh.

## How it works

A linked worktree is spotted without an extra git call: its `.git` is a *file* holding
`gitdir: <main>/.git/worktrees/<name>`, which names the main repo (a submodule's `.git` file points
at `.git/modules/…` instead, so the two don't get confused).

`server.mjs` walks the roots for directories containing a `.git`, runs read-only git commands
(`status --porcelain -b`, `log`, `for-each-ref`) in each, and serves the parsed result as JSON to
the static page in `public/`. The detail endpoint only runs git against a path that was actually
discovered — never arbitrary input.

## Roadmap (v2, not built yet)

- Inline diffs per file.
- Optional write actions (stage / commit / switch branch).
- File-watching for instant updates instead of polling.
