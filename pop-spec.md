# POP — Protocol of Practice

> This document normatively defines POP. Versioning, tooling and history: see the [README](README.md).

## 1. Writing POP

A practice is a tree. Leaves are **actions** — atomic steps. Interior nodes are **practices** — compositions.

**Every document reads as a skill**: an action is an atomic skill; a practice is a compositional skill (a skill that composes skills). POP is a content-addressed superset of the skill ecosystem — any skill maps losslessly **into** a document (name → `name`, description → `description`, body → `content`, files → `attachments`); the reverse direction is a **projection**: flow wiring, op composition and revisions have no skill-side serialization, so a document read as a skill is a view of it, not a lossless encoding.

```
Practice := Action | Op(Practice...)
Op ∈ { seq, par, choice, loop, set }
```

You write one JSON document. Everything except `name` is optional:

```json
{
  "name": "Make tea",
  "description": "From kettle to cup",
  "children": [
    { "name": "Boil water", "content": "Heat until boiling.",
      "outputs": [{ "name": "boiling water", "spec": "100°C" }] },
    { "name": "Pour", "content": "Pour along the wall." }
  ]
}
```

Nodes carry no ids — a node's content hash is its only address (§3). `name` is display text, not an address; renaming a node changes its hash like any other content change. Wiring that needs an address (a ChildRef, an inputs.from) uses the referenced node's hash:

```json
{ "name": "Pour",
  "inputs": [{ "name": "boiling water", "from": "sha256:<hash of the Boil water node>" }] }
```

Rules:

1. **Type by inference**: `children` present → practice, absent → action (explicit `type` must match the inference)
2. **Defaults**: `op` → `"seq"`; `content` → `""`. Optional fields are never materialized, and **empty ≡ absent**: an optional field set to an empty array, or to an empty/whitespace-only string, is treated exactly like the absent field — for the hash (§3.2) and for the canonical form (§9). This applies to fields that are **legal for the node type**; the derived-view fields (`attachments`/`inputs`/`outputs`) on a practice are rejected regardless of value (§2.3)
3. **children inline recursively** — a child is a full same-shaped object; one JSON = one tree. A child may also be a **ChildRef** (`{ hash }`, §2.3) — a reference to an already-stored POP, resolved by the importing implementation into a full subtree at store time (§9). Inline and ChildRef are interchangeable: both contribute the child's own hash to the parent (§3.2), so the two forms produce the same root hash. The same child hash may appear more than once (**twins** are legal — content sharing has no identity cost)
4. **`from`** carries the producing node's hash — any node of this document, or any node of the importing node library (§4). Document form also accepts `"@<name>"` — authoring sugar: the importer resolves the label against this document's **inline** nodes of that name and stores the hash instead (resolution failures are `E_SCHEMA`, §6; twins share a hash and resolve unambiguously). The stored form always carries hashes
5. **`revisions` / `refines` travel with the document**; pointers to nodes outside the document are preserved verbatim (dangling tolerated). **Full round-trip fidelity** is a hard requirement: any subtree exported as a document and re-imported elsewhere keeps every field, with hash byte-identical

Principles, binding for every implementation:

- **A document format, not a workflow engine.** No runtime, no evaluation. Anything requiring judgment (until-predicates, material specs, flow matching) is human-readable text; judgment rests with a person or an agent.
- **Identity is content, and a reference is content too** (§3). A ChildRef or `from` pins a hash; the addressed content is immutable, so a reference can never go stale *while its target is stored* — and **referencing is claiming** (§9.1): a live document's references keep the addressed content stored. Editing a node produces a *new* node under a new hash, and old references keep addressing the old content (the git model; there is no drift and no repinning)
- **Nominal matching, no inference.** `inputs.from` names the producing node's hash; alignment is by flow name, with no type algebra.
- **Prose before fields.** Anything that needs no machine semantics belongs in `content` (waiting times, acceptance prose, context). A field exists only when structure earns its place — keep the writing surface minimal.
- **Evolution adds optional fields.** Absent fields do not participate in hashing, so existing identities never change without cause (§8).

## 2. Node model

