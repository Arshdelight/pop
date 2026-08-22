# POP — Protocol of Practice

A protocol that defines practice knowledge — "how to do a thing" — as open data: publishable, linkable, verifiable, composable.

**Skill-compatible**: every POP document reads as a skill — an action is an atomic skill, a practice is a compositional skill (a skill that composes skills). A skill maps losslessly **into** a document (`name`/`description`/body → `name`/`description`/`content`, files → `attachments`), gaining verifiable identity, linking, and composition in exchange. The reverse direction is a **projection**: a document's flow wiring, op composition and revisions have no skill-side serialization — reading a document as a skill is a view of it, not a lossless encoding.

**The protocol: [`pop-spec.md`](pop-spec.md)** — the sole normative definition, version 1.0.0. The spec covers only the protocol; everything else lives here.

## What's in this repo

```
pop-spec.md              the specification
conformance/             its verification tool
```

**The protocol is just a convention**: writing a practice requires no code — a practice is a JSON document, zero hashes required to start. Any implementer — hub, CLI, desktop app, third-party tool — builds from the spec independently.

## conformance/

A private verification tool, never published and never imported by implementers — the spec must not be eclipsed by an official implementation. It:

1. Generates the Appendix A test vectors and cross-verifies them against the spec text, byte-for-byte
2. Verifies the spec is self-consistent: export/import round-trips, validation invariants, aggregation semantics

```bash
cd conformance
npm test    # vitest (74 cases, incl. Appendix A vector re-verification)
```

## Hosted hubs

The protocol defines the document; a hub decides who owns it and how long it lives. §9.1 of the spec records the ownership & retention contract we recommend every hosted hub implement (Practihub follows it):

- **One copy per hash** — content-addressed dedup; repeated uploads of the same root_hash are idempotent.
- **Ownership is a claim, not a column** — a separate owner→hash table; owning a hash is owning the document; a document can be owned by many users.
- **Direct vs indirect claims** — direct = your own upload (in your list, controls lifecycle); indirect = inline children your direct documents reference (derived, invisible).
- **Inline children are first-class documents** — every child is stored under its own hash and claimed indirectly.
- **ChildRef children reuse stored content** — a document may reference an existing child by hash (`{ hash }`) instead of inlining it; the hub resolves at store time (missing hash → `E_DANGLING`), never stores a second copy, and claims it indirectly. Interchangeable with inline on identity.
- **No claim → hard delete** — deleting a direct claim reclaims its children's indirect claims; a document with no claims may be garbage-collected.

## Evolution

Semver from 1.0.0: evolution adds optional fields where possible (existing identities never drift); breaking changes bump the major version. Every change follows: **update the spec (with new test vectors) → conformance passes → sync implementers**.

## History

- **1.0.0** (2026-08-22) — first release. Nodes carry no ids: the content hash is the only address, and the root hash is a Merkle root over the whole tree (same hash ⇒ same content, descendants included). Children may be inlined or referenced by `{ hash }` — interchangeable on identity. Attachments are content-addressed blobs with optional external urls.
