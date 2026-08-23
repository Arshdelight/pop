---
name: use-pop
description: Record, search, read, publish, and manage practice documents with the pop CLI — a local, content-addressed registry of POP (Protocol of Practice) documents that syncs to a hub (default PractiHub). Use whenever the user wants to save what was just done as a reusable practice ("record this practice", "save this session", "turn this into steps"), search or read practices ("search practices", "has anyone done X", "find a how-to"), or manage them ("publish", "submit for review", "unpublish", "delete my practice") — even when pop is not mentioned by name. Also for any explicit pop CLI usage (pop new, pop show, pop ls, pop push, pop pull, pop search, pop login, pop blob add, …).
---

# Use pop

## Mental model

One JSON document = one practice tree. Leaves are **actions** — atomic skills; interior nodes are **practices** — compositions. Everything except `name` is optional, and type is inferred: a node with `children` is a practice, one without an action.

Three principles hold everywhere:

- **Identity is content.** A node's SHA-256 hash is its only address; the root hash is a Merkle root over the whole tree. Editing a node produces a new hash — nothing is edited in place (the git model). `name` is display text, not an id: renaming changes the hash like any edit.
- **A document format, not a workflow engine.** Nothing executes. Judgment — waiting times, acceptance prose, loop predicates — stays in human-readable text.
- **Prose before fields.** What needs no machine semantics belongs in `content`; a field exists only when structure earns its place.

The data directory (default `%APPDATA%\pop` / `~/.pop`) is the workspace: nodes content-addressed under `nodes/*.md`; `pop.json` records the remote and the registered **direct** roots (indirect = every other node the direct pops reference).

## Setup

```bash
npm install -g @arshdelight/pop-cli
pop init          # initialize the workspace
pop config        # data dir, remote, registry summary
pop login         # OAuth in the browser; --no-open prints the URL for headless agents
```

The remote defaults to https://practihub.com — `pop remote set <url>` only when pointing at another hub. Credentials live in `pop.auth.json` (kept out of `pop.json`, auto-refreshing): log in once, keep using `pop` without prompts. `pop me` verifies the session; `pop logout` revokes and clears it.

## Writing a document

| Field | On | Meaning |
|---|---|---|
| `name` | both | display label (required); renaming changes the hash like any edit |
| `description` | both | one line — what this skill does, for discovery/selection |
| `content` | both | the body: details, narrative, warnings (trimmed for the hash) |
| `op` | practice | `seq` (default, ordered) · `par` parallelizable · `choice` alternatives · `loop` repetition (`{mode:"count",count:N}` or `{mode:"until",until:"<prose>"}`) · `set` directory view, no aggregation |
| `children` | practice | inline subtrees (recursive, same shape) or `{ "hash": … }` refs to stored POPs — interchangeable |
| `inputs` | action | consumed flows: `name` + optional `spec`; optional `from` wires one producer |
| `outputs` | action | produced flows — the step's acceptance criteria (`from` not allowed) |
| `attachments` | action | blob pointers (below) |
| `revisions` | both | history records `{when, what}` — travel with the document |
| `refines` | practice | hash of the node this practice improves — the refinement edge |
| `license` / `metadata` | both | reuse terms / vendor bag (`x-<vendor>-<name>` keys) |

```json
{
  "name": "Make tea",
  "description": "From kettle to cup",
  "children": [
    { "name": "Boil water", "content": "Heat until boiling.",
      "outputs": [{ "name": "boiling water", "spec": "100°C" }] },
    { "name": "Pour", "content": "Pour along the wall.",
      "inputs": [{ "name": "boiling water", "from": "@Boil water" }] }
  ]
}
```

Rules that bite:

- **Unknown fields are rejected** (`E_SCHEMA`), never dropped — silently dropping a field forks hashes. **Empty ≡ absent**: an optional field set to `""` or `[]` hashes exactly as if omitted.
- `attachments` / `inputs` / `outputs` are **action-only**; on a practice they are a schema error (they are derived aggregate views).
- `inputs.from` accepts authoring sugar `"@<name>"`, resolved against this document's inline nodes; the stored form always carries hashes.
- Children may inline recursively or reference stored content as `{ "hash": "sha256:…" }` — both forms produce the same root hash.

## Recording quality

Check every document against these before `pop new`:

- **Detailed** — someone who wasn't here can reproduce it: exact commands, file changes, config values, concrete specs. Record what was actually done — dead ends included — not the idealized version.
- **Sanitized** — remove values specific to the author that a reproducer won't reuse: own repos, accounts, usernames, addresses, phones, credentials, personal hostnames/IPs — even embedded in commands, and even inside attachment bytes (screenshots, logs). Replace with descriptive placeholders (`<your-github-username>/repo`). Keep third-party package names, public endpoints, standard tools, and command structure.
- **Curated** — a child step is something a reproducer physically does. Research and deciding are not steps; their conclusions go in `content`. Test: *would a reproducer physically do this, or only need its conclusion?*

