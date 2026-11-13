# ADR-15: Assisted apply instead of direct ATS submission

- **Status:** Accepted 2026-10-28 (owner decisions on https://github.com/bgoleno/opportun/issues/79).
  Recorded 2026-11-02 with the M2a milestone (https://github.com/bgoleno/opportun/issues/118).
- **Deciders:** the owner, on the Tech Lead's design ([docs/assisted-apply/](../assisted-apply/README.md)).
- **Related:** NG-3 and its clarifying note, FR-X (requirements 5.11), C-2, C-6, NFR-SEC7.

## Context

Users asked for Opportun to "submit to the ATS" for an opportunity they track. The design
([Part A section 2](../assisted-apply/technical-design.md#2-ats-capability-matrix)) read each recognised ATS's documentation:
Greenhouse, Lever, Ashby and Workday. Each one's application-submission API needs a key the
employer issues. A candidate has no such key, and submitting without one would mean driving the
ATS's form from the server, which C-2 (each source's terms and limits) rules out. NG-3 already
says the product never sends an application without the user pressing send.

## Decision

Opportun prepares and records an application; it never transmits one.

- The user chooses a resume. Opportun keeps a snapshot of it and shows the destination, the
  resume, the fields and the answers on one review screen. The user confirms the review, and
  Opportun opens the employer's own posting.
- The user fills and submits the form on the ATS site themselves. A later milestone may let the
  browser extension prefill the form the user is viewing; it never presses submit.
- Back in Opportun, the user records "I submitted it". Opportun then writes:
  - one timeline entry;
  - the resume's submitted record;
  - only on the user's click, the move to Applied.
- A matched confirmation email or a captured confirmation page confirms the application. With no
  confirmation after 3 days, the user gets a next step; nothing is retried or sent.
- One opportunity per action, no batch or list-and-act route, a daily review ceiling, and a typed
  reason to apply again to the same requisition (owner decision 6).
- No employer-issued ATS key is ever requested, stored or used (C-6).

## Consequences

- NG-3 is not weakened: its clarifying note says why assisted apply is within it.
- Every route names exactly one attempt or opportunity, and the route- and job-shape test
  (`apps/server/test/submissionRouteShape.test.ts`) fails on a bulk route or a job kind that
  submits.
- Whether an application was submitted rests on the user's word until evidence arrives. The
  timeline says so ("Basis: you reported submitting this"), and "No confirmation seen" is a next
  step, never a failure.
- The feature is behind `OPPORTUN_SUBMISSIONS` and is never on the demo. It was off unless set to
  `1` until the owner made it on by default (https://github.com/bgoleno/opportun/issues/455): now
  an operator turns it off with `0`.
