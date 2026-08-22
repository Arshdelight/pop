export class PracticeError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly file?: string;
  /** Error location line (1-based, within the file) */
  readonly line?: number;

  constructor(code: string, message: string, options?: { hint?: string; file?: string; line?: number }) {
    super(message);
    this.name = 'PracticeError';
    this.code = code;
    this.hint = options?.hint;
    this.file = options?.file;
    this.line = options?.line;
  }
}
