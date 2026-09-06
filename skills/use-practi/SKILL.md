---
name: use-practi
description: Record, search, read, and manage practice documents with the
  practi CLI — a local, content-addressed registry of POP (Protocol of
  Practice) documents. Use whenever the user wants to save what was just done
  as a reusable practice ("record this practice", "save this session", "turn
  this into steps"), search or read practices ("search my practices", "find a
  how-to I saved"), annotate your own learning ("take a note on this step",
  "note what I learned while reproducing"), or manage them ("delete my
  practice", "clean orphan blobs") — even when practi is not mentioned by name.
  Also for any explicit practi CLI usage (practi new, practi show, practi ls,
  practi search, practi note, practi blob add, practi skill import, practi
  skill export, …), and for converting between formats ("turn this skill into
  a POP", "export this practice as a skill").
---

One JSON document = one practice tree. Leaves are **actions** — atomic skills; interior nodes are **practices** — compositions. Everything except `name` is optional, and type is inferred: a node with `children` is a practice, one without is an action.

Three principles hold everywhere:

- **Identity is content.** A node's SHA-256 hash is its only address; the root hash is a Merkle root over the whole tree. Editing a node produces a new hash — nothing is edited in place (the git model). `name` is display text, not an id: renaming changes the hash like any edit.
- **A document format, not a workflow engine.** Nothing executes. Judgment — waiting times, acceptance prose, loop predicates — stays in human-readable text.
- **Prose before fields.** What needs no machine semantics belongs in `content`; a field exists only when structure earns its place.

The data directory (default `~/.practi`) is the workspace: nodes content-addressed under `nodes/*.md`; `practi.json` records the registered **direct** roots (indirect = every other node the direct POPs reference). Learning notes live beside it in a `notes.json` sidecar (local only).

## Setup

```bash
npm install -g @arshdelight/practi
practi init          # initialize the workspace
practi config        # data dir and registry summary
```

Everything is local and offline: no account, no network. (Upgrades from the pre-rename `pop` CLI keep working: the old data directory is found automatically.)

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

Check every document against these before `practi new`:

- **Detailed** — someone who wasn't here can reproduce it: exact commands, file changes, config values, concrete specs. Record what was actually done — dead ends included — not the idealized version.
- **Sanitized** — remove values specific to the author that a reproducer won't reuse: own repos, accounts, usernames, addresses, phones, credentials, personal hostnames/IPs — even embedded in commands, and even inside attachment bytes (screenshots, logs). Replace with descriptive placeholders (`<your-github-username>/repo`). Keep third-party package names, public endpoints, standard tools, and command structure.
- **Curated** — a child step is something a reproducer physically does. Research and deciding are not steps; their conclusions go in `content`. Test: *would a reproducer physically do this, or only need its conclusion?*

## Attachments

Stage the bytes first, then paste the emitted entry into the document:

```bash
practi blob add <file-or-url> [--name <name>]
```

- **Local file** — hashed and stored into the workspace blob channel (`blobs/<2 hex>/<64 hex>`); emits the entry without `url`. Needs an initialized workspace (`practi init`), or validation later reports `E_BLOB_MISSING`.
- **http(s) URL** — fetched once (25 MB limit); the bytes are ALSO stored into the workspace blob channel and the entry is emitted **without** `url` (practi pointers are pure hash — the url is just the import channel; spec §5 still allows the field).

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

- `![caption](attachment-name)` resolves node-locally against this node's own list; attachment names must be unique within a node; any target that is not exactly an entry of that list — http(s) URLs included — is `E_MEDIA_REF` (external media references are not valid grammar; use an attachment or a plain markdown link).
- Pointers hash, bytes don't: changed bytes → changed blob hash → changed pointer → a new node identity. Attachments are immutable content — the entry goes into the document **before** `practi new`, never mutated onto an existing node.

## Local workflow

```bash
practi new doc.json          # or: practi new --json '<text>'  /  practi new < doc.json (stdin)
practi edit <hash> doc.json  # replace a direct POP (new hash; auto-revision + GC of unreachable nodes)
practi remove <hash>         # take a direct pop out of the local directory (registry op; GCs
                               # unreachable nodes — shared indirect nodes survive)
practi show <hash>           # aggregate view; --json machine view (steps carry content —
                               # the one-read reproduction view); --doc full document form
practi ls [-a]               # direct roots; -a adds indirect nodes
practi search <q>            # offline search over every stored node
                               # (name/description/content; hash prefixes too; empty = browse)
practi web                   # browse direct POPs in a local web UI
practi gc [--apply]          # free orphan blobs — bytes no stored node references
                               # (dry-run by default; --apply removes)
practi migrate [path] [--keep] # cut: move the workspace (old dir removed after per-file
                               #  verification; --keep retains a .bak; a path becomes the
                               #  default via ~/.practi-home)
```

- `practi new` validates through the SDK, persists the content-addressed tree, registers the root as direct, and prints the root hash with `status: valid, registered as direct`. On validation issues the tree is stored but **not** registered — read the printed `E_*` issues, fix the JSON, re-run.
- `practi show` accepts a unique hash prefix (≥4 hex digits); `--doc` emits the expanded document — the starting point for forking or refining.
- **Reading vs editing**: to follow or reproduce a practice, read the aggregate view (`show`, or `show --json` — steps come with their content, one read is enough); to edit, fork, or reason about the op structure (choice branches, loop bodies, set sections), read `--doc` — the aggregate flattens those by design.

## Local notes

```bash
practi note add <hash> -m "<text>"       # pin a learning note to any node (hash prefix OK)
practi note list [hash]                  # all notes grouped by document; with a hash: that subtree only
practi note edit <note-id> -m "<text>"   # 8-hex id, unique prefix works
practi note delete <note-id>
```

- Notes are **local** — a `notes.json` sidecar. A note is your learning/reproduction experience: what actually worked, where you deviated, dead ends.
- A note pins to **any** node hash, not just document roots — annotate the exact step that taught you something. Content addressing makes the pin exact: a note always refers to precisely this version of the content, and edits that replace a node leave the old note in place (kept, listed last as dangling).
- `--json` prints a flat machine list (no grouping); human output groups by owning document, newest document first. `practi web` renders and edits the viewed document's notes in a right-hand panel — same file, same data as the CLI.

## Skill ⇄ POP conversion

```bash
practi skill export <ref> [--dir <out>]  # a POP → an installable skill directory (default: ./<name>)
practi skill import <dir>                # replay a `practi skill export` directory back into a POP
```

- An exported directory carries `SKILL.md` (a readable projection), attachment files, and `pop.doc.json` — the sidecar holding the canonical document. Import replays the sidecar byte-identically (same hash, any machine), re-staging attachment files into the local blob store.
- Import refuses directories without a sidecar (`E_NO_SIDECAR`): it is the inverse of export, not a skill importer. To bring a foreign skill into POP, read it and **author** a structured tree of practices and actions (the recording-quality rules apply) — flattening its text into one node would discard exactly the structure POP exists for.
- Hand-editing `SKILL.md` after export desynchronizes the sidecar: import warns and treats the edited body as truth (a new hash — fork semantics). Edit the POP and re-export instead.

## Error codes

| Code | Trigger |
|---|---|
| `E_SCHEMA` | shape violation: unknown field anywhere, derived fields on a practice, op/children/loop on an action, duplicate attachment names, unresolvable `@label` |
| `E_DANGLING` | a `{hash}` child not stored locally |
| `E_FLOW_FROM` | `from` names no node in scope |
| `E_HASH_FORMAT` | not `sha256:` + 64 lowercase hex |
| `E_MEDIA_REF` | inline media reference with no matching attachment |
| `E_BLOB_MISSING` / `E_BLOB_CORRUPT` | blob absent / bytes disagree with the pointer |

## Workflow quick reference

- **Record a session** — extract what was done from the conversation → shape one JSON tree (quality rules above) → `practi new doc.json` → confirm `status: valid` → `practi show <hash>` to review.
- **Find prior art** — `practi search <query>` → `practi show <hash>`.
- **Learn from a practice** — reproduce it, then pin what you learned to the step that taught it: `practi note add <node-hash> -m "…"` (notes stay local).
- **Edit one of your direct POPs** — `practi show <hash> --doc > doc.json` → edit the JSON → `practi edit <hash> doc.json --message "what changed"`. The edit validates and stores the new tree, swaps the direct root, appends a revision (`from` = old root — a history pointer, may dangle by design), and garbage-collects nodes no longer referenced by any direct POP (`--keep` preserves them; blobs stay put — `practi gc` sweeps orphaned ones on demand). Editing is replacing — new content lives under a new root hash. Improving an indirect practice is a new document with `refines` set, via `practi new`.
