/** Minimal structured validation result (no schema lib; RuntimeRunInput is an internal type). */
export interface ValidationIssue {
  path: string;
  message: string;
}

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ValidationIssue[] };
