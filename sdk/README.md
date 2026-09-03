# @arshdelight/pop-sdk

The official SDK for **POP — Protocol of Practice**: the document format that defines practice knowledge ("how to do a thing") as open, verifiable, composable data. A practice is a JSON tree of actions and composed practices; its identity is a Merkle root hash over the whole tree.

This package is the spec-verified implementation of the protocol: parsing, content-addressed hashing, validation, storage and aggregate views. The [spec](https://github.com/Arshdelight/pop/blob/main/pop-spec.md) is the sole normative definition — the SDK's test suite re-verifies the Appendix A vectors byte-for-byte.

## Install

```bash
npm install @arshdelight/pop-sdk
```

## Quick start

```ts
import { initWorkspace, loadWorkspace, createFromDoc, aggregateView, validateWorkspace } from '@arshdelight/pop-sdk';

// a data directory is a content-addressed workspace
initWorkspace('./practice');

// import a document (a JSON tree) — validates, persists every node under its own hash
const ws = loadWorkspace('./practice');
const { root } = createFromDoc(ws, {
  type: 'practice',
  name: 'Brew a pour-over coffee',
  content: 'Follow the steps to get a clean, balanced cup.',
  op: 'seq',
  children: [
    { type: 'action', name: 'Grind the beans', content: 'Medium-fine, 15g.' },
    { type: 'action', name: 'Pour and bloom', content: '50g water, wait 30s, then to 250g.' },
  ],
});

// the standard view: steps, attachments, flow, declared inputs/outputs — derived, never stored
const view = aggregateView(root, loadWorkspace('./practice').nodes);
console.log(view.steps);

// structural invariants: dangling refs, media refs, blob integrity
console.log(validateWorkspace(loadWorkspace('./practice')));
```

## Attachments

Media (images, files, video) ride along as content-addressed blobs with in-node pointers. The node hash uses the attachment hash — identity is bound to the bytes, not to where they are hosted.

```json
{
  "type": "action",
  "name": "Demonstrate",
  "content": "Here is the result:\n\n![pour demo](pour-demo)",
  "attachments": [
    { "name": "pour-demo", "hash": "sha256:ab12…", "mime": "video/mp4",
      "url": "https://practihub.com/pop/blobs/sha256:ab12…" }
  ]
}
```

- Content references media with the Markdown image syntax `![caption](attachment-name)` (spec §5.1) — the target is the attachment **name**, resolved node-locally against this node's attachment list.
- The pointer's `hash` participates in the node hash; `url` does not — you may rehost or change the url without changing identity, and verification is by hash (fetch → recompute sha256 → compare).
- With no `url`, bytes travel the local blob channel (`storeBlob` / `readBlob`); blob layout `blobs/<first 2 hex>/<64 hex>`.
- A raw http(s) URL target in content is **not** valid grammar (v1.1.0) — `E_MEDIA_REF` like any other non-name target; external bytes are mutable and unauditable. Use an attachment, or a plain markdown link when no media is intended.

## API surface

- **Parsing & hashing** — `computeNodeHash`, `stableStringify`, `parseDocument` (pure import: validate + build + hashes, no persistence — for transports with their own store), `createFromDoc` (document → content-addressed tree, `@name` labels resolved)
- **Storage** — `initWorkspace`, `loadWorkspace`, `saveNode`, `storeBlob`, `resolveNodeRef` (full hash or unique prefix)
- **Views** — `aggregateView` (steps / attachments / flow / declared inputs + outputs)
- **Validation** — `validateWorkspace`, `upgradeStatus` (refinement graph, advisory)
- **Export** — `exportSubtree` (any subtree lifted out is a legal document)

All errors are `PracticeError` with a stable `code` (`E_SCHEMA`, `E_DANGLING`, `E_HASH_FORMAT`, …) and optional `hint` / `line`.

## License

MIT © 2026 arsh tech
