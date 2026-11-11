# Assisted apply

Assisted apply helps you apply to a job on the company's own application system (ATS:
Greenhouse, Lever, Ashby; Workday as a handoff only) without Opportun ever submitting anything.
Opportun saves a copy of the resume you chose, you review everything on one screen, the real
application form opens in your browser, **you press the ATS's own submit button**, and Opportun
records the outcome on the opportunity's timeline and watches for the confirmation.

This folder holds the design. The umbrella issue is
https://github.com/bgoleno/opportun/issues/79.

Numbers such as #79 or #124 in this folder are issues and pull requests in this repository,
https://github.com/bgoleno/opportun.

## Status

**As of 2026-11-03, main at 3a2b3bd.** This goes stale with every merge; the live state is on
https://github.com/bgoleno/opportun/issues/79 and the milestone issues it lists.

- Everything built sits behind `OPPORTUN_SUBMISSIONS=1` (default off, never on for the demo).
- Merged: M1 (records, snapshot, review gate, apply screens), M2 (I submitted it, outcomes, the
  follow-up, confirmation email matching) and M4 (recording the confirmation page).
- Open: M0, the spike (#113, parts of it need the owner's accounts and inbox), and M3, extension
  prefill (#120). The Greenhouse filler is merged; Lever and Ashby are not built.

## The documents

- [technical-design.md](technical-design.md), Part A: the tech lead's design. The ATS capability
  matrix, the user flow and how NG-3 is enforced in the server, the data model and state machine,
  timeline integration and confirmation matching, the API, security and privacy, testing, and the
  milestones.
- [ux-design.md](ux-design.md), Part B: the UX designer's design. The screens, status chips,
  extension popup states, accessibility and edge cases.
- [ux-mockups.html](ux-mockups.html): Part B's mockups, with invented data. Download it and open
  it in a browser.

Both parts were written on 2026-10-27 outside the repository and moved here under #122, with the
references the Tech Lead listed on #79 updated to main at 3a2b3bd. Each part has a section "What
the build changed" that lists where the code departed from the design, checked at 3a2b3bd for Part
A and d97dd45 for Part B; where they differ, the code wins. The mockups show the design, not the
screens as built.

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
| 4   | Prefill ships only for an ATS whose terms check finds nothing prohibiting user-side autofill. **Replaced by 11.**                                                                                  | 2026-10-28       |
| 5   | Daily review ceiling: 10 per rolling 24 hours by default, instance ceiling 25, users can only lower it                                                                                             | 2026-10-28       |
| 6   | Re-applying to the same requisition is allowed, with a typed reason                                                                                                                                | 2026-10-28       |
| 7   | Named "Assisted apply" and "Apply on \<ATS>", not "Submit to ATS"                                                                                                                                  | 2026-10-28       |
| 8   | Hidden entirely on the demo                                                                                                                                                                        | 2026-10-28       |
| 9   | The review step shows a static "valid until \<time>", not a countdown (Part B, for WCAG 2.2.1); Part A's countdown is dropped                                                                      | 2026-11-01, #79  |
| 10  | Opportun's existing server-side Workday reads (job list and job detail on a company's own myworkdayjobs.com host) stay as they are                                                                 | 2026-11-02, #113 |
| 11  | Vendor terms are not a gate on prefill, after reading the terms findings. Whether prefill works on a real form (M0 item 2) still decides each ATS                                                  | 2026-11-02, #113 |
| 12  | When a posting changes while a draft is open, the draft keeps its destination, a reviewed draft goes back to draft, and the screens explain the change                                             | 2026-11-02, #144 |

Design points from reviews, now in Part A:

- A snapshot can be deleted by its owner: the file goes, the fingerprint and title stay, and the
  UI asks first (#115, #117).
- The review screen shows the destination host prominently (#129, recorded on #117).
- Confirmation matching: the sender domain is unauthenticated, so a match on it stays visible and
  undoable; a link to another job at the board is evidence against (#128, #173, recorded on #119).
- The extension never imitates a human (no simulated typing or pointer events), never touches a
  captcha, and never submits (recorded on #120).
- M1c (#129) dropped career-page destinations, so a handoff goes only to a recognised ATS host
  (recorded on #120).
- A Greenhouse job embedded on a company's own careers page (`?gh_jid=`) gets a Greenhouse
  identity only once Greenhouse's API shows one of the company's known boards holds that job, or
  a board read just made did. The handoff still goes to that board's page, never to the careers
  link (#398).

The requirements and decision-log changes landed with M2a: FR-X in
[requirements.md](../requirements.md), the NG-3 note, C-6, and
[ADR-15](../adr/0015-assisted-apply.md).

## What was and was not verified (2026-10-27)

- Vendor submission mechanisms were read from official documentation on 2026-10-27; the sources
  are in Part A section 2. Vendor terms were not read then; they were collected for M0 on
  2026-11-02 (#113).
- Repository claims cite files and line numbers as read on 2026-10-27. The references the Tech
  Lead listed on #79 were re-checked on 2026-11-03 against 3a2b3bd; line numbers drift, so search
  for the named symbol.
