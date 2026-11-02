// The review digest of an application submission (assisted apply M1c,
// https://github.com/bgoleno/opportun/issues/116; design Part A 3.4 item 3 and 4.5).
//
// The review binds to the exact state the user saw: who, which opportunity, which resume (and
// its snapshot hash), where the browser will be sent, which requisition, and the fields and
// answers. GET returns the digest of the current state; POST .../review must echo it, and the
// handoff recomputes it and refuses if anything changed since. The echo proves the client
// rendered the state the server holds, not that a human read it (the design's stated limit).
//
// Two deliberate widenings of the design's list (4.5):
// - resumeId as well as resumeSha256. Until the snapshot job lands (the rest of #115) the hash
//   is null, and without the id two different resumes would share a digest.
// - the whole destination URL, not only origin and path: a company career page can carry the
//   posting id in its query (`?gh_jid=...`), and that is exactly what must not change unseen.
//
// The snapshot (#115): resumeSha256 is covered as stored. M1c does not refuse a review for a
// missing snapshot; #115 adds `409 snapshot_pending` together with the job, and must tell a
// snapshot still pending apart from a store that answered export_unsupported (local file,
// Reactive Resume). That one may be reviewed with a null hash, its reason shown (tl on #116).
import { createHash } from 'node:crypto';
import type { SubmissionAnswer, SubmissionFields } from '@opportun/core';
import { canonicalJson } from '../db/copyPlan';

export interface DigestInput {
  userId: string;
  opportunityId: string;
  resumeId: string | null;
  resumeSha256: string | null;
  destinationUrl: string;
  atsKind: string;
  atsExternalId: string;
  fields: SubmissionFields;
  answers: SubmissionAnswer[];
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 of the canonical JSON (keys sorted, no whitespace) of the reviewed state. */
export function submissionDigest(s: DigestInput): string {
  return sha256(
    canonicalJson({
      v: 1,
      userId: s.userId,
      opportunityId: s.opportunityId,
      resumeId: s.resumeId,
      resumeSha256: s.resumeSha256,
      destination: s.destinationUrl,
      atsKind: s.atsKind,
      atsExternalId: s.atsExternalId,
      fieldsHash: sha256(canonicalJson(s.fields)),
      answersHash: sha256(canonicalJson(s.answers)),
    }),
  );
}
