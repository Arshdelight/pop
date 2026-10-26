# practi

The `practi` command (formerly `pop` / `@arshdelight/pop-cli`): **practice folders with full local history** for POP (Protocol of Practice) documents, built on [@arshdelight/pop-sdk](https://www.npmjs.com/package/@arshdelight/pop-sdk). A practice is a self-contained folder you own — the pop is a plain JSON file you edit with any editor, and the history lives beside it like `.git`. Nothing leaves the machine except the syncs you ask for (`practi push` / `pull` / `clone` against [practihub](https://practihub.com)).

## A practice folder

```
green-tea/
  green-tea.json      the pop — a plain document, edit it with anything
  .practi/            the history (like .git):
    chain.json          commits {seq, root, parent, message} + branch pointers
    nodes/              every revision, content-addressed (hash = identity)
    blobs/              attachment bytes
```

The working file and the head usually match; when they don't, you have **uncommitted changes** — `practi commit` snapshots them as a new revision, `practi export <head>` discards them. History rewriting is local and git-style; `push` reconciles with the hub (divergence errors; `--force` overwrites and the hub drops unreachable objects).

## Install

```bash
npm install -g @arshdelight/practi
```

## Commands

```
birth · edit · sync (run inside a practice folder unless noted)
  practi new <name> [--base <file.json>] [-m <msg>]  birth a practice folder in cwd;
                                   --base seeds the first revision from a pop document
  practi commit [-m <msg>] [--amend]   snapshot the working file as a new revision
                                   (local only; nothing to commit when it matches the
                                   head; --amend replaces the head instead)
  practi export <hash> [-o <file>]       write any revision back out as a document
  practi push [--force]            sync to the hub (first push creates the instance there)
  practi pull                      fetch missing revisions, fast-forward, update the
                                   working file (refuses when it has uncommitted changes)
  practi clone <owner>/<name>[@branch] [--dir <path>]
                                   clone a hub practice into a local folder (full chain)

history
  practi log [--branch <b>] [--limit N] [--json]   commits, tip first
  practi branch [name] [-d <name>] [--from <hash>]   list (* = current) / create / delete
  practi switch <branch>           switch branches; the working file follows the head
                                   (refuses when dirty — commit first)
  practi merge <branch>            fast-forward, else a pointer move (same-tree commits
                                   are identical — POP §9.1: one row per root)
  practi history reword <seq> -m <msg> | squash <seq> | drop <seq> | reset <seq>
                                   rewrite the local chain; the working file is left as
                                   is (git reset semantics) — keep it with a commit or
                                   discard it with export

inside a practice folder
  practi show <hash> [--json] [--doc]   inspect one revision node (hash prefix OK)
  practi search [query...] [--json]     search this practice's revisions (BM25, title-first,
                                   multi-word AND across fields, field: scoping, hash
                                   prefixes, labeled partial-match tier; --notes includes
                                   local notes; --semantic fuses vector recall when the
                                   optional model is installed)
  practi similar <hash>         content neighbours within this practice (literal bigram
                                   similarity — a paraphrase will not surface)
  practi lint                   quality hints on the current branch head (read-only, always
                                   exits 0 — a to-do list, not a gate)
  practi note add|list|edit|delete   learning notes pinned to node hashes (.practi/notes.json,
                                   never uploaded; the notes sidebar in `practi web` writes
                                   the same file)
  practi blob add <file-or-url> [--name <name>]   store attachment bytes (.practi/blobs/)
  practi embed status|pull|build|prune   optional offline vector model (.practi/models/),
                                   scoped to this practice; without it search is lexical
  practi gc [--apply]           free orphan blobs (dry-run by default)
  practi web [--port 4317]      browse practices locally: inside a practice folder it serves
                                   the commit chain, branches, and the per-revision reader
                                   (wizard / standard view / tree); anywhere else it serves
                                   the practices home (default ~/.practi/practices) as a
                                   directory page — click through to the reader

anywhere
  practi init [path]            create the config home (credentials + remote; default ~/.practi)
  practi remote set <url> | remove    point at a hub
  practi login [--no-open] [--reauth]   OAuth sign-in (PKCE, browser consent); logout revokes
  practi me                     show the signed-in account and scopes
  practi config                 show config home and remote
  practi fix <file.json> [--dry-run]  migrate a POP 1.x document file to 2.0
  practi skill install | update | uninstall | import <dir> | export <ref>
  practi spec                   print the bundled pop-spec.md (no network)
  practi update                 self-update via npm
  practi version | --version    show CLI + pop-spec versions
```

Retired with the pops registry (2026-10-20): `edit` `ls` `list` `remove` `claim` `unclaim` `publish` `fetch` `repair` `migrate` — each prints where it went. The config home (`~/.practi`) only holds `practi.json` (remote) and `practi.auth.json` (credentials); practices are plain folders wherever you keep your documents.

### Editing

Editing is replacing: content addressing means a commit produces a **new root hash**. You never call an editor through practi — the working file *is* the document, and `practi commit -m "..."` records it. `--amend` replaces the head instead of appending (message-only amend rewords). `practi history` rewrites the local chain freely (reword / squash / drop / reset); pushed chains diverge and need `practi push --force`, which rebuilds the hub side and drops unreachable revisions.

### Notes

`practi note` keeps local learning notes in the practice's `.practi/notes.json`, each pinned to a node hash — the pin is about *that version* and can never drift. Two write doors, one file: the CLI and the notes sidebar in `practi web`.

### Hub (practihub, optional)

A practice folder maps one-to-one onto a hub **instance** — a single-owner, GitHub-like home for one POP's revision chain with branches. `practi push` births the hub copy on first push; `practi clone <owner>/<name>` brings a full chain down as a folder. Content addressing is untouched: the hub re-derives hashes server-side with the same SDK, and visibility follows the instance (PUBLIC chains readable by anyone, PRIVATE only by the owner). Everything hub-side needs `practi login` + `practi remote set`.

## License

MIT © 2026 arsh tech
