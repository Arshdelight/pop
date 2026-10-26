---
name: use-practi
description: Record, version, search, and manage practices with the practi
  CLI — each practice is a self-contained folder whose pop is a plain JSON
  document you edit with any editor, with full local history beside it (like
  .git) and optional practihub sync. Use whenever the user wants to save what
  was just done as a reusable practice ("record this practice", "save this
  session", "turn this into steps"), version or rewrite one ("commit this",
  "amend", "revert to v1", "squash my history"), search or read practices
  ("search my practices", "find a how-to I saved", "what else is about this"),
  annotate learning ("take a note on this step", "note what I learned while
  reproducing"), or sync with the hub ("publish this practice", "clone my
  practices") — even when practi is not mentioned by name. Also for any
  explicit practi CLI usage (practi new, practi commit, practi log, practi
  show, practi search, practi export, practi note, practi skill export, …),
  and for converting between formats ("turn this skill into a POP", "export
  this practice as a skill").
---

One JSON document = one practice tree. Leaves are **actions** — atomic skills; interior nodes are **practices** — compositions. Everything except `name` is optional, and type is inferred: a node with `children` is a practice, one without is an action.

Three principles hold everywhere:

- **Identity is content.** A node's SHA-256 hash is its only address; the root hash is a Merkle root over the whole tree. Editing a node produces a new hash — nothing is edited in place (the git model). `name` is display text, not an id: renaming changes the hash like any edit.
- **A document format, not a workflow engine.** Nothing executes. Judgment — waiting times, acceptance prose, loop predicates — stays in human-readable text.
- **Prose before fields.** What needs no machine semantics belongs in `content`; a field exists only when structure earns its place.

**A practice is a self-contained folder** (2026-10-20 model):

```
green-tea/
  green-tea.json      the pop — a plain document, edit it with any editor
  .practi/            the history (like .git): chain.json (commits {seq, root,
                      parent, message} + branch pointers), nodes/ (every revision,
                      content-addressed), blobs/ (attachment bytes), notes.json
```

The config home (default `~/.practi`) only holds credentials and the remote — `practi.json` (remote) and `practi.auth.json` (OAuth). Practices themselves are plain folders, wherever you keep your documents; deleting a folder deletes the practice (the hub copy stays).

## Setup

```bash
npm install -g @arshdelight/practi
practi init          # create the config home (credentials + remote)
practi config        # show config home and remote
```

The local workflow is fully offline. Optionally a practice syncs with practihub (the reference hub) — see **Hub workflow** below.

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
| `license` / `metadata` | both | reuse terms / vendor bag (`x-<vendor>-<name>` keys) |

Documents carry **no history fields**: a document is a pure content snapshot. Revisions live in the repository layer (`.practi/chain.json` locally, the hub instance's commit chain remotely), and "this practice improves that one" is instance metadata (`refines`, §9.1) — never document fields. Documents carrying the POP 1.x `revisions`/`refines` fields are rejected (`E_SCHEMA`); migrate them with `practi fix <file.json>` (`--dry-run` previews, the new hash is reported).

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
- Export (`export`, `show --doc`, `skill export`) rewrites an in-subtree from pin as its `@name` label when the name is unambiguous — editing the referenced child then re-resolves by name on import instead of dangling on the old hash. Out-of-subtree or same-name-ambiguous pins export verbatim.
- Children may inline recursively or reference stored content as `{ "hash": "sha256:…" }` — both forms produce the same root hash.

## Recording quality

Check every document against these before committing it:

- **Detailed** — someone who wasn't here can reproduce it: exact commands, file changes, config values, concrete specs. Record what was actually done — dead ends included — not the idealized version.
- **Sanitized** — remove values specific to the author that a reproducer won't reuse: own repos, accounts, usernames, addresses, phones, credentials, personal hostnames/IPs — even embedded in commands, and even inside attachment bytes (screenshots, logs). Replace with descriptive placeholders (`<your-github-username>/repo`). Keep third-party package names, public endpoints, standard tools, and command structure.
- **Curated** — a child step is something a reproducer physically does. Research and deciding are not steps; their conclusions go in `content`. Test: *would a reproducer physically do this, or only need its conclusion?*
- **Bounded** — one document is one thing a reproducer pulls up and follows end-to-end for a single trigger. Sessions are time units; practices are structural ones — "record a session" means extracting the *practices* the session produced (zero, one, or several documents). Split when the parts would be invoked by different triggers or share few or no steps; if what remains has 1–2 steps and no judgment content, it was an action — don't manufacture a document around it.

### E_ blocks, W_ only prompts

`practi new --base` / `practi commit` report two different kinds of message. They are not the same thing, and confusing them loses work in both directions:

| | `E_*` | `W_*` |
|---|---|---|
| Meaning | a validation invariant is violated | the writing looks thin, but is *legal* |
| Effect | the revision is **refused** — `new --base` rejects without leaving a half-born folder, `commit` rolls the chain back; exit 1 | the revision **is committed** and the command exits 0 |
| What to do | fix the JSON and re-run — this is a hard stop | keep the recording, then go back and fill in content when you can |

So: **`W_*` are prompts, not errors — seeing one means "go back and add the missing content", never "this failed"**. Do not retry a commit that only printed `W_*`: it already succeeded. The codes are `W_THIN_CONTENT` (near-empty action with no attachments), `W_NO_VERIFY` (an action with no `outputs`), `W_CONTENT_LONG` (a node carrying so much prose — fenced code blocks excluded — that it is probably several steps sharing one node: **split it into child steps, do not trim it**), `W_FLAT_TREE` (many steps, none grouped), `W_DEEP_TREE`, `W_DUP_NAME`, `W_VAGUE_NAME`, `W_DESC_MISSING` (a practice root with no `description` — the field search leans on most). The thresholds are the CLI's own calibration, not protocol (pop-spec §6); treat them as a nudge, not a rule.

## Attachments

Stage the bytes first, then paste the emitted entry into the document:

```bash
practi blob add <file-or-url> [--name <name>]   # inside the practice folder; bytes → .practi/blobs/
```

- **Local file** — hashed and stored into the practice's blob channel; emits the entry without `url`. Validation later reports `E_BLOB_MISSING` if the bytes are absent.
- **http(s) URL** — fetched once (25 MB limit); the bytes are ALSO stored and the entry is emitted **without** `url` (practi pointers are pure hash — the url is just the import channel; spec §5 still allows the field).

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
- Pointers hash, bytes don't: changed bytes → changed blob hash → changed pointer → a new node identity. Attachments are immutable content — the entry goes into the document **before** committing, never mutated onto an existing node.

## The practice workflow (git-style)

```bash
practi new <name> [--base <file.json>] [-m <msg>]   # birth a practice folder in cwd; --base
                                                    # seeds v1 from a pop document (write the
                                                    # JSON with any editor first)
cd <name>
$EDITOR <name>.json            # ...edit the pop with any editor...
practi commit [-m <msg>]        # snapshot the working file as a new revision (local; nothing
                                # to commit when it matches the head; --amend replaces the
                                # head instead — message-only amend rewords)
practi export <hash> [-o f]    # write any revision back out (the current one IS the working
                                # file; export serves old revisions — compare/rollback)
practi log [--branch <b>] [--json]   # commit history, tip first; (local, unpushed) marked
practi lint                    # quality hints on the current branch head
practi show <hash> [--json] [--doc]   # inspect one revision node (hash prefix OK)
practi search <q> [--notes] [--semantic]   # search this practice's revisions
practi similar <hash>          # content neighbours within this practice (literal bigram
                                # similarity, not semantics)
practi note add|list|edit|delete   # learning notes pinned to node hashes (.practi/notes.json)
practi gc [--apply]            # free orphan blobs (dry-run by default)
practi web                     # browse practices locally — inside a practice folder: chain,
                                # branches, per-revision reader (wizard / standard view / doc
                                # tree); anywhere else: the practices home directory page
                                # (default ~/.practi/practices), rows click through to the reader
practi embed status|pull|build|prune   # optional vector model (.practi/models/), scoped to
                                # this practice; without it search is lexical-only
```

- The **working file is the write door**, `export` is the read-back door. `commit` when the file equals the head says `nothing to commit`.
- `practi show` accepts a unique hash prefix (≥4 hex digits); `--doc` emits the expanded document.
- **Reading vs editing**: to follow or reproduce a practice, read the aggregate view (`show`, or `show --json` — steps come with their content, one read is enough); to edit, fork, or reason about the op structure, read `--doc` — the aggregate flattens those by design.
- **History rewriting is local and free** (`practi history`, below). It never touches the working file (git reset semantics): after a rewrite the file may hold pre-rewrite content — commit it to keep, or `export <head> -o <name>.json` to discard. The printed note says which.

## Hub workflow (optional, practihub)

A practice folder maps one-to-one onto a hub **instance** — a single-owner, GitHub-like home for one POP's revision chain, with branches. Everything hub-side needs:

```bash
practi remote set https://practihub.com   # point at the hub (remove falls back to it)
practi login                              # OAuth sign-in (browser consent); --no-open prints the URL
practi me                                 # show the signed-in account and scopes
practi logout                             # revoke + drop stored credentials
```

```bash
practi new <name> --base <file.json> -m "first"   # birth locally; the hub copy is born by
                                                   # the first push
practi push [--force]                     # sync to the hub: first push creates the instance
                                           # there; FF pushes append commits; divergence
                                           # errors — --force overwrites and the hub drops
                                           # unreachable revisions
practi pull                               # fetch missing revisions, fast-forward the branch,
                                           # update the working file (refuses when dirty)
practi clone <owner>/<name>[@branch] [--dir <path>]   # a hub practice → a local folder
                                           # (full chain + working file; git clone)
practi branch [name] [--from <hash>] | -d <name>   # list (* = current) / create / delete
practi switch <branch>                    # switch branches; the working file follows the
                                           # head (refuses when dirty — commit first)
practi merge <branch>                     # fast-forward (pointer move), else a pointer move
                                           # too — same-tree commits are identical (§9.1:
                                           # one row per root); the merge always completes
practi history reword <seq> -m <msg> | squash <seq> | drop <seq> | reset <seq>
                                           # rewrite the local chain; push reconciles —
                                           # divergence needs --force
```

- **The commit is repository state, the document is a snapshot.** History lives in `chain.json` (local) and the hub instance's commit chain (remote) — never in the document.
- **The hub never changes the content.** Pushes are re-hashed server-side with the same SDK; visibility follows the instance (a PUBLIC instance's chain is readable by anyone, PRIVATE only by its owner). Making an instance public is a hub-web workflow, not a CLI one.
- Deleting a practice folder removes the local copy only — the hub instance stays (delete it on the hub web).

## Finding things again

`practi search` matches **every revision node in this practice** across `name`, `description`, `content`, declared `inputs`/`outputs` (so "which step produces boiling water" works), and loop prose. What to know before concluding "I never recorded that":

- **Multiple words are ANDed, and may match in different fields.** `practi search listary 编码` needs both words somewhere in the same node — not adjacent in the text. Quote a phrase to require it whole.
- **`field:value` scopes one word** — `name:`, `desc:`, `content:`, `flow:` (declared inputs/outputs), `loop:`, `op:`, `hash:`. `practi search name:yt-dlp` hits only nodes whose *name* says it.
- **Chinese is matched by character bigram, not by word** — no dictionary needed. A query word matches only when *all* of its bigrams are present, so word order matters; when strict matching finds nothing the command retries with a strict-majority-of-terms rule and labels every row `partial match`. **A partial-match row is a hint, not an answer** — never present one as the found practice without reading it.
- **A literal search is not a semantic one, and that is deliberate.** Queries that share no wording with the record return *nothing*. So when `practi search` reports no matches, it prints the next move — retry with `--notes`, try `--semantic` if the vector model is installed, or start from a node you already have with `practi similar`. Take that step instead of rephrasing the same query repeatedly.
- **`--notes` also searches your local notes** (off by default, so the plain result set stays stable). Notes are where the most conversational keywords end up — when a search comes up empty, retry it with `--notes` before giving up.
- **Results are ranked title-first and each says why it matched.** Trust the explanation over the number.
- **`practi similar <hash>` answers the other question** — not "where did I write X" but "what else is about X". Literal: a paraphrase sharing no wording will not surface.
- Across practices, browse folders in your file manager — a practice folder *is* its own listing.

## Semantic recall (optional, off by default)

Literal search cannot find a paraphrase. When that matters, practi can add a real vector layer, scoped to the practice. It is **optional and never automatic**:

```bash
practi embed pull          # download the model once (~24MB int8 ONNX) into .practi/models/
practi embed build         # embed every stored node (incremental: only new hashes are embedded)
practi embed status        # is the model present? how many nodes are covered?
practi search <q> --semantic   # fuse vector recall with the lexical ranking (RRF)
```

- **Nothing here is required.** Without a model `practi search` is lexical-only; `--semantic` then says what is missing on stderr and answers from the lexical index anyway.
- **It costs one build.** After that only new nodes are embedded, so day-to-day use is incremental. Model bytes and vectors live under `.practi/` as **derived** sidecars — never written into a node, never part of a hash.
- **The vector layer can never break a command.** `--semantic` degrades to lexical with the reason on stderr if anything is missing; only `practi embed pull|build` — explicit requests — fail loudly.

## Local notes

```bash
practi note add <hash> -m "<text>"       # pin a learning note to any node (hash prefix OK)
practi note list [hash]                  # all notes grouped by document; with a hash: that subtree only
practi note edit <note-id> -m "<text>"   # 8-hex id, unique prefix works
practi note delete <note-id>
```

- Notes are **local** — `.practi/notes.json` inside the practice. A note is your learning/reproduction experience: what actually worked, where you deviated, dead ends.
- A note pins to **any** node hash, not just roots — annotate the exact step that taught you something. Content addressing makes the pin exact: a note always refers to precisely this version of the content.
- `--json` prints a flat machine list; human output groups by document. `practi web` renders and edits the viewed document's notes — same file, same data as the CLI.
- **A note is not a dead end**: to fold a lesson back in, `export` the revision (or edit the working file), splice the note's content into the step, and `commit` — an edit is a new hash, and that is the user's call.

## Skill ⇄ POP conversion

```bash
practi skill export <ref> [--dir <out>]  # a revision → an installable skill directory (default: ./<name>)
practi skill import <dir>                # replay a `practi skill export` directory back into the practice
```

- An exported directory carries `SKILL.md` (a readable projection), attachment files, and `pop.doc.json` — the sidecar holding the canonical document. Import replays the sidecar byte-identically (same hash, any machine), re-staging attachment files into the practice's blob store; then `practi commit -m "..."` records it as a revision.
- Import refuses directories without a sidecar (`E_NO_SIDECAR`): it is the inverse of export, not a skill importer. To bring a foreign skill into POP, read it and **author** a structured tree of practices and actions (the recording-quality rules apply).
- Hand-editing `SKILL.md` after export desynchronizes the sidecar: import warns and treats the edited body as truth (a new hash — fork semantics). Edit the document and re-export instead.

## Error codes

`E_*` refuse a revision (born-empty folder on `new --base`, chain rollback on `commit`). `W_*` never do — see "Recording quality" above.

| Code | Trigger |
|---|---|
| `E_SCHEMA` | shape violation: unknown field anywhere, derived fields on a practice, op/children/loop on an action, duplicate attachment names, unresolvable `@label` |
| `E_DANGLING` | a `{hash}` child not stored in this practice |
| `E_FLOW_FROM` | `from` names no node in scope |
| `E_HASH_FORMAT` | not `sha256:` + 64 lowercase hex |
| `E_MEDIA_REF` | inline media reference with no matching attachment |
| `E_BLOB_MISSING` / `E_BLOB_CORRUPT` | blob absent / bytes disagree with the pointer |
| `W_*` | advisory quality hints (`W_THIN_CONTENT`, `W_NO_VERIFY`, `W_CONTENT_LONG`, `W_FLAT_TREE`, `W_DEEP_TREE`, `W_DUP_NAME`, `W_VAGUE_NAME`, `W_DESC_MISSING`) — **the revision is committed** |

## Workflow quick reference

- **Record a session** — extract the *practices* the conversation produced → shape one JSON tree per practice (quality rules above) → `practi new <name> --base doc.json -m "first"` → replace any `W_*` prompts you can (edit the working file, `commit` again) → `practi push` when it should live on the hub.
- **Find prior art** — `cd` into the practice → `practi search <query>` (add `--notes`; `field:` when you know the field) → `practi show <hash>`. No wording recall? `practi similar <hash>` from a node you do have.
- **Learn from a practice** — reproduce it, then pin what you learned: `practi note add <node-hash> -m "…"`. Fold it back by editing the working file and committing.
- **Improve a practice** — edit `<name>.json` → `practi commit -m "what changed"` → `practi push`. Oops: `commit --amend`, `history reset <seq>` (working file kept — keep or discard), or `export <head>` and re-edit. Improving someone else's practice is a new instance on the hub declaring `refines` → the original's root hash (§9.1) — a hub-web action.
- **Reproduce someone's practice** — `practi clone <owner>/<name>` → follow the working file (or `practi web`) → pin notes as you learn.