### 2.1 ActionNode (leaf)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | `"action"` | yes | |
| `name` | string | yes | Human-readable label (**display text**; it is content — renaming changes the node's hash like any edit) |
| `description` | string | no | One-line description — what the skill does, for discovery/selection |
| `content` | string | yes (defaults to `""` in document form) | Body: details, narrative |
| `license` | string | no | Reuse terms — a license name or a bundled license file reference; empty ≡ absent |
| `metadata` | `{ [k: string]: JSON value }` | no | Extension bag: vendor-specific properties; keys should be `x-<vendor>-<name>`; values are arbitrary JSON participating in the hash as-is; empty ≡ absent |
| `attachments` | `Attachment[]` | no | Blob pointers (§5); empty array ≡ absent |
| `inputs` | `FlowItem[]` | no | Consumed flows — **need vs wiring**: `name`+`spec` declare the need (any producer satisfying them qualifies); `from` optionally wires *this* composition to one specific producer (`"@name"` sugar, §1 rule 4) |
| `outputs` | `FlowItem[]` | no | Produced flows — **the step's acceptance criteria**: a step is successful when its declared outputs are produced (`from` not allowed) |
| `revisions` | `Revision[]` | no | Revision history |

### 2.2 Compound types

```ts
FlowItem   = { name: string; spec?: string; from?: string }    // from: inputs only; a node hash (or an "@name" label —
                                                               // document-form authoring sugar, §1 rule 4). When present
                                                               // it must name an existing node, else E_FLOW_FROM (§6).
                                                               // ABSENT means the need is unwired: the item is prepared
                                                               // externally, or supplied by any producer meeting name+spec.
Revision   = { when: string; what: string; from?: string; trigger?: string }
              // from = pre-revision content hash (history chain); trigger = node hash that caused
              // the revision. Both are history pointers, not containment edges: may dangle, never validated.
LoopConfig = { mode: "count"; count: integer ≥1 } | { mode: "until"; until: string }
              // until is a natural-language predicate, never evaluated
Attachment = { name: string; hash: string; mime?: string; size?: integer ≥0; url?: http(s) URL }   // §5: url is an external fetch path, does not participate in the hash
```

### 2.3 PracticeNode (composition)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` / `name` / `description` / `content` / `license` / `metadata` / `revisions` | as action | | |
| `op` | `Op` | yes (defaults to `"seq"` in document form) | Composition operator |
| `children` | `ChildRef[]` | yes, ≥1 | Containment pins |
| `loop` | `LoopConfig` | no | Only with op=loop |
| `refines` | string | no | The action this practice refines, by hash — the refinement graph's **successor edge**: an improved version points at the hash it improves. Optional, may dangle; hubs index these edges (§9.1) |

```ts
ChildRef = { hash: string }   // the referenced POP's root hash — legal as a children entry in
                               // any form; resolved by the implementation into a full subtree at
                               // store/import time (§4.2, §9). Not stored (here / on the hub)
                               // → E_DANGLING.
```

Constraints:

- `attachments` / `inputs` / `outputs` are **leaf-only**; on a practice they are a schema error (they are derived aggregate views, §7)
- `loop` config only on op=loop. Per-iteration semantics are descriptive: count marks repetition ×N, until marks an open predicate — never evaluated, totals never invented
- A node library may form a DAG; a document may repeat a child hash (twins, §1 rule 3); containment cycles are structurally impossible (§4.1)

## 3. Identity: content hash

### 3.1 Canonical serialization

The hash input is not arbitrary JSON — it is the canonical string:

```
stableStringify(v):
  null    → "null"
  array   → "[" + elements stableStringified, joined by "," + "]"
  object  → drop keys whose value is undefined → sort remaining keys by Unicode code point
            (≡ UTF-8 byte order; sort the RAW key then JSON-escape — beware JavaScript's
            default sort, which compares UTF-16 code units and deviates for emoji)
            → "{" + per key JSON.stringify(k) + ":" + stableStringify(v), joined by "," + "}"
  other   → JSON.stringify(v)    (undefined never occurs in canonical input; if encountered, serialize as null)
```

Example: `{b:1, a:undefined, c:[2, {d:null}]}` → `{"b":1,"c":[2,{"d":null}]}`

### 3.2 Node hash

```
hash(node) = "sha256:" + hex(sha256(stableStringify(payload)))

payload:
  {
    type, name,
    content: trim(content),          // the only rewritten field: leading/trailing whitespace stripped
    description? — if present and non-empty
    license?     — if present and non-empty
    metadata?    — if present and non-empty (values participate as-is)
    revisions?   — included if present and non-empty (whole, incl. from/trigger)
    action:
      attachments?                   — if present and non-empty; each pointer contributes name/hash/mime/size only — url (§5) is stripped and does not participate
      inputs? / outputs?             — if present and non-empty
    practice:
      op
      children: [ childHash, … ]    // ★ Merkle: each child contributes its OWN node hash —
                                     //   inline and ChildRef forms are interchangeable (§1 rule 3)
      loop? / refines?               — if present (refines: non-empty, §1 rule 2)
  }
```

The payload is always derived from the **canonical node**: §1 defaults apply first — `{name:"r"}` ≡ `{name:"r", type:"action", content:""}`. "If present" in the table means present *after* §1 rule 2 (empty ≡ absent), and the payload constructor applies that rule itself: the hash is a **total function** — a not-yet-normalized node hashes exactly like its canonical form, so implementations never need to pre-normalize.

Invariants (test vectors in Appendix A):

- Key order does not affect the hash (stableStringify)
- Omitted ≡ defaulted: §1 defaults apply before payload construction
- Leading/trailing whitespace of `content` does not affect the hash (trim; the set is ECMAScript trim's — Unicode White_Space plus U+FEFF, not ASCII-only)
- Child order participates (seq is ordered); see §3.4 for the computational model
- Attachment **pointers** participate in the node hash; attachment **bytes** do not (§5). A pointer's `url` does not participate — the url may change without changing identity; verification of url-hosted bytes is by the pointer's `hash` (fetch → recompute sha256 → compare)
- Format is always `sha256:` + 64 lowercase hex digits

### 3.3 Content-addressing semantics

Same hash ⇒ same content (verifiable), **including every descendant** — the hash is a Merkle root over the whole tree. Same hash ⇏ globally unique: forks and copies producing independent storage records of the same content are legal (cf. git). Uniqueness is an upper-layer concern (e.g. per-author working sets).

### 3.4 Computational model (informative)

Hashing a tree is a single bottom-up pass: each node is serialized and hashed once — O(total content), memoizable per node. Editing a node invalidates only that node and its ancestor chain: re-hashing after an edit is O(depth), and verifying that a subtree belongs to a document needs only the subtree plus its ancestor hashes (Merkle granularity, cf. git). A stored node hashes in O(own fields) — children participate as pins, not content. Pins are full-length hashes; truncation would break uniqueness.

## 4. Document form and the node library

The protocol defines one artifact: the **document** — a single JSON tree (§1); its identity is the root hash (§3). Authoring and cross-document reuse happen against a **node library** — an implementation's local collection of nodes, addressable **by content hash** (full hash, or a unique prefix of it — ≥4 hex digits by convention), which may form a DAG. **The node library's storage is implementation-defined and outside this protocol**: files, a database, a remote hub — the spec never assumes a layout. Human-facing names/aliases are tooling concern, outside the protocol; references (children pins, `from`) are hashes, resolved by the implementation against stored content.

### 4.1 Boundaries (violations rejected)

| Boundary | Code | Note |
|---|---|---|
| Dangling ref | `E_DANGLING` | a children pin (or ChildRef) naming a hash absent from the library / not stored on the hub (§9) |

Cycles and identity conflicts are structurally impossible — a cycle would require a SHA-256 fixed point; no runtime checks are needed, and sharing (the same child hash under many parents, or twice in one children list) is legal. A stored node is immutable: editing produces a new hash; a store naming files by hash reconciles the two at load (`E_NODE_CORRUPT`).

### 4.2 The document

| Document (interchange) | |
|---|---|
| children | inline subtrees, or ChildRef references to already-stored POPs (§2.3); the same hash may repeat (twins) |
| Identity | root hash = document identity, over the whole tree (§3.3) |
| Attachment bytes | not in the document (blob channel, §9) |
| Canonical / stored form | the **expanded tree**: ChildRef references are resolved into full subtrees at store time, so a stored/exported document is self-contained |
| External references | `from` may point into the importing node library (§1), resolved by the importing implementation; ChildRef references must resolve against content already stored (here / on the hub, §9) |

## 5. Attachments

Arbitrary files ride along as **content-addressed blobs + in-node pointers** (the git/OCI/IPFS pattern).

- Pointers are **action-only** (photos, screenshots, logs naturally belong to an action); on a practice they are a schema error
- **Pointers hash, bytes don't**: changed bytes → changed blob hash → changed pointer → changed node identity; the tree stays lightweight
- Blob storage layout is implementation-defined (hash semantics are not). An example local layout: `blobs/<first 2 hex of hash>/<64 hex>` — identical content lands once
- Reconciliation: the blob must exist (`E_BLOB_MISSING`); its recomputed hash must match the pointer (`E_BLOB_CORRUPT`, covers declared-size mismatch)
- Removing a pointer never deletes a blob (it may be shared; garbage collection is undefined, deferred)
- Blob size limits are implementation policy, not protocol
- A pointer may carry an optional `url` (http/https): the bytes are hosted **externally** — the hub is not responsible for them and they never enter the blob channel. Identity remains the pointer's `hash`: a consumer fetches the bytes from `url` and recomputes sha256; a mismatch means the url is stale or false. With no `url`, bytes ride the blob channel as above

### 5.1 Inline media references

Action `content` may reference the node's own attachments with the Markdown image syntax; the attachment list doubles as the name→hash address table (bytes always travel via the blob channel):

```
See the technique first:

![pour demo](pour-demo.mp4)

Then pour along the wall.
```

- Syntax `![caption](attachment-name)`; the caption doubles as the figure caption. Images → interleaved rich text; video/audio → the tree is the chaptering (child actions = sections; timestamps stay in prose: "at 3:20 …"). Fenced code blocks are not prose — their contents are never scanned for media syntax
- Resolution is **node-local**: a name resolves only against this node's attachment list, and attachment names must be unique within a node (duplicates → `E_SCHEMA`). Reusing media across nodes means attaching another pointer; blobs deduplicate by content
- **Strict validation**: a referenced name absent from the list → `E_MEDIA_REF`. Markdown title syntax (`![x](name "title")`) is not part of the grammar — a parenthesized target must be either exactly an attachment name, or an http(s) URL; anything else (title syntax included) is `E_MEDIA_REF`. Media dangling is loud: swapping bytes never touches the prose (name indirection); deleting an attachment that is still referenced fails validation
- **External URL references**: `![caption](https://…)` targets an external resource directly, with no attachment-table entry. Resolution is best-effort — a consumer fetches the URL and recomputes sha256 to verify (§5); if the resource cannot be fetched it is simply annotated as unavailable, never a validation error. Scheme matching is case-insensitive (RFC 3986); the rest of the URL is preserved verbatim (host/path case is significant). External links that carry no media intent still belong in `content` as ordinary markdown links
- `content` participates in hashing exactly as before (raw, trimmed) — an inline reference carries no identity; the attachment table does
- Practice `content` is not validated for media references (practices carry no attachment table); a root-level illustration is an overview action child carrying the attachment
- Aggregate rendering: §7 views keep attachment provenance (the originating node's hash) so renderers resolve inline references across the whole tree

## 6. Validation invariants & error codes

| Code | Trigger |
|---|---|
| `E_SCHEMA` | Type/constraint violation (derived fields on a practice; op/children/loop/refines on an action; malformed license/metadata; invalid attachment hash/size; duplicate attachment names in a node; a ChildRef carrying any field beyond `hash`; a from-label naming no inline node of the document, several distinct nodes, or closing a dataflow loop, §1 rule 4; an **unknown field anywhere** — §8: unrecognized fields are rejected, never dropped) |
| `E_DANGLING` | a children pin or ChildRef names a hash absent from the node library / not stored on the hub (§9) |
| `E_FLOW_FROM` | inputs.from carries a hash that names no node in scope (the only flow field validated for dangling) |
| `E_OP` / `E_LOOP` | `E_OP`: an op value outside {seq, par, choice, loop, set}. `E_LOOP`: a loop config that is malformed, or carried on a non-loop op |
| `E_HASH_FORMAT` | Malformed hash (a ChildRef, children pin, or from that is not `sha256:` + 64 lowercase hex, of any JSON type; a document-form from may instead be an `@label`, §1 rule 4) |
| `E_NODE_CORRUPT` | A stored node no longer hashes to its own address (hand-edit/tamper; editing a node produces a new hash — the old address keeps its old content) |
| `E_BLOB_MISSING` / `E_BLOB_CORRUPT` | Blob absent / content or size disagrees with the pointer |
| `E_MEDIA_REF` | Inline media reference names a target absent from the node's attachment list (http(s) URL targets are valid external references and are exempt) |

Never validated (dangling tolerated — history pointers): `refines`, `revisions.from`, `revisions.trigger`.

Codes beyond this table (e.g. `E_AMBIGUOUS`, `E_NOT_FOUND` for hash-prefix addressing) are implementation-local: the node library's storage and addressing are implementation-defined (§4).

A hash-form `from` may name a node that contains an earlier version of the wiring node — existence-checked only; only label resolution detects dataflow cycles (§1 rule 4).

## 7. Aggregation (standard view)

When a practice is read, steps / attachments / flow / **declared inputs & outputs** are **derived** bottom-up from the subtree, never stored. This is the reading protocol — the same tree yields equivalent views in any implementation:

- Dedup keys: attachments `hash+name` (same blob under different names = different uses, kept); declared flows `name+spec+declaring node`
- **Declared flows are first-class view entries**: each action's `inputs` (needs) and `outputs` (productions, the acceptance criteria) ride along with the declaring node's hash — unwired inputs appear too, even though they generate no flow edge
- **Stale-pin annotation (non-normative)**: views and validators *should* annotate a `from` (or child pin) whose target has known refinements — a stored practice whose `refines` names that hash (§9.1). Informational, never a validation error: informing, not forcing (pins keep addressing old content — git semantics)
- op semantics: `seq` concatenates in order; `par` marks steps parallelizable; `choice` marks alternatives; `loop` marks repetition (count ×N, until "repeat until: \<predicate\>"); `set` is a directory view — one entry per direct child, **no recursive aggregation** (aggregating unrelated practices is noise)
- Depth is normalized to the read root: the same subtree read at any granularity yields strictly equivalent views

## 8. Compatibility

- Evolution extends the protocol with optional fields only; absent fields do not participate in hashing, so existing identities are stable
- An implementation that does not recognize a field must reject the document carrying it — silently dropping fields forks hashes — until it is updated
- Skill import maps frontmatter keys into `metadata` **verbatim** (no `x-` prefixing), so independent converters produce identical documents — and identical hashes — for the same skill
- Breaking changes bump the major version; the version policy and history live in the README

## 9. Transport (POP-over-HTTP)

Contract for hub implementations. The reference hub is Practihub; the `pop` CLI in this repo speaks this transport. Paths below are logical; a hub may prefix them (Practihub serves them under `/api/v1`). Public reads are anonymous; writes and private reads require authentication (Practihub uses OAuth 2.1 with PKCE and three scopes: `pop:read`, `pop:create`, `pop:publish` — details are hub policy, not protocol).

| Operation | Semantics |
|---|---|
| `POST /pop` | Store a document (body: §1 JSON). The server parses per §3 and computes the root_hash; **idempotent**: the same root_hash is stored exactly once and returns the existing record (never a second copy, never an overwrite); the uploader claims it as owner (§9.1). Stored documents start non-public |
| `GET /pop/:ref` | Fetch a document; `ref` = a `sha256:`-prefixed root_hash (the hub requires the full hash; unique-prefix resolution is a client-side convenience — the CLI resolves prefixes locally). Published documents are publicly readable, non-public only by their claimers (§9.1) |
| `GET /pop/search?q=&scope=&page=&limit=` | Search documents (index text derived by §7 aggregation, including declared inputs/outputs — the index may exceed §7, e.g. recursing into `set` children, recall first; conventions like `produces:X` / `needs:X` over declared flows keep hub query surfaces interoperable). Both title and content match, **title hits rank first**. `scope`: `public` = published documents only (default); `me` = the caller's direct-claimed documents, any status; `all` = the union — the caller's visible universe. Empty `q` returns the newest documents for the scope. Vector/semantic ranking is a hub-side enhancement, reserved but not part of the contract |
| `GET /pop/mine` | List the caller's direct-claimed documents (any status), newest first |
| `POST /pop/:ref/submit` | Author requests publication: non-public → pending review (visibility stays claimer-only until the hub decides) |
| `POST /pop/:ref/unpublish` | Author withdraws a submission or takes a published document back out of public distribution |
| `DELETE /pop/:ref` | Author delete: removes the caller's direct claim (§9.1 lifecycle) |

Attachment **bytes are not transported**: attachments carry their content hash plus an optional external `url`; blob bytes stay client-side (§5). A hub that does host blobs exposes its own blob endpoints as an extension.

Transport adds, beyond §4.1:

- **Self-containment**: inputs.from may only target nodes inside the document (no external context in transit). A **ChildRef** child (`{ hash }`) is the one allowed external hook: the hub must resolve it against content it already stores — the hash exists → the child is expanded into a full subtree and the canonical tree is stored; the hash is missing → `E_DANGLING` (the child POP must be uploaded first, or the author references already-public content). This preserves self-containment of the *stored* document while letting an author reuse stored content instead of re-inlining it
- **Capability negotiation**: a server that does not support attachments must reject documents containing them (preventing hash forks), not strip the field
- Stored content must be the **canonical tree** (parsed, defaults applied), cross-checkable against node hashes

### 9.1 Ownership & retention (hub recommendations)

Content addressing fixes *what* a document is; a hub additionally decides *who owns it* and *how long it lives*. The protocol does not mandate a layout, but every hosted hub should implement the following — it is what Practihub does, and it keeps hubs interoperable on identity while leaving policy to each hub:

- **One copy per hash.** Storage is content-addressed: identical content (same root_hash) is stored once. A repeated `POST /pop` with the same root_hash is idempotent — it returns the existing record and never creates a second copy. Whether a second uploader is "the same author" plays no role in storage; authorship is handled by ownership (below).
- **Ownership is a claim, not a column.** Do not bake an author onto the document row. Keep a separate claim table (owner → root_hash) so a single document can be owned by many users independently. **Owning a hash is owning the document**: any client that can present the document (i.e., upload it) may claim it — the hash is the deed.
- **Two claim kinds.**
  - `direct` — the uploader's own document: appears in the owner's list and controls **their own claim's** lifecycle (submit for review / withdraw / delete). Each direct claimer acts on their claim; the shared document row dies only at zero claims.
  - `indirect` — a document the owner's `direct` documents reference (an inline child, §4.2). Derived automatically, invisible to the user.
  A user's claim on a hash is at most one; `direct` dominates `indirect`.
- **Children are first-class documents, inline or referenced.** Every child — an inline subtree or a `{ hash }` ChildRef (§2.3) — is stored under its own hash and claimed `indirect` by the uploader. A ChildRef resolves against already-stored content (missing → `E_DANGLING`) and never stores a second copy (content-addressed dedup). A child subtree may reference nodes outside itself (`inputs.from`, §1 rule 4): treat such references as dangling rather than rejecting the child — its identity is its hash, not flow-closure.
- **Refinement indexing.** A stored practice's `refines` edge (improved version → improved-upon hash, §2.3) is indexable: the hub keeps the reverse index (hash → its refinements), so anyone referencing a hash can discover that improvements of it exist. Publishing a refinement is optional — `refines` is a history pointer, never enforced; several refinements of one hash form a candidate list, and ranking belongs to the trust layer, not the protocol. Annotation is advisory and never blocks validation.
- **Lifecycle.** Removing a `direct` claim (author delete; "edit" = delete the old hash's claim + upload the new hash) reclaims the owner's `indirect` claims on the deleted document's children. A document with **no remaining claims may be hard-deleted** — its identity is gone, and a future upload of the same content starts a fresh document. **Referencing is claiming**: as long as any live document references a hash, that hash carries an indirect claim and survives — the claim table is the reference count that guarantees deletion never orphans another user's references; hard delete requires zero claims, direct and indirect alike.
- **Visibility.** Non-public documents are readable by their claimers; publication status is a hub application-layer policy, not part of the protocol (§3.3).
- **Blob retention.** Blob bytes are not transported (§9); they live client-side or at external urls. A hub that chooses to host blobs may let them outlive the documents that reference them; garbage collection is hub policy (§5) — such a hub should not delete a blob while any live document carries a pointer to it.

## Appendix A: Test vectors

Implementations must reproduce every value below. Inputs are canonical node objects (nodes carry no ids); children contribute their **own hashes**, so the vectors are order-dependent — A2 wires `from` to A1's hash, A3 pins A1/A2. Sample data includes the non-ASCII `°` (U+00B0), pinning multi-byte handling. Regenerate with `sdk/scripts/vectors.ts`.

**A1 minimal action**

```json
{ "type": "action", "name": "Boil water", "content": "Heat until boiling." }
```

```
hash = sha256:f461f429ee82f6a3298aaac20adbfbec1c4d7c3aaf181dc24e653eaab75c3377
```

**A2 full-field action** (description + license + metadata + inputs + outputs; `from` = A1's hash)

```json
{ "type": "action", "name": "Pour", "description": "Fill the cup",
  "content": "Pour along the wall to 70% full.",
  "license": "CC-BY-4.0",
  "metadata": { "x-demo": "teapot" },
  "inputs": [{ "name": "hot water", "from": "sha256:f461f429ee82f6a3298aaac20adbfbec1c4d7c3aaf181dc24e653eaab75c3377" }],
  "outputs": [{ "name": "cup of tea", "spec": "85°C" }] }
```

```
hash = sha256:7846bcba677a1585219647dfe6ba137cdaa9b4335a7b25c6991580e19ffe233f
```

**A3 practice pinning A1 and A2** (children contribute their own hashes)

```json
{ "type": "practice", "name": "Make tea", "content": "", "op": "seq",
  "children": [ { "hash": "sha256:f461f429ee82f6a3298aaac20adbfbec1c4d7c3aaf181dc24e653eaab75c3377" },
                { "hash": "sha256:7846bcba677a1585219647dfe6ba137cdaa9b4335a7b25c6991580e19ffe233f" } ] }
```

```
hash = sha256:95d4872db873283352020393a00381bfda021038ac701a107c33be8cab571d3a
```

**A4 equivalence**: adding leading/trailing whitespace to A1's `content` leaves the hash unchanged (trim rule)

**A5 blob vector**: the bytes `photo-bytes` (UTF-8, 11 bytes)

```
blob hash = sha256:dac6f451810bc38390a3b6e278d686b332a77cf21b2ea95145ad73722b77035d
```

**A6 stableStringify**: `{b:1, a:undefined, c:[2,{d:null}]}` → `{"b":1,"c":[2,{"d":null}]}`

**A7 ChildRef ↔ inline interchangeability**: the A3 practice written with A1/A2 **inlined** instead of ChildRefs hashes identically — both forms contribute the same child hashes (§3.2), so they are interchangeable.

```json
{ "type": "practice", "name": "Make tea", "content": "", "op": "seq",
  "children": [
    { "type": "action", "name": "Boil water", "content": "Heat until boiling." },
    { "type": "action", "name": "Pour", "description": "Fill the cup",
      "content": "Pour along the wall to 70% full.", "license": "CC-BY-4.0",
      "metadata": { "x-demo": "teapot" },
      "inputs": [{ "name": "hot water", "from": "sha256:f461f429ee82f6a3298aaac20adbfbec1c4d7c3aaf181dc24e653eaab75c3377" }],
      "outputs": [{ "name": "cup of tea", "spec": "85°C" }] }
  ] }
```

```
hash = sha256:95d4872db873283352020393a00381bfda021038ac701a107c33be8cab571d3a   // identical to A3
```

**A8 Merkle**: A7 with one descendant edited (`content` of Pour → `"Pour along the wall to 80% full."`) hashes differently — the root covers the whole tree (§3.3), so a descendant edit always moves the root hash.

```
hash = sha256:1974200356cf6d553ff2fce2305460c3c20d6f6e46155180070eb0fc5e62488f   // differs from A3/A7
```
