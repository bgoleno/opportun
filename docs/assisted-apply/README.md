# Assisted apply

Assisted apply helps you apply to a job on the company's own application system (ATS:
Greenhouse, Lever, Ashby; Workday as a handoff only) without Opportun ever submitting anything.
Opportun saves a copy of the resume you chose, you review everything on one screen, the real
application form opens in your browser, **you press the ATS's own submit button**, and Opportun
records the outcome on the opportunity's timeline and watches for the confirmation.

This folder holds the design. The umbrella issue is
https://github.com/bgoleno/opportun/issues/79.

Numbers such as #79 or #124 in this folder are issues and pull requests in this repository,
https://github.com/bgoleno/opportun, not the retired private tracker.

## Status

**As of 2026-11-02, main at 70289cf.** This goes stale with every merge; the live state is on
https://github.com/bgoleno/opportun/issues/79 and the milestone issues it lists.

- Merged, behind `OPPORTUN_SUBMISSIONS=1` (default off, always off on the demo):
  - M1a, submission records and the draft lifecycle (#124, for #114);
  - the PDF export from the Google Docs resume store, the first part of M1b (#127, for #125);
  - `matchConfirmation`, the pure confirmation-email matcher of M2b, not yet wired into mail
    ingest (#128, for #126).
- Everything else is planned. Nothing of the feature is switched on for users, and M1 alone never
  will be: the flag stays off until M2a is accepted.

## The documents

- [technical-design.md](technical-design.md), Part A: the tech lead's design. The ATS capability
  matrix, the user flow and how NG-3 is enforced in the server, the data model and state machine,
  timeline integration and confirmation matching, the API, security and privacy, testing, and the
  milestones.
- Part B, the UX design (screens, status chips, extension popup states, accessibility, edge
  cases) and its HTML mockups, follows in the next change under #122.

Both were written on 2026-10-27 outside the repository and moved here under #122, with the
references the Tech Lead listed on #79 updated to main at 70289cf.

## Why it works this way

A candidate cannot submit to an ATS through any official route. Greenhouse, Lever and Ashby need
an employer-issued API key to post an application, and no public candidate API was found for
Workday. Replaying an apply form from the server would break requirement C-2, vendor terms and
NG-3, so it is out of scope permanently. Part A, sections 1 and 2, has the evidence.

## Decisions

Decisions 1 to 8 were the open questions in Part A section 10.2; the owner answered them on
2026-10-27 and 2026-10-28 ("go with your recommendations" for 2 to 8).

| #   | Decision                                                                                                                                                                                           | Recorded         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Release in two steps: the tracked handoff first (snapshot, review gate, "I submitted it", timeline, confirmation matching, "no confirmation seen" follow-up), extension prefill only after a spike | 2026-10-27       |
| 2   | The resume file is the Google Doc exported to PDF; Reactive Resume and local files stay manual                                                                                                     | 2026-10-28       |
| 3   | "I submitted it" pre-ticks "Move to Applied"; the user still confirms                                                                                                                              | 2026-10-28       |
| 4   | Prefill ships only for an ATS whose terms check finds nothing prohibiting user-side autofill                                                                                                       | 2026-10-28       |
| 5   | Daily review ceiling: 10 per rolling 24 hours by default, instance ceiling 25, users can only lower it                                                                                             | 2026-10-28       |
| 6   | Re-applying to the same requisition is allowed, with a typed reason                                                                                                                                | 2026-10-28       |
| 7   | Named "Assisted apply" and "Apply on <ATS>", not "Submit to ATS"                                                                                                                                   | 2026-10-28       |
| 8   | Hidden entirely on the demo                                                                                                                                                                        | 2026-10-28       |
| 9   | The review step shows a static "valid until <time>", not a countdown (Part B, for WCAG 2.2.1); Part A's countdown is dropped                                                                       | 2026-11-01, #79  |
| 10  | Opportun's existing server-side Workday reads (job list and job detail on a company's own myworkdayjobs.com host) stay as they are                                                                 | 2026-11-02, #113 |
| 11  | The per-ATS terms check (M0 item 3) is done and reviewed; whether prefill ships for each ATS is still the owner's decision under 4                                                                 | open, #113       |

Design points from reviews, now in Part A:

- A snapshot can be deleted by its owner: the file goes, the fingerprint and title stay, and the
  UI asks first (#115, #117).
- The review screen shows the destination host prominently (#129, recorded on #117).
- Confirmation matching: the sender domain is unauthenticated, so a match on it stays visible and
  undoable; an org-only ATS reference does not confirm on its own (#128, recorded on #119).
- The extension never imitates a human (no simulated typing or pointer events), never touches a
  captcha, and never submits (recorded on #120).
- M1c (#129) drops career-page destinations, so a handoff goes only to a recognised ATS host
  (recorded on #120).

The requirements and decision-log changes (FR-X, a note on NG-3, C-6, ADR-15) land with M2a,
as Part A section 9.1 sets out.

## What was and was not verified (2026-10-27)

- Vendor submission mechanisms were read from official documentation on 2026-10-27; the sources
  are in Part A section 2. Vendor terms were not read then; they were collected for M0 on
  2026-11-02 (#113). Captcha behaviour on hosted forms and prefill into a file input are
  unverified until the M0 spike.
- Repository claims cite files and line numbers as read on 2026-10-27. The references the Tech
  Lead listed on #79 were re-checked on 2026-11-02 against 70289cf; line numbers drift, so search
  for the named symbol.
