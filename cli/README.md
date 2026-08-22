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
pop login [--token <token>]    store a token for the configured remote
pop logout                     clear stored credentials
pop blob add <file-or-url>     stage an attachment; emits the attachment entry
                               (hashes the bytes, stores local blobs in the workspace)
```

The data directory is a POP workspace (nodes content-addressed under `nodes/*.md`); `pop.json` records the remote provider, stored credentials and the registered **direct** roots (indirect = every other node the direct pops reference).

## License

MIT © 2026 arsh tech
