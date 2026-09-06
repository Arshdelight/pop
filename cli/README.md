# practi

The `practi` command (formerly `pop` / `@arshdelight/pop-cli`): a local registry for POP (Protocol of Practice) documents — a personal, content-addressed collection of practice documents, built on [@arshdelight/pop-sdk](https://www.npmjs.com/package/@arshdelight/pop-sdk). Fully offline: everything lives in your data directory, nothing leaves the machine.

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
practi search [query...]          search the local workspace (name/description/content substring
                               + hash prefixes; empty = browse direct roots; --limit N; --json)
practi remove <hash>               take a direct pop out of the local directory (registry op;
                               GCs nodes unreachable from the rest — shared indirect nodes survive)
practi blob add <file-or-url>     stage an attachment; emits the attachment entry
                               (hashes the bytes, stores local blobs in the workspace)
practi note add <node> -m "<text>"  pin a local learning note to any node hash (sidecar
                               notes.json; hash prefix OK)
practi note list [hash] [--json]  list notes — all (grouped by document) or a subtree
practi note edit|delete <note-id>  edit (-m "<text>") or remove a note (id prefix OK)
```

The data directory is a POP workspace (nodes content-addressed under `nodes/*.md`); `practi.json` records the registered **direct** roots, each with a claim timestamp (time lives on the claim event, never inside content-addressed nodes — the git refs/reflog split; indirect = every other node the direct POPs reference).

### Edit

Editing is replacing: content addressing means an edit produces a **new root hash**. `practi edit <hash> <file.json>` (or `--json` / stdin) validates and stores the new tree, swaps the old root out of the direct registration, and auto-appends a revision record on the root (`from` = old root hash — a history pointer that may dangle by design, never validated). Nodes no longer reachable from any direct root are garbage-collected: content still referenced by another direct POP survives, exclusive descendants go (`--keep` preserves them; `--message` sets the revision note; `--no-revision` skips it).

### Search

- `practi search <query...>` searches the local workspace: case-insensitive substring match over name/description/content of every stored node (including indirect); pure-hex queries (≥4 chars) also match hash prefixes.
- Empty query = browse: lists direct roots with their node counts.
- `--json` emits `{query, results, total}`; `--limit N` caps the output (default 20, max 50).

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
