/**
 * Public entry of the POP SDK — the spec-verified implementation of the
 * protocol. Exposes parsing, content-addressed hashing, the workspace store,
 * validation and aggregate views. The spec (pop-spec.md) remains the sole
 * normative definition; this package is verified against it (Appendix A
 * vectors re-checked byte-for-byte by the test suite).
 */
export * from './model.js';
export * from './hash.js';
export * from './store.js';
export * from './doc.js';
export * from './export.js';
export * from './aggregate.js';
export * from './validate.js';
export * from './errors.js';
export * from './version.js';
