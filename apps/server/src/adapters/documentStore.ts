// Where resume documents live (FR-R1, R2, R3).
import { z } from 'zod';
import type { UserCtx } from '../repos/base';

export interface ResumeDocMeta {
  docRef: string;
  title: string;
  /** Null for a store with no external document to link to (local_file, #284). Dead at both
   *  of today's callers either way: routes/resumes.ts's response url is computed fresh from
   *  the stored row (resumeUrl()), never read from here. */
  url: string | null;
}

/** One find/replace suggestion: every exact occurrence of `find` becomes `replace`. */
export interface ResumeEdit {
  find: string;
  replace: string;
}

export const MAX_EDIT_TEXT = 5000;
export const MAX_EDITS = 50;

export const ResumeEditSchema = z.object({
  find: z.string().min(1).max(MAX_EDIT_TEXT),
  replace: z.string().max(MAX_EDIT_TEXT),
}) satisfies z.ZodType<ResumeEdit>;

/**
 * What happened to one edit in a batch (issue #146). 'applied': it changed something.
 * 'already_consumed': its find text existed when the batch started (every edit is checked
 * against that pre-batch snapshot before any of them run) but an earlier edit in this same
 * batch had already replaced every occurrence of it by the time this edit's turn came up, so
 * there was nothing left to change. Not an error -- the earlier edit's change still stands --
 * but it must be reported, not folded into a success count: the person needs to know which
 * specific edit did not land, since they may be about to send the result to an employer.
 */
export const RESUME_EDIT_OUTCOMES = ['applied', 'already_consumed'] as const;
export type ResumeEditOutcome = (typeof RESUME_EDIT_OUTCOMES)[number];

export interface ResumeEditResult {
  index: number;
  outcome: ResumeEditOutcome;
}

/**
 * applyEdits's result. `docRef` is the ref to use from now on: unchanged for a store that
 * mutates its document in place (google_doc, reactive_resume), a new value for one whose
 * written content is immutable per version (local_file, #284) and therefore cannot overwrite
 * the ref it was given. The caller must persist it (the store itself never writes to the
 * `resumes` table): a mutating-in-place store documents that property in the type system by
 * simply returning the same ref it was given, rather than the interface assuming it.
 */
export interface ResumeEditOutcomeResult {
  docRef: string;
  results: ResumeEditResult[];
}

export interface DocumentStore {
  /** Validates access and returns the canonical title. */
  registerExisting(ctx: UserCtx, ref: string): Promise<ResumeDocMeta>;
  /** A new document copied from `baseRef` (drive.files.copy). */
  copyFrom(ctx: UserCtx, baseRef: string, name: string): Promise<ResumeDocMeta>;
  /** The document as plain text, one line per paragraph. */
  readText(ctx: UserCtx, ref: string): Promise<string>;
  /**
   * Applies edits. Called only from an explicit user action (C-4), never from the chat. Every
   * edit's `find` must exist in the document as it stood before any edit in the batch ran, or
   * the whole batch is refused (HttpError 409 edit_target_missing) before anything is written.
   * The per-edit outcomes in the result cover what happened to each edit that passed that
   * check -- see ResumeEditOutcome. See ResumeEditOutcomeResult for `docRef`.
   */
  applyEdits(ctx: UserCtx, ref: string, edits: ResumeEdit[]): Promise<ResumeEditOutcomeResult>;
}
