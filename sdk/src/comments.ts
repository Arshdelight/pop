/**
 * POP node comments — hub extension contract (2026-08-26).
 *
 * Comments are NOT part of the POP protocol: the spec (pop-spec.md 1.0.1) is
 * untouched, and a hub without comments is fully protocol-compliant. These
 * types describe the hub *extension* endpoints the CLI talks to
 * (`/api/v1/pop/:ref/comments`, `/api/v1/comments/:id`, `/api/v1/comments/:id/report`)
 * — client-side convenience, not protocol obligations.
 *
 * Model: flat comments (no replies), one per (user, node), valence required
 * (default NEUTRAL), free edit, hard delete, publish-then-review (阿里 Green).
 * Design: docs/discussion/2026-08-26-pop-dag-evaluation.md.
 */

export const COMMENT_VALENCES = ['SUPPORT', 'NEUTRAL', 'OPPOSE'] as const;
export type CommentValence = (typeof COMMENT_VALENCES)[number];

export const COMMENT_REPORT_REASONS = ['illegal', 'infringement', 'spam', 'other'] as const;
export type CommentReportReason = (typeof COMMENT_REPORT_REASONS)[number];

export interface PopCommentAuthor {
  id: string;
  username: string | null;
}

export interface PopComment {
  id: string;
  targetHash: string;
  sourceHash: string;
  author: PopCommentAuthor;
  valence: CommentValence;
  body: string;
  reviewStatus: string | null;
  reviewDetail: string | null;
  editedAt: string | null;
  createdAt: string;
}

/** 正反态度分布（展示级聚合；永不成评分、永不进排序键） */
export interface CommentTally {
  SUPPORT: number;
  NEUTRAL: number;
  OPPOSE: number;
  total: number;
}

export interface CommentListResult {
  items: PopComment[];
  tally: CommentTally;
  nextCursor: string | null;
}
