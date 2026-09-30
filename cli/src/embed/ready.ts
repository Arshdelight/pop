import { DEFAULT_MODEL, modelFingerprint, modelStatus, type ModelSpec } from './model.js';
import { readVectorIndex } from './cache.js';

/**
 * 「向量层能不能用」的**唯一判定口**。
 *
 * 单独成模块是为了让 cmd/embed（状态展示）、cmd/search（--semantic）与 optional
 * （自动保鲜）共用同一份判定，且不产生循环依赖：判定要同时看模型文件与索引，
 * 而这两件事分别住在 model.ts 与 cache.ts。
 */
export type SemanticReadiness =
  | { ready: true; fingerprint: string }
  | { ready: false; reason: string };

export function semanticReadiness(dataDir: string, spec: ModelSpec = DEFAULT_MODEL): SemanticReadiness {
  const st = modelStatus(dataDir, spec);
  if (!st.present) {
    const why = st.bad.map((b) => `${b.file} ${b.reason}`).join(', ');
    return { ready: false, reason: `model ${spec.id} not ready (${why}) — run \`practi embed pull\`` };
  }
  const fingerprint = modelFingerprint(spec);
  if (readVectorIndex(dataDir, fingerprint) === null) {
    return { ready: false, reason: 'no vector index yet — run `practi embed build`' };
  }
  return { ready: true, fingerprint };
}
