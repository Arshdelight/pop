# practi

The `practi` command (formerly `pop` / `@arshdelight/pop-cli`): a local registry for POP (Protocol of Practice) documents — a personal, content-addressed collection of practice documents that syncs to [PractiHub](https://practihub.com), built on [@arshdelight/pop-sdk](https://www.npmjs.com/package/@arshdelight/pop-sdk).

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
practi config                     show data dir, remote, registry summary
practi remote set <url>           set the remote provider (e.g. https://practihub.com)
practi remote show | remove       inspect / clear the remote
practi repair                     backfill missing claim timestamps from node file times
                               (idempotent; stamped claims are never touched)
practi ls [-a] [--json]           list direct POPs (-a also lists indirect nodes)
practi new <file.json>            create a POP from a JSON document (or --json '<text>', or stdin)
practi clone <hash>               fetch a public POP and claim it (local direct + remote claim)
practi edit <hash> <file.json>    replace a direct POP with new content (new hash; auto-revision
                               + GC of nodes unreachable from any direct root)
practi gc [--apply]                free orphan blobs — bytes no stored node references
                               (dry-run by default; --apply removes)
practi show <hash> [--json] [--doc]   inspect one node (hash prefix OK)
practi web [--port 4317]          browse direct POPs in a local web UI
practi login [--no-open]          OAuth login to the remote (browser authorize; --no-open prints the URL)
practi logout                     clear stored credentials (revokes on the server)
practi me                         show the authenticated remote user
practi push [hash]                push new local claims to the remote (only new ones; stored PRIVATE)
practi pull [hash]                sync YOUR claims from the remote (default: all of mine)
practi search [query...]          search POPs on the remote (title-first; empty = browse)
                               [--scope public|me|all] [--limit N] [--json]
practi submit [hash]               submit POPs for public review (default: all direct)
practi unpublish [hash]            withdraw a submission / take one back out of public
practi remove <hash> [--keep]      take a direct pop out of the local directory (registry op;
                               GCs nodes unreachable from the rest — shared indirect nodes survive)
practi remove <hash> --remote      withdraw your claim on the remote (hash required; local
                               untouched; `practi delete <hash>` remains an alias)
practi blob add <file-or-url>     stage an attachment; emits the attachment entry
                               (hashes the bytes, stores local blobs in the workspace)
practi note add <node> -m "<text>"  pin a local learning note to any node hash (sidecar
                               notes.json, never uploaded; hash prefix OK)
practi note list [hash] [--json]  list notes — all (grouped by document) or a subtree
practi note edit|delete <note-id>  edit (-m "<text>") or remove a note (id prefix OK)
```

The data directory is a POP workspace (nodes content-addressed under `nodes/*.md`); `practi.json` records the remote provider and the registered **direct** roots, each with a claim timestamp (time lives on the claim event, never inside content-addressed nodes — the git refs/reflog split; indirect = every other node the direct POPs reference).

### Login to PractiHub

The CLI defaults its remote to **https://practihub.com** — `practi login` works out of the box; run `practi remote set <url>` only when pointing at another hub (e.g. a local dev server).

`practi login` authenticates via **OAuth 2.1 Authorization Code + PKCE** (loopback redirect, RFC 8252): it opens your browser to PractiHub's consent page, exchanges the code for tokens, and stores them in `practi.auth.json` (next to `practi.json`). Credentials are deliberately **kept out of `practi.json`** so the workspace stays commit-safe; on POSIX the file is `chmod 600`.

- Credentials are long-lived but auto-refreshing: commands use the refresh token (rotation) to renew the 1-hour access token, so once logged in, an agent can keep using `practi` without interactive prompts.
- `practi logout` revokes the refresh token on the server (best-effort) and deletes `practi.auth.json`.
- `practi me` verifies the current session and prints the authenticated user / profile / granted scopes.
- Headless / agent environments: use `practi login --no-open`, then open the printed URL manually.
- Dead credentials never block a re-login: `practi login` probes the stored session — if the remote rejects it (or it was issued by a different hub), it is auto-cleared and the login proceeds; if the hub is merely unreachable, credentials are kept and the error says `cannot reach <remote>` instead of blaming the session. `practi remote set` revokes (best-effort) and clears credentials issued by the previous hub.

### Edit

Editing is replacing: content addressing means an edit produces a **new root hash**. `practi edit <hash> <file.json>` (or `--json` / stdin) validates and stores the new tree, swaps the old root out of the direct registration, and auto-appends a revision record on the root (`from` = old root hash — a history pointer that may dangle by design, never validated). Nodes no longer reachable from any direct root are garbage-collected — the local counterpart of the hub's claim reconciliation: content still referenced by another direct POP survives, exclusive descendants go (`--keep` preserves them; `--message` sets the revision note; `--no-revision` skips it). Purely local — the hub still holds the old version: sync with `practi push` + `practi delete <old-root>`.

### Push, pull & clone

- `practi push [hash]` pushes **only the local claims the remote doesn't already have for you** (git-style): it first fetches your claim list (`/mine`, paginated), diffs against your local **direct** roots, and uploads just the new ones via `POST /api/v1/pop` (content-addressed, idempotent). Documents are stored **PRIVATE**; making one public is a separate review step (submit → auto review), keeping "record first, publish later" intact.
- `practi pull [hash]` syncs **your own** claims from the remote: it fetches your claim list (`/mine`, paginated), diffs against your local direct roots, and pulls the missing documents (registered as **direct**). It never touches the public library — there is no ownership guessing; anything outside your claims is public content for `practi clone`.
- `practi clone <hash>` fetches a **public** document and claims it (fork semantics): the document lands in your workspace, is registered as a local **direct** root, and is pushed back to the remote so the claim is consistent both ways. Cloning something you already claim is idempotent.
- Attachments: the hub does not store attachment bytes, so push sends the document with attachment pointers only; blobs stay local (or external `url` if provided).

### Search

- `practi search <query...>` searches the remote via `GET /api/v1/pop/search` — both title and content match, **title hits rank first**; an empty query browses the newest documents.
- `--scope public` (default) searches the published library; `--scope me` searches your own documents in **any status** (including PRIVATE); `--scope all` is the union — your visible universe.
- `--json` dumps the raw API response. Fetch any result with `practi clone <hash>`.

### Web

`practi web` serves a local UI on `127.0.0.1` (default port 4317). Data and presentation are separated:

- **Data window** — plain JSON endpoints backed by the workspace: `GET /api/directs` (directory list: hash, name, description, node/step/output counts), `GET /pop/<hash>.json` (§7 standard view), `GET /doc/<hash>.json` (document tree + `nodeIndex`, a hash→tree-path registry for resolving `inputs.from` references), `GET /blobs/<hash>` (attachment bytes), `GET /api/notes?ref=<hash>` (learning notes within that node's subtree).
- **Notes write endpoint** — `POST /api/notes` is how the built-in notes sidebar writes (also available to custom frontends): `{"op":"add","hash":"<node hash>","content":"…"}` / `{"op":"edit","id":"<note id>","content":"…"}` / `{"op":"delete","id":"<note id>"}` with `content-type: application/json` and a same-origin `Origin` header (the same CSRF gate as `/api/run`).
- **Action endpoint** — `POST /api/run` lets a custom frontend trigger CLI commands directly. Request: `{ "cmd": "<name>", "args": { ... } }` with `content-type: application/json` and a same-origin `Origin` header (browser fetch from the page itself satisfies both). Response: `{ "code": <CLI exit code>, "out": "<stdout>", "err": "<stderr>" }`. Runnable commands (the whitelist mirrors the CLI, deliberately narrow):

  | cmd | args | effect |
  |---|---|---|
  | `new` | `{ json: "<POP document text>" }` | create a POP, register it as direct |
  | `pull` | `{ hash? }` | sync your hub claims into the local workspace |
  | `push` | `{ hash? }` | push local claim deltas to the hub |
  | `login` | `{ noOpen? }` | OAuth login (opens the system browser; the request hangs until you finish authorization) |
  | `logout` | — | revoke and drop stored credentials |
  | `me` | — | show the current login state |

  Commands run one at a time (queued). `new` accepts JSON text only — no file paths. The built-in frontend does not use this endpoint; it exists for DIY frontends dropped into `<data-dir>/web/`.
- **Frontend files** — the UI is plain HTML/CSS/JS served from the CLI's bundled `web-default/`. To customize, drop files into `<data-dir>/web/` — files there **override the built-in ones file-by-file** (missing files fall back to the default). Delete a file to return to the built-in version.
- **Live reload** — the server watches the data dir and the frontend directories; every page (built-in or custom) auto-reloads in the browser when a frontend file changes or when another terminal runs `practi new` / `practi pull`. Editing the frontend is a save-and-see loop, no rebuild, no restart.

### Notes

- `practi note` keeps **local learning notes** in `notes.json` next to `practi.json` — a sidecar, like `claims`. Each note is pinned to a node hash: content addressing gives the pin exact semantics (the note is about *that version* of the node, and can never drift with edits). Notes never enter the POP protocol body and are never uploaded.
- The division of labor with the remote: **notes = your learning/reproduction experience (local, private)**; **`practi comment` = content authenticity (public, on the hub)**.
- Two write doors, one file: the CLI (`practi note add <node-hash> -m "step 3 needs admin rights on Windows"` — the gate agents go through) and `practi web`'s **notes sidebar** on the detail page (toggle in the header; lists the current node's notes with inline add/edit/delete; empty file just means an empty panel). The wizard view also renders a node's notes inline on its card, and amber dots in the outline mark nodes that carry notes.

### Lifecycle (submit / unpublish / delete)

- `practi submit [hash]` submits your direct pops for public review (`PRIVATE → PENDING_REVIEW`; an auto review passes before they go public — already-approved content skips re-review). Omit the hash to submit all direct pops — non-PRIVATE ones are skipped and counted as failures.
- `practi unpublish [hash]` withdraws a pending submission or takes a published POP back out of public distribution (`→ PRIVATE`).
- `practi delete <hash>` removes your direct claim on the remote (children's indirect claims are reclaimed; a document with no claims left is hard-deleted). Explicit hash required — there is no delete-all. Pure remote operation: your local workspace is untouched, and pushing the same content again recreates it (fresh row, PRIVATE).

## License

MIT © 2026 arsh tech
