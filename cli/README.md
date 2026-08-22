# @arshdelight/pop-cli

The `pop` command: a local registry for POP (Protocol of Practice) documents — a personal, content-addressed collection of practice documents built on [@arshdelight/pop-sdk](https://www.npmjs.com/package/@arshdelight/pop-sdk).

## Install

```bash
npm install -g @arshdelight/pop-cli
```

## Commands

```
pop init [path]                initialize a data directory (default: %APPDATA%\pop / ~/.pop)
pop config                     show data dir, remote, registry summary
pop remote set <url>           set the remote provider (e.g. https://practihub.com)
pop remote show | remove       inspect / clear the remote
pop ls [-a] [--json]           list direct pops (-a also lists indirect nodes)
pop new <file.json>            create a pop from a JSON document (or --json '<text>', or stdin)
pop show <hash> [--json] [--doc]   inspect one node (hash prefix OK)
pop web [--port 4317]          browse direct pops in a local web UI
pop login [--no-open]          OAuth login to the remote (browser authorize; --no-open prints the URL)
pop logout                     clear stored credentials (revokes on the server)
pop me                         show the authenticated remote user
pop push [hash]                upload pops to the remote (default: all direct; stored PRIVATE)
pop pull [hash]                fetch pops from the remote (default: all of mine)
pop search [query...]          search pops on the remote (title-first; empty = browse)
                               [--scope public|me|all] [--limit N] [--json]
pop blob add <file-or-url>     stage an attachment; emits the attachment entry
                               (hashes the bytes, stores local blobs in the workspace)
```

The data directory is a POP workspace (nodes content-addressed under `nodes/*.md`); `pop.json` records the remote provider and the registered **direct** roots (indirect = every other node the direct pops reference).

### Login to PractiHub

`pop login` authenticates via **OAuth 2.1 Authorization Code + PKCE** (loopback redirect, RFC 8252): it opens your browser to PractiHub's consent page, exchanges the code for tokens, and stores them in `pop.auth.json` (next to `pop.json`). Credentials are deliberately **kept out of `pop.json`** so the workspace stays commit-safe; on POSIX the file is `chmod 600`.

- Credentials are long-lived but auto-refreshing: commands use the refresh token (rotation) to renew the 1-hour access token, so once logged in, an agent can keep using `pop` without interactive prompts.
- `pop logout` revokes the refresh token on the server (best-effort) and deletes `pop.auth.json`.
- `pop me` verifies the current session and prints the authenticated user / profile / granted scopes.
- Headless / agent environments: use `pop login --no-open`, then open the printed URL manually.

### Push & pull

- `pop push [hash]` uploads a local pop (or all registered **direct** roots) to the remote via `POST /api/v1/pop` (content-addressed, idempotent). Documents are stored **PRIVATE**; making one public is a separate review step (submit → admin approval), keeping "record first, publish later" intact.
- `pop pull [hash]` fetches a document by root hash (public docs readable anonymously; private docs need login as an owner). `pop pull` with no argument pulls **all of your own** documents (`/mine`).
- Ownership on pull: your own documents (private, or public with a DIRECT claim matching your profile) are registered as **direct** roots; someone else's public documents are stored as **indirect** nodes only — they never show up as your uploads.
- Attachments: the hub does not store attachment bytes, so push sends the document with attachment pointers only; blobs stay local (or external `url` if provided).

### Search

- `pop search <query...>` searches the remote via `GET /api/v1/pop/search` — both title and content match, **title hits rank first**; an empty query browses the newest documents.
- `--scope public` (default) searches the published library; `--scope me` searches your own documents in **any status** (including PRIVATE); `--scope all` is the union — your visible universe.
- `--json` dumps the raw API response. Fetch any result with `pop pull <hash>`.

## License

MIT © 2026 arsh tech
