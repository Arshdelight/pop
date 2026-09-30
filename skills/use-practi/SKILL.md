---
name: use-practi
description: Record, search, read, and manage practice documents with the
  practi CLI — a local, content-addressed registry of POP (Protocol of
  Practice) documents. Use whenever the user wants to save what was just done
  as a reusable practice ("record this practice", "save this session", "turn
  this into steps"), search or read practices ("search my practices", "find a
  how-to I saved", "what else is about this"), annotate your own learning ("take
  a note on this step", "note what I learned while reproducing") or fold a note
  back into the practice it came from, or manage them ("delete my
  practice", "clean orphan blobs") — even when practi is not mentioned by name.
  Also for any explicit practi CLI usage (practi new, practi show, practi ls,
  practi search, practi similar, practi note, practi blob add, practi skill
  import, practi skill export, …), and for converting between formats ("turn
  this skill into a POP", "export this practice as a skill").
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
- Export (`show --doc`, `skill export`) rewrites an in-subtree from pin as its `@name` label when the name is unambiguous — editing the referenced child then re-resolves by name on import instead of dangling on the old hash. Out-of-subtree or same-name-ambiguous pins export verbatim.
- Children may inline recursively or reference stored content as `{ "hash": "sha256:…" }` — both forms produce the same root hash.

## Recording quality

Check every document against these before `practi new`:

- **Detailed** — someone who wasn't here can reproduce it: exact commands, file changes, config values, concrete specs. Record what was actually done — dead ends included — not the idealized version.
- **Sanitized** — remove values specific to the author that a reproducer won't reuse: own repos, accounts, usernames, addresses, phones, credentials, personal hostnames/IPs — even embedded in commands, and even inside attachment bytes (screenshots, logs). Replace with descriptive placeholders (`<your-github-username>/repo`). Keep third-party package names, public endpoints, standard tools, and command structure.
- **Curated** — a child step is something a reproducer physically does. Research and deciding are not steps; their conclusions go in `content`. Test: *would a reproducer physically do this, or only need its conclusion?*

### E_ blocks, W_ only prompts

`practi new` reports two different kinds of message. They are not the same thing, and confusing them loses work in both directions:

| | `E_*` | `W_*` |
|---|---|---|
| Meaning | a validation invariant is violated | the writing looks thin, but is *legal* |
| Effect | the tree is **stored but NOT registered** — the pop does not exist in the directory, and the command exits 1 | the pop **is registered as direct** and the command exits 0 |
| What to do | fix the JSON and re-run — this is a hard stop | keep the recording, then go back and fill in content when you can |

So: **`W_*` are prompts, not errors — seeing one means "go back and add the missing content", never "this failed"**. Do not retry a `practi new` that only printed `W_*`: it already succeeded. The codes are `W_THIN_CONTENT` (near-empty action with no attachments), `W_NO_VERIFY` (an action with no `outputs`), `W_FLAT_TREE` (many steps, none grouped), `W_DEEP_TREE`, `W_DUP_NAME`, `W_VAGUE_NAME`, `W_DESC_MISSING` (a practice root with no `description` — the field search leans on most). The thresholds are the CLI's own calibration, not protocol (pop-spec §6); treat them as a nudge, not a rule.

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
practi claim <hash>          # register an existing stored node as a direct pop (indirect → direct)
practi unclaim <hash>        # take a referenced direct pop back to indirect; fails when
                               # unreferenced (that would orphan it — delete with remove instead)
practi show <hash>           # aggregate view; --json machine view (steps carry content —
                               # the one-read reproduction view); --doc full document form
practi similar <hash>        # content neighbours: "what else is about this?" — literal
                               # (character-bigram) similarity, not semantics
practi ls [-a]               # direct roots; -a adds indirect nodes
practi search <q> [--notes] [--semantic]
                             # offline search over EVERY stored node — name / description /
                             # content / declared inputs+outputs / loop prose (+ notes)
practi embed status|pull|build|prune  # optional vector model behind search --semantic
practi lint [--json]        # audit W_* recording-quality hints across the whole workspace
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
- **Missing nodes are reported, never hidden**: if a referenced node file is absent from the workspace, `show` still renders the view (placeholders where the missing subtree belongs), `--doc` exports the dangling pin verbatim, and the command exits 1 with an `E_MISSING` block naming each missing hash and its referencing parent. Creation/editing, by contrast, refuses dangling pins outright (`E_DANGLING`).

## Finding things again

`practi search` matches **every stored node** — direct roots, indirect steps, nodes wired only through an `inputs.from`, and orphans — across `name`, `description`, `content`, declared `inputs`/`outputs` (so "which step produces boiling water" works), and loop prose. What to know before concluding "I never recorded that":

- **Multiple words are ANDed, and may match in different fields.** `practi search listary 编码` needs both words somewhere in the same node — not adjacent in the text. Quote a phrase to require it whole.
- **`field:value` scopes one word** — `name:`, `desc:`, `content:`, `flow:` (declared inputs/outputs), `loop:`, `op:`, `hash:`. `practi search name:yt-dlp` hits only nodes whose *name* says it.
- **Chinese is matched by character bigram, not by word** — no dictionary needed. A query word matches only when *all* of its bigrams are present, so word order matters; when strict matching finds nothing the command retries with a strict-majority-of-terms rule and labels every row `partial match`. **A partial-match row is a hint, not an answer** — never present one as the found practice without reading it.
- **A literal search is not a semantic one, and that is deliberate.** Measured on this corpus: queries that share no wording with the record (「科学上网」 for a 翻墙/节点 practice) return *nothing*, and every attempt to fake semantics locally returned confident nonsense instead. So when `practi search` reports no matches, it prints the next move — retry with `--notes`, try `--semantic` if the vector model is installed, start from a node you already have with `practi similar`, or browse with `practi ls`. Take that step instead of rephrasing the same query repeatedly.
- **`--notes` also searches your local notes** (off by default, so the plain result set stays stable). Notes are where the most conversational keywords end up — when a search comes up empty, retry it with `--notes` before giving up.
- **Results are ranked title-first and each says why it matched** (`← name, description`). Trust the explanation over the number.
- **`practi similar <hash>` answers the other question** — not "where did I write X" but "what else is about X". It compares the node's whole subtree (a practice root is often one line; the steps hold the substance) and lists the shared terms that carried each hit. It is literal: a paraphrase sharing no wording will not surface. Use it to find sibling practices and near-duplicate recordings.

## Semantic recall (optional, off by default)

Literal search cannot find a paraphrase (measured: queries sharing no wording with the record return nothing — see the bullet above). When that matters, practi can add a real vector layer. It is **optional and never automatic**:

```bash
practi embed pull          # download the model once (~24MB int8 ONNX) into <data-dir>/models/
practi embed build         # embed every stored node (incremental: only new hashes are embedded)
practi embed status        # is the model present? how many nodes are covered?
practi search <q> --semantic   # fuse vector recall with the lexical ranking (RRF)
```

- **Nothing here is required.** Without a model `practi search` is lexical-only; `--semantic` then prints `--semantic ignored: …` on stderr and answers from the lexical index anyway. Missing capability is always announced, never a silent drop in recall.
- **Known-good expectation, not a promise.** Measured on a 772-node corpus, `--semantic` recovered **4 of 9** paraphrase queries that lexical search got 0 of 9 — real but partial. It never *hurts* exact-term queries (RRF only adds), and it does not make bad queries good.
- **It costs one build.** ~20s for 772 nodes; after that only new nodes are embedded, so day-to-day use is incremental.
- **Swapping the model recomputes everything by itself**: vectors are cached per model fingerprint (`vectors/<fingerprint>.pvec`), so a different model is a different bucket — no migration, and stale vectors can never be mistaken for current ones. `practi embed prune` drops the old buckets.
- Model bytes and vectors live in the data dir as sidecars; they are **derived**, never written into a node and never part of a hash. The protocol reserves semantic ranking for the hub (pop-spec §9.1), so this local layer is deliberately non-normative.
- **The vector layer can never break a command.** `practi search` without `--semantic` does not touch it at all; `--semantic` degrades to lexical with the reason on stderr if the model, the index, or the optional `onnxruntime-node` runtime is missing or broken; `practi new`/`edit` keep an *already enabled* index fresh and stay silent otherwise. Only `practi embed pull|build` — explicit requests — fail loudly.
- **You rarely need `embed build` by hand**: once the model is pulled and an index exists, `practi new`/`edit` top it up with just the new nodes (~25ms each) and say nothing on success. Run `build` when the workspace says it is too far behind; `embed prune` drops buckets left by an older model.

## Recording quality audit

```bash
practi lint [--json] [--limit N]
```

`practi new` prints its `W_*` hints once, at creation. `practi lint` runs the same checks (same code, no second standard) across **every** direct pop, aggregates them by code, and ranks the worst nodes first — so the debt skipped at creation time stays visible instead of quietly accumulating. Read-only, and always exits 0: a to-do list, not a gate.

## Local notes

```bash
practi note add <hash> -m "<text>"       # pin a learning note to any node (hash prefix OK)
practi note list [hash]                  # all notes grouped by document; with a hash: that subtree only
practi note edit <note-id> -m "<text>"   # 8-hex id, unique prefix works
practi note delete <note-id>
practi note promote <note-id> [--out f]  # a note → a draft document of its owning direct root
```

- Notes are **local** — a `notes.json` sidecar. A note is your learning/reproduction experience: what actually worked, where you deviated, dead ends.
- A note pins to **any** node hash, not just document roots — annotate the exact step that taught you something. Content addressing makes the pin exact: a note always refers to precisely this version of the content, and edits that replace a node leave the old note in place (kept, listed last as dangling).
- `--json` prints a flat machine list (no grouping); human output groups by owning document, newest document first. `practi web` renders and edits the viewed document's notes in a right-hand panel — same file, same data as the CLI.
- **A note is not a dead end.** `practi note promote <note-id>` drafts the owning direct root's document with the note's text spliced in at the node it was pinned to, so `practi edit <root> draft.json` folds the lesson back into the practice it came from. It writes a draft and stops — **it never edits for you** (under content addressing an edit is a new hash, and that is the user's call). When the pinned version is gone it fails with `E_NOTE_DANGLING` rather than guessing a successor.

## Skill ⇄ POP conversion

```bash
practi skill export <ref> [--dir <out>]  # a POP → an installable skill directory (default: ./<name>)
practi skill import <dir>                # replay a `practi skill export` directory back into a POP
```

- An exported directory carries `SKILL.md` (a readable projection), attachment files, and `pop.doc.json` — the sidecar holding the canonical document. Import replays the sidecar byte-identically (same hash, any machine), re-staging attachment files into the local blob store.
- Import refuses directories without a sidecar (`E_NO_SIDECAR`): it is the inverse of export, not a skill importer. To bring a foreign skill into POP, read it and **author** a structured tree of practices and actions (the recording-quality rules apply) — flattening its text into one node would discard exactly the structure POP exists for.
- Hand-editing `SKILL.md` after export desynchronizes the sidecar: import warns and treats the edited body as truth (a new hash — fork semantics). Edit the POP and re-export instead.

## Error codes

`E_*` refuse a document (stored but **not registered**). `W_*` never do — see "Recording quality" above.

| Code | Trigger |
|---|---|
| `E_SCHEMA` | shape violation: unknown field anywhere, derived fields on a practice, op/children/loop on an action, duplicate attachment names, unresolvable `@label` |
| `E_DANGLING` | a `{hash}` child not stored locally |
| `E_FLOW_FROM` | `from` names no node in scope |
| `E_HASH_FORMAT` | not `sha256:` + 64 lowercase hex |
| `E_MEDIA_REF` | inline media reference with no matching attachment |
| `E_BLOB_MISSING` / `E_BLOB_CORRUPT` | blob absent / bytes disagree with the pointer |
| `E_NOTE_DANGLING` | `note promote` on a note whose pinned version left the workspace |
| `W_*` | advisory quality hints (`W_THIN_CONTENT`, `W_NO_VERIFY`, `W_FLAT_TREE`, `W_DEEP_TREE`, `W_DUP_NAME`, `W_VAGUE_NAME`, `W_DESC_MISSING`) — **the document is valid and registered** |

## Workflow quick reference

- **Record a session** — extract what was done from the conversation → shape one JSON tree (quality rules above) → `practi new doc.json` → confirm `status: valid, registered as direct` → replace any `W_*` prompts you can → `practi show <hash>` to review.
- **Find prior art** — `practi search <query>` (add `--notes`; use `field:` when you know which field it was in) → `practi show <hash>`. When you cannot recall any wording, start from a node you *do* have and run `practi similar <hash>`.
- **Learn from a practice** — reproduce it, then pin what you learned to the step that taught it: `practi note add <node-hash> -m "…"` (notes stay local). Later, `practi note promote <note-id>` turns that note back into a draft of the practice it belongs to, so the lesson does not rot in the sidecar.
- **Organize under a set** — a `set` op document is a directory: it pins episodes as `{ hash }` children (episodes live once, as indirect nodes). To move standalone POPs under a set, edit the set to reference them, then `practi unclaim` each — unclaim fails with `E_NOT_REFERENCED` if nothing references the node (that would orphan it; `practi remove` is the delete path). `practi claim <hash>` registers any stored node back as direct.
- **Edit one of your direct POPs** — `practi show <hash> --doc > doc.json` → edit the JSON → `practi edit <hash> doc.json --message "what changed"`. The edit validates and stores the new tree, swaps the direct root, appends a revision (`from` = old root — a history pointer, may dangle by design), and garbage-collects nodes no longer reachable from any direct POP (reachability follows children pins and `inputs.from` references alike; `--keep` preserves them; blobs stay put — `practi gc` sweeps orphaned ones on demand). Editing is replacing — new content lives under a new root hash. Improving an indirect practice is a new document with `refines` set, via `practi new`.
