/**
 * Public entry of the POP conformance tool (the spec's attached verifier,
 * not a protocol implementation product).
 *
 * Role: generate test vectors for pop-spec.md in the repo root and verify the
 * spec is self-consistent. Never published, never imported by implementers —
 * implementers build from the spec alone (the contract exists independently
 * on both sides).
 */
export * from './model.js';
export * from './hash.js';
export * from './store.js';
export * from './doc.js';
export * from './export.js';
export * from './aggregate.js';
export * from './validate.js';
export * from './errors.js';
