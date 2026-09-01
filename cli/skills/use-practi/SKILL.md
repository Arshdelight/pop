---
name: use-practi
description: Record, search, read, publish, evaluate, and manage practice
  documents with the practi CLI — a local, content-addressed registry of POP
  (Protocol of Practice) documents that syncs to a hub (default PractiHub). Use
  whenever the user wants to save what was just done as a reusable practice
  ("record this practice", "save this session", "turn this into steps"), search
  or read practices ("search practices", "has anyone done X", "find a how-to"),
  evaluate them ("what do people say about this practice", "comment on this
  step", "is this practice any good"), annotate your own learning ("take a note
  on this step", "note what I learned while reproducing"), or manage them
  ("publish", "submit for review", "unpublish", "delete my practice") — even
  when practi is not mentioned by name. Also for any explicit practi CLI usage
  (practi new, practi show, practi ls, practi push, practi pull, practi clone,
  practi search, practi comment, practi note, practi login, practi blob add,
  practi skill import, practi skill export, …), and for converting between
  formats ("turn this skill into a POP", "export this practice as a skill").
---

One JSON document = one practice tree. Leaves are **actions** — atomic skills; interior nodes are **practices** — compositions. Everything except `name` is optional, and type is inferred: a node with `children` is a practice, one without is an action.

Three principles hold everywhere:

- **Identity is content.** A node's SHA-256 hash is its only address; the root hash is a Merkle root over the whole tree. Editing a node produces a new hash — nothing is edited in place (the git model). `name` is display text, not an id: renaming changes the hash like any edit.
- **A document format, not a workflow engine.** Nothing executes. Judgment — waiting times, acceptance prose, loop predicates — stays in human-readable text.
- **Prose before fields.** What needs no machine semantics belongs in `content`; a field exists only when structure earns its place.

The data directory (default `~/.practi`) is the workspace: nodes content-addressed under `nodes/*.md`; `practi.json` records the remote and the registered **direct** roots (indirect = every other node the direct POPs reference). Learning notes live beside it in a `notes.json` sidecar (local only).

## Setup

```bash
npm install -g @arshdelight/practi
practi init          # initialize the workspace
practi config        # data dir, remote, registry summary
practi login         # OAuth in the browser; --no-open prints the URL for headless agents
```

The remote defaults to https://practihub.com — `practi remote set <url>` only when pointing at another hub. Credentials live in `practi.auth.json` (kept out of `practi.json`, auto-refreshing): log in once, keep using `practi` without prompts. `practi me` verifies the session; `practi logout` revokes and clears it.

Local use needs no account; logging in only matters for publishing, commenting, and syncing. (Upgrades from the pre-rename `pop` CLI keep working: the old data directory and credentials are found automatically.)

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
- Pointers hash, bytes don't: changed bytes → changed blob hash → changed pointer → a new node identity. Attachments are immutable content — the entry goes into the document **before** `practi new`, never mutated onto an existing node.
- `practi push` transports **pointers only**; blob bytes never leave the machine.

## Local workflow

```bash
practi new doc.json          # or: practi new --json '<text>'  /  practi new < doc.json (stdin)
practi new doc.json --remote [--publish]
                               # --remote creates on the hub ONLY (the hub parses + hashes the
                               # authoring JSON; nothing written locally — it returns on the next
                               # practi pull); --publish also submits it for review (requires --remote)
practi edit <hash> doc.json  # replace a direct POP (new hash; auto-revision + GC of unreachable nodes)
practi edit <hash> doc.json --remote
                               # replace on the hub ONLY — your claim on <hash> (prefix OK, checked
                               # against your remote claims) swaps to the new document; nothing local
practi remove <hash> [--keep] # take a direct pop out of the local directory (registry op; GCs
                               # unreachable nodes — shared indirect nodes survive; --keep keeps)
practi show <hash>           # aggregate view; --json machine view; --doc full document form
practi ls [-a]               # direct roots; -a adds indirect nodes
practi search --local <q>    # offline search over every stored node (name/description/content; hash prefixes too)
practi web                   # browse direct POPs in a local web UI
practi gc [--apply]          # free orphan blobs — bytes no stored node references
                               # (dry-run by default; --apply removes)
practi migrate [path] [--keep] # cut: move the workspace (old dir removed after per-file
                               #  verification; --keep retains a .bak; a path becomes the
                               #  default via ~/.practi-home)
```

- `practi new` validates through the SDK, persists the content-addressed tree, registers the root as direct, and prints the root hash with `status: valid, registered as direct`. On validation issues the tree is stored but **not** registered — read the printed `E_*` issues, fix the JSON, re-run.
- `practi show` accepts a unique hash prefix (≥4 hex digits); `--doc` emits the expanded document — the starting point for forking or refining.

## Remote workflow

```bash
practi push [hash]         # push new local claims (fetch /mine, diff, upload only new ones); stored PRIVATE — record first, publish later
practi search [query...]   # --scope public|me|all, --limit N, --json; title hits rank first; empty = browse newest; --local searches the workspace instead
practi pull [hash]         # sync YOUR claims from the remote (default: all of mine)
practi clone <hash>        # fetch a public POP and claim it (local direct + remote claim)
practi submit [hash]       # PRIVATE → PENDING_REVIEW; auto review passes → public (already-approved skips re-review); default: all direct
practi unpublish [hash]    # withdraw a submission / take a published POP out of public
practi remove <hash> --remote # withdraw your claim on the remote (hash required; local workspace
                               # untouched; `practi delete <hash>` remains an alias)
```

- Reads of published docs are anonymous; writes and private reads need `practi login`.
- Re-pushing the same content is idempotent (content-addressed); pushing again after withdrawing the remote claim recreates it — fresh record, PRIVATE.

## Evaluating practices

```bash
practi comment list <hash> [--node <hash>]   # comments: whole-doc = that document's own; --node = a shared node across the network
practi comment tally <hash>                  # support/neutral/oppose distribution
practi comment add <hash> --node <hash> --valence support|neutral|oppose -m "<text>"
practi comment edit <comment-id> -m "<text>" # free edit (author only)
practi comment delete <comment-id>           # hard delete (author only)
practi comment report <comment-id> --reason illegal|infringement|spam|other [--detail "<why>"]
```

- Comments are a **hub extension**, not part of the POP protocol: flat (no replies), one per (user, node), valence required (default neutral), free edit, hard delete. They never touch the document or its hash.
- **Viewing** — `list <hash>` shows comments made in that document's context; `--node <hash>` shows a shared node's comments across every document that uses it (the DAG view). `tally` prints the support/neutral/oppose distribution — display-only, never a score, never a ranking input.
- **Review** — comments are publish-then-review (automated content safety); a flagged comment is hidden and editing it resubmits it. Reported comments go through platform review with the source document as context; a confirmed report deletes the comment and notifies its author.
- **Endorsement is reuse** — a "support" comment is just a note. The real endorsement is structural: publishing a document that references a node is what endorses it.

## Local notes

```bash
practi note add <hash> -m "<text>"       # pin a learning note to any node (hash prefix OK)
practi note list [hash]                  # all notes grouped by document; with a hash: that subtree only
practi note edit <note-id> -m "<text>"   # 8-hex id, unique prefix works
practi note delete <note-id>
```

- Notes are **local and private** — a `notes.json` sidecar, never uploaded. Division of labor with comments: a note is your learning/reproduction experience (what actually worked, where you deviated, dead ends); a comment is public judgment on content authenticity.
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
| `E_DANGLING` | a `{hash}` child not stored locally / on the hub |
| `E_FLOW_FROM` | `from` names no node in scope |
| `E_HASH_FORMAT` | not `sha256:` + 64 lowercase hex |
| `E_MEDIA_REF` | inline media reference with no matching attachment |
| `E_BLOB_MISSING` / `E_BLOB_CORRUPT` | blob absent / bytes disagree with the pointer |

## Workflow quick reference

- **Record a session** — extract what was done from the conversation → shape one JSON tree (quality rules above) → `practi new doc.json` → confirm `status: valid` → `practi show <hash>` to review → optional `practi push`.
- **Find prior art** — `practi search <query>` → `practi clone <hash>` → `practi show <hash>`.
- **Learn from a practice** — reproduce it, then pin what you learned to the step that taught it: `practi note add <node-hash> -m "…"`. Notes stay local; public endorsement is a comment or a `refines`.
- **Edit one of your direct POPs** — `practi show <hash> --doc > doc.json` → edit the JSON → `practi edit <hash> doc.json --message "what changed"`. The edit validates and stores the new tree, swaps the direct root, appends a revision (`from` = old root — a history pointer, may dangle by design), and garbage-collects nodes no longer referenced by any direct POP (`--keep` preserves them; blobs stay put — `practi gc` sweeps orphaned ones on demand). Local only: sync the hub afterwards with `practi push` then `practi remove <old-root> --remote`. Editing is replacing — new content lives under a new root hash. Improving **someone else's** (or an indirect) practice is a new document with `refines` set, via `practi new`.
- **Evaluate / see what people say** — `practi comment list <hash>` → `practi comment tally <hash>`; leave feedback with `practi comment add <hash> --node <hash> --valence support|neutral|oppose -m "…"`.