## Attachments

Stage the bytes first, then paste the emitted entry into the document:

```bash
pop blob add <file-or-url> [--name <name>]
```

- **Local file** — hashed and stored into the workspace blob channel (`blobs/<2 hex>/<64 hex>`); emits the entry without `url`. Needs an initialized workspace (`pop init`), or validation later reports `E_BLOB_MISSING`.
- **http(s) URL** — fetched once to compute the identity hash (25 MB limit); emits the entry **with** `url` — bytes stay external, identity remains the hash.

The command prints a ready-to-paste object. Put it on the **action's** `attachments`, then reference it from `content`:

```json
{
  "type": "action",
  "name": "Demonstrate",
  "content": "The result:\n\n![pour demo](pour-demo.mp4)",
  "attachments": [
    { "name": "pour-demo.mp4", "hash": "sha256:…", "mime": "video/mp4", "size": 18342 }
  ]
}
```

- `![caption](attachment-name)` resolves node-locally against this node's own list; attachment names must be unique within a node; a referenced but missing name → `E_MEDIA_REF`. A raw `![caption](https://…)` target is an external reference, exempt.
- Pointers hash, bytes don't: changed bytes → changed blob hash → changed pointer → a new node identity. Attachments are immutable content — the entry goes into the document **before** `pop new`, never mutated onto an existing node.
- `pop push` transports **pointers only**; blob bytes never leave the machine.

## Local workflow

```bash
pop new doc.json        # or: pop new --json '<text>'  /  pop new < doc.json (stdin)
pop edit <hash> doc.json  # replace a direct pop (new hash; auto-revision + GC of unreachable nodes)
pop show <hash>         # aggregate view; --json machine view; --doc full document form
pop ls [-a]             # direct roots; -a adds indirect nodes
pop web                 # browse direct pops in a local web UI
```

- `pop new` validates through the SDK, persists the content-addressed tree, registers the root as direct, and prints the root hash with `status: valid, registered as direct`. On validation issues the tree is stored but **not** registered — read the printed `E_*` issues, fix the JSON, re-run.
- `pop show` accepts a unique hash prefix (≥4 hex digits); `--doc` emits the expanded document — the starting point for forking or refining.

## Remote workflow

```bash
pop push [hash]         # upload (default: all direct); stored PRIVATE — record first, publish later
pop search [query...]   # --scope public|me|all, --limit N, --json; title hits rank first; empty = browse newest
pop pull [hash]         # fetch one, or all of your own; others' public docs land as indirect nodes only
pop submit [hash]       # PRIVATE → PENDING_REVIEW (admin approves before public); default: all direct
pop unpublish [hash]    # withdraw a submission / take a published pop out of public
pop delete <hash>       # remove your direct claim on the remote (hash required; local workspace untouched)
```

- Reads of published docs are anonymous; writes and private reads need `pop login`.
- Re-pushing the same content is idempotent (content-addressed); pushing again after `pop delete` recreates it — fresh record, PRIVATE.

## Error codes

| Code | Trigger |
|---|---|
| `E_SCHEMA` | shape violation: unknown field anywhere, derived fields on a practice, op/children/loop on an action, duplicate attachment names, unresolvable `@label` |
| `E_DANGLING` | a `{hash}` child not stored locally / on the hub |
| `E_FLOW_FROM` | `from` names no node in scope |
| `E_HASH_FORMAT` | not `sha256:` + 64 lowercase hex |
| `E_MEDIA_REF` | inline media reference with no matching attachment |
| `E_BLOB_MISSING` / `E_BLOB_CORRUPT` | blob absent / bytes disagree with the pointer |

## Workflow quick reference

- **Record a session** — extract what was done from the conversation → shape one JSON tree (quality rules above) → `pop new doc.json` → confirm `status: valid` → `pop show <hash>` to review → optional `pop push`.
- **Find prior art** — `pop search <query>` → `pop pull <hash>` → `pop show <hash>`.
- **Edit one of your direct pops** — `pop show <hash> --doc > doc.json` → edit the JSON → `pop edit <hash> doc.json --message "what changed"`. The edit validates and stores the new tree, swaps the direct root, appends a revision (`from` = old root — a history pointer, may dangle by design), and garbage-collects nodes no longer referenced by any direct pop (`--keep` preserves them; blobs are never GC'd). Local only: sync the hub afterwards with `pop push` then `pop delete <old-root>`. Editing is replacing — new content lives under a new root hash. Improving **someone else's** (or an indirect) practice is a new document with `refines` set, via `pop new`.
