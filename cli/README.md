# practi

The `practi` command (formerly `pop` / `@arshdelight/pop-cli`): a local registry for POP (Protocol of Practice) documents — a personal, content-addressed collection of practice documents, built on [@arshdelight/pop-sdk](https://www.npmjs.com/package/@arshdelight/pop-sdk). Your data lives in your data directory and never leaves the machine; the only network calls are the ones you ask for — self-update (`practi update`), fetching the offline vector model (`practi embed pull`), and staging a URL attachment (`practi blob add <url>`).

## Install

```bash
npm install -g @arshdelight/practi
```

## Commands

```
practi version | --version        show CLI + pop-spec versions
practi spec                      print the bundled pop-spec.md (no network fetch)
practi update                     self-update via npm (checks the registry's latest)
practi init [path]                initialize a data directory (default: ~/.practi)
practi config                     show data dir and registry summary
practi repair                     backfill missing claim timestamps from node file times
                               (idempotent; stamped claims are never touched)
practi ls [-a] [--json]           list direct POPs (-a also lists indirect nodes)
practi new <file.json>            create a POP from a JSON document (or --json '<text>', or stdin)
practi edit <hash> <file.json>    replace a direct POP with new content (new hash; auto-revision
                               + GC of nodes unreachable from any direct root)
practi gc [--apply]                free orphan blobs — bytes no stored node references
                               (dry-run by default; --apply removes)
practi migrate [path] [--keep]     move the workspace to a new data directory (cut: old dir removed
                               after per-file verification; --keep retains a .bak; a path becomes
                               the default via ~/.practi-home)
practi skill install|update|uninstall [--dir <skills-dir>]
                               manage the bundled use-practi skill (default: ~/.agents/skills)
practi skill import <dir> | export <ref> [--dir]
                               replay a skill-export directory back into a POP / project one out
practi show <hash> [--json] [--doc]   inspect one node (hash prefix OK)
practi web [--port 4317] [--no-open]  browse direct POPs in a local web UI
practi search [query...]          search every stored node — direct, indirect and orphans alike:
                               field-weighted BM25, title-first ranking, multi-word AND that may
                               match across fields, `field:` scoping (name: desc: content: flow:
                               loop: op: hash:), and a labeled relax tier for a partial majority
                               of terms. --limit N; --json; --notes also indexes local notes
                               (off by default); --semantic fuses vector recall with the lexical
                               ranking (needs embed pull + build). Empty = browse direct roots
practi similar <hash> [--limit N] [--json]
                               content neighbours: the target subtree becomes the query, every
                               stored node is scored against it, and each hit lists the shared
                               terms that carried it. Literal (character-bigram + latin-word
                               relevance), not semantics — a paraphrase will not surface
practi lint [--json] [--limit N]  audit recording quality across every direct pop: the same W_*
                               hints `practi new` prints once, on demand. Read-only and never
                               blocking (exit code is always 0) — a to-do list, not a gate
practi embed status               report model readiness and index coverage (--json)
practi embed pull                 fetch the offline vector model into <data-dir>/models/
practi embed build [--notes]      build/refresh the vector index, incrementally — only hashes not
                               already cached; --notes embeds local notes too
practi embed prune                drop vector buckets left by an older model fingerprint
                               (the whole layer is optional: no model means lexical-only, and
                               `search --semantic` says what is missing rather than recalling less)
practi remove <hash>               take a direct pop out of the local directory (registry op;
                               GCs nodes unreachable from the rest — shared indirect nodes survive)
practi claim <hash>                register an existing stored node as a direct pop (indirect → direct)
practi unclaim <hash>              take a referenced direct pop back to indirect (fails when unreferenced —
                               that would orphan it; delete with "remove" instead)
practi blob add <file-or-url> [--name <name>]
                               stage an attachment; emits the attachment entry (hashes the bytes,
                               stores local blobs in the workspace). A URL source is fetched
                               through the system proxy and its bytes are stored too — the
                               pointer itself stays hash-only
practi note add <node> -m "<text>"  pin a local learning note to any node hash (sidecar
                               notes.json; hash prefix OK)
practi note list [hash] [--json]  list notes — all (grouped by document) or a subtree
practi note edit|delete <note-id>  edit (-m "<text>") or remove a note (id prefix OK)
practi note promote <note-id> [--out <file>]
                               turn a note back into a **draft** document of its owning direct
                               root, with the note spliced in at the node it was pinned to — it
                               drafts and stops, never edits for you (an edit is a new hash:
                               that call is yours)
```

The data directory is a POP workspace (nodes content-addressed under `nodes/*.md`); `practi.json` records the registered **direct** roots, each with a claim timestamp (time lives on the claim event, never inside content-addressed nodes — the git refs/reflog split; indirect = every other node the direct POPs reference).

### Edit

Editing is replacing: content addressing means an edit produces a **new root hash**. `practi edit <hash> <file.json>` (or `--json` / stdin) validates and stores the new tree, swaps the old root out of the direct registration, and auto-appends a revision record on the root (`from` = old root hash — a history pointer that may dangle by design, never validated). Nodes no longer reachable from any direct root are garbage-collected: content still referenced by another direct POP survives, exclusive descendants go (`--keep` preserves them; `--message` sets the revision note; `--no-revision` skips it).

### Search

- `practi search <query...>` searches **every stored node** — direct, indirect, nodes referenced only through `inputs.from`, and orphans alike. The index text covers name / description / content / declared inputs+outputs / loop prose / op, ranked by field-weighted BM25 with title-first ordering; hits report which field matched. Pure-hex queries (≥4 chars) also match hash prefixes. Derived at search time only: never written back into a node, never part of a hash.
- **Words are ANDed** — every word must match somewhere, and words may match in *different* fields. Quote a phrase to search it whole. `field:value` scopes one word: `name: desc: content: flow: loop: op: hash:`.
- **Partial match is labeled** — when strict matching finds nothing, results relax to a strict majority of terms and say so. Treat a relaxed row as a lead, not an answer.
- Empty query = browse: lists direct roots with their node counts.
- `--json` emits `{query, mode, results, total}`; `--limit N` caps the output (default 20, max 50). `--notes` additionally indexes your local notes (off by default, so existing hit sets are unchanged); `--semantic` fuses vector recall with the lexical ranking via RRF — it needs `embed pull` + `embed build`, and otherwise reports what is missing and is ignored.

### Recording quality (`W_*` hints)

`practi new` prints `W_*` hints **once, at creation**. `practi lint` runs the same checks — the same code, no second standard — across every direct pop, aggregates them by code, and ranks the worst nodes first, so the debt you skipped at creation time stays visible instead of quietly accumulating. It is read-only and always exits 0: a to-do list, not a gate.

`W_*` are never errors: a document that draws them is stored and registered exactly like one that does not (`E_*` remain the only codes that refuse a document). The vocabulary is the shared part, the thresholds are this implementation's own calibration (pop-spec §6) — and `practi lint --json` emits the full set with `code`/`hash`/`name`/`message` for scripting.

### Web

`practi web` serves a local UI on `127.0.0.1` (default port 4317). Data and presentation are separated:

- **Data window** — plain JSON endpoints backed by the workspace: `GET /api/directs` (directory list: hash, name, description, node/step/output counts), `GET /pop/<hash>.json` (§7 standard view), `GET /doc/<hash>.json` (document tree + `nodeIndex`, a hash→tree-path registry for resolving `inputs.from` references), `GET /blobs/<hash>` (attachment bytes), `GET /api/notes?ref=<hash>` (learning notes within that node's subtree).
- **Notes write endpoint** — `POST /api/notes` is how the built-in notes sidebar writes (also available to custom frontends): `{"op":"add","hash":"<node hash>","content":"…"}` / `{"op":"edit","id":"<note id>","content":"…"}` / `{"op":"delete","id":"<note id>"}` with `content-type: application/json` and a same-origin `Origin` header (the same CSRF gate as `/api/run`).
- **Action endpoint** — `POST /api/run` lets a custom frontend trigger CLI commands directly. Request: `{ "cmd": "<name>", "args": { ... } }` with `content-type: application/json` and a same-origin `Origin` header (browser fetch from the page itself satisfies both). Response: `{ "code": <CLI exit code>, "out": "<stdout>", "err": "<stderr>" }`. Runnable commands (the whitelist mirrors the CLI, deliberately narrow):

  | cmd | args | effect |
  |---|---|---|
  | `new` | `{ json: "<POP document text>" }` | create a POP, register it as direct |

  Commands run one at a time (queued). `new` accepts JSON text only — no file paths. The built-in frontend does not use this endpoint; it exists for DIY frontends dropped into `<data-dir>/web/`.
- **Frontend files** — the UI is plain HTML/CSS/JS served from the CLI's bundled `web-default/`. To customize, drop files into `<data-dir>/web/` — files there **override the built-in ones file-by-file** (missing files fall back to the default). Delete a file to return to the built-in version.
- **Live reload** — the server watches the data dir and the frontend directories; every page (built-in or custom) auto-reloads in the browser when a frontend file changes or when another terminal runs `practi new`. Editing the frontend is a save-and-see loop, no rebuild, no restart.

### Notes

- `practi note` keeps **local learning notes** in `notes.json` next to `practi.json` — a sidecar, like `claims`. Each note is pinned to a node hash: content addressing gives the pin exact semantics (the note is about *that version* of the node, and can never drift with edits). Notes never enter the POP protocol body.
- Two write doors, one file: the CLI (`practi note add <node-hash> -m "step 3 needs admin rights on Windows"` — the gate agents go through) and `practi web`'s **notes sidebar** on the detail page (toggle in the header; lists the current node's notes with inline add/edit/delete; empty file just means an empty panel). The wizard view also renders a node's notes inline on its card, and amber dots in the outline mark nodes that carry notes.

## License

MIT © 2026 arsh tech
