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

## License

MIT © 2026 arsh tech
