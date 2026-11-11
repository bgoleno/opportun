# Assisted apply: UX design

Part B of the assisted apply design: the UX designer's design, written 2026-10-27 outside the
repository and moved here under #122. The technical design is Part A,
[technical-design.md](technical-design.md). Status, decisions and how the two parts relate are in
[README.md](README.md). The mockups this page calls "Mockup 1" to "Mockup 12" are in
[ux-mockups.html](ux-mockups.html): download it and open it in a browser. They use invented data.

Where the code on `main` and this document disagree, the code wins: this records the design as
agreed, and the milestone issues (Part A section 9) record what each PR builds.

Numbers such as #79 or #124 in this folder are issues and pull requests in this repository,
https://github.com/bgoleno/opportun. "Q1" to "Q8" are the open questions in Part A section 10.2, and
the [README](README.md#decisions) records how each was answered.

Paths below are relative to `apps/web/src` unless they start with `apps/` or `packages/`. `popup.css` and
`render.ts` are in `packages/extension/src`, and `popup.html` is in `packages/extension`. A bare
file name, such as `TimelineList.tsx`, is the only file of that name in the repository.

---

## What the build changed

The sections below are the design as agreed. Building it departed from them in these ways, checked
by reading the code at d97dd45, not by running the screens. The list is not exhaustive. Part A's
[list](technical-design.md#what-the-build-changed) covers the routes, the data, the device token and
the server; the entries here cover what the user sees.

- **Apply card (S1).** It is titled "Assisted apply" and has no Where, Req. id or Resume rows. While the form is open it offers "Instructions" and "Cancel this application"; "I submitted it" is on the open step only. Once submitted, it shows the status chip, the time and "View application", above the usual Apply button: there is no "Apply again...". While an attempt is Submitted or No confirmation seen, the card also offers "I saw a confirmation" and "The site refused it" (#148), under an "Earlier application" block when that attempt is not the newest. The daily limit is on the review step, not the card. Two reasons were added for not being eligible: a stage other than Interested, Preparing or Applied, and a posting that needs review.
- **Resume step (S2).** The saved copy is made when the user continues, not when they choose. A ready copy shows its fingerprint and "Download the saved copy (PDF)", with no file name, type, size or text preview. There is no "I will attach it myself": a resume whose store cannot export carries on with no copy, and "Try again" appears when an export fails (#131). Resumes marked Submitted can be chosen as well as Final, and one that is neither is not listed, so there is no "still In review" banner. The user can delete the copy from Attachments; the fingerprint stays (#115, #117).
- **Details step (S3).** The fields are Part A's detail fields: first name and last name are fields of their own, alongside Full name (#184). There is no "Differs from your profile" marker, no AI draft block and no answer-source badge. Only variant B was built: the card says the site asks its own questions, and the user can add a question and an answer to see them on the review. A notice names any detail not carried over from an earlier application (#186).
- **Review step (S4).** The resume section names the resume and its saved copy, with no text preview. There is no "Edited for this application" badge and no "Not used" line. The stale notice says to check everything rather than highlighting what changed. Added: a notice when a posting changed after the user started (#144), one for another application to this job from another opportunity, and one for too many tries in a short time. A review still valid on return offers "Open \<host>" in place of the confirm button. Before confirming, the hint says the review stays valid for 30 minutes.
- **Open step (S5).** The heading is "Finish on the application site". The steps say to copy from "Your details to copy", which was built with a Copy button per row, and they do not mention the extension. There is no download button on this step. "I did not submit it" stops the application, and nothing in the web app records Failed, so "Something went wrong" was not built. If the browser blocks the new tab, the attempt is already handed off when the notice shows, so there is no "I opened it".
- **Attest dialog (S6).** "This will add" lists the timeline entry and the resume line, not a watch for a confirmation email. "Move this opportunity to Applied" shows only for a stage earlier than Applied.
- **Application page (S7).** The route is `/opportunities/:id/applications/:submissionId`, and the visible text says "application", not "submission", though each chip's prefix for screen readers is still "Submission status:". It is one column: the status banner, "What happened?" for an attempt submitted or with no confirmation seen, then Evidence, Where it went, Resume used, What you reviewed (field values and answers), History in plain text, and Other applications for this role. "Dismiss", "Record confirmation page", "Open email", "Preview text" and "I did not actually submit this" are not on the page. The Waiting banner gives no end date. Email evidence shows the subject, sender, time and the matched signals in words, with no snippet; a recorded page offers "Show the recorded text" and "Delete the recorded page".
- **Timeline (T).** A confirmation page shows as "Confirmation page", not "Captured page". Entries have no status chip, no "View submission" link and no "Confirms your application" tag. The titles and stage note are as designed.
- **Status chips (d).** The words, icons and badge variants are as designed. There are no tooltips on the chips. The contrast figures were not measured again.
- **Extension popup (e).** States A to G were not built as designed. The popup is headed "Opportun Capture", and "Capture this page" stays the primary button. An "Assisted apply" section shows only on a Greenhouse posting tab, with the button "Fill in this application"; a "Confirmation page" section shows on any https page, with "Record confirmation page". Nothing goes to the server before the click. The result is one status line, a list of what was filled and "Not filled in" with each reason, and a reminder to check the form and press Submit. The filler attaches the resume (#183). "I submitted this" was not built, because a device does not attest.
- **Settings (f).** There is no Applications card under Integrations. A card titled "Applications" on **Settings > Profile** holds only "Reviews allowed per 24 hours". There is no on or off checkbox, no follow-up days and no list of senders. The token dialog offers "Assisted apply" where the feature is on, and a paragraph under the whole scope list, not under that one checkbox, says what the scope reads and records and that it cannot start, review or submit an application. The extension's Set up flow has its own wording on its checkbox (#182).
- **Edge cases (h).** "Possible application", "Link this email", "A newer version exists" and the "Already recorded" toast are not in the web app.

---

## 0. Files matched (evidence the design is native)

| Concern                          | File studied                                                                                                                                                   | What was reused                                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens, themes                   | `apps/web/src/index.css`                                                                                                                                       | Every colour in the mockups is a copied token (`--primary`, `--success`, `--warning`, `--destructive`, `--accent`, `--muted-foreground`, `--border`, radius 0.5rem). Dark follows the same values. No new token is proposed. |
| Buttons, badges, cards, dialogs  | `components/ui/button.tsx`, `badge.tsx`, `card.tsx`, `dialog.tsx`, `checkbox.tsx`, `tabs.tsx`, `tooltip.tsx`, `toast.tsx`                                      | Sizes (h-9 default, h-8 sm, h-10 lg), Badge variants, native `<dialog>` with `max-w-lg`.                                                                                                                                     |
| Page layout                      | `components/opportunity/OpportunityDetail.tsx`                                                                                                                 | Header, Tabs, and the Timeline tab's `grid lg:grid-cols-[1fr_20rem]` rail where Apply sits.                                                                                                                                  |
| Timeline                         | `components/opportunity/TimelineList.tsx`, `lib/opportunities.ts` (`ACTIVITY_KIND_LABELS`: `application` shows as "Application", `capture` as "Captured page") | The `li` shell `rounded-xl border bg-card p-4`, Badge + summary + `time`.                                                                                                                                                    |
| Banners                          | `components/opportunity/PostingStateBanner.tsx` (amber, `role="status"`), `FormError.tsx` (`role="alert"`)                                                     | All warning and error banners.                                                                                                                                                                                               |
| Confirm shape                    | `components/ConfirmDialog.tsx`                                                                                                                                 | Dialog structure and the "stays open on failure, error shown inside" rule, used for the attest dialog.                                                                                                                       |
| Resume status and "Submitted to" | `components/resume/StatusControl.tsx`, `ResumeList.tsx` (`StatusBadge`)                                                                                        | Language "Sent to ...", resume status vocabulary.                                                                                                                                                                            |
| Next steps                       | `components/opportunity/NextStepsPanel.tsx`                                                                                                                    | The "No confirmation seen" next step renders here unchanged.                                                                                                                                                                 |
| Settings                         | `routes/settings/-devices.tsx` (`DevicesCard`, `SCOPES`, create-token dialog)                                                                                  | Settings card idiom and the scope checkbox list.                                                                                                                                                                             |
| Extension                        | `popup.css`, `popup.html`, `render.ts`                                                                                                                         | 320px width, hex tokens, one `role="status"` line, tone classes success/info/error, sentence style of `renderOutcome`.                                                                                                       |

Two small facts worth knowing. On 2026-10-27 the extension README and popup text said "Settings > Integrations > Devices" while `render.ts` said "Extensions and Connectors"; the designed copy uses "Extensions and Connectors" (the card title in `-devices.tsx`), and the extension now says that everywhere. Also `Badge` sets no icon size, so the new chip sets `size-3` on its icon itself.

## (a) Design principles

1. **Say who acts, every time.** Opportun prepares and records. The user opens, fills, and presses Submit. Every screen names the actor in the sentence ("You press the Submit button on jobs.example.com"). Banned phrases: "submit for you", "auto apply", "one click apply", "send", "we applied".
2. **One real gate, not stacked speed bumps.** The review is a document the user actually needs to read (it is the only place the resume text, details and answers are together). It ends in one acknowledgment and one button. There is no second "are you sure" after it.
3. **Make the gate feel deliberate, not slow.**
   - It is a full page titled "Check everything before you open the form", not a modal. A modal reads as an interruption; a page reads as a step.
   - It is laid out in the same order the form will ask: Where it goes, Resume, Your details, Your answers. Nothing is collapsed. This costs the user nothing they did not need to check anyway.
   - The statement "Opportun will not submit this. You will press the submit button on `jobs.example.com`." sits in a strong left-bordered callout above the cards, repeated in the acknowledgment sentence, not buried at the bottom.
   - The primary button names its consequence and host: "Confirm review and open jobs.example.com". Before ticking, it is `aria-disabled` (still focusable) with a visible reason next to it, so keyboard and screen-reader users learn why.
   - No ticking countdown. Expiry is shown as a clock time ("valid until 14:42"). A live timer creates pressure and is a WCAG 2.2.1 hazard; a static time gives the same information.
   - No fake scroll-gating. The checkbox is not locked until the user scrolls, because that fails keyboard and zoom users and only teaches people to scroll fast.
   - The daily count appears only as a limit notice ("3 of 10 reviews used in the last 24 hours" in small muted text, and a banner when hit). It is never framed as progress.
4. **Honesty about what Opportun cannot see.** After handoff Opportun is blind. Status words are about what the user told it ("Submitted") versus what evidence exists ("Confirmed"). "No confirmation seen" is explicitly not a failure.
5. **No volume cues.** No queue, no "next opportunity", no list with checkboxes leading to Apply, no streaks or totals. The Apply card exists on one opportunity at a time.
6. **Quiet by default, loud only for blockers.** Amber for things to notice, red only for refusal and failure. Calm copy: say what happened, what it means, the one thing to do.
7. **Reuse over invention.** Every pattern above exists in the app today. New components are thin wrappers (section (i)).
8. **Reversible and resumable.** Draft state persists, the page can be left and returned to, an expired review costs one click, nothing is lost.

## (b) End-to-end journey and screen list

```
Opportunity page (Timeline tab)
  S1 Apply panel  ----[How this works]----> S1b Explainer dialog
     | "Apply on Example ATS"
     v
  S2 Apply page, step 1 Resume      (snapshot: preparing / ready / could not export)
     v
  S3 step 2 Details                 (fields, questions, AI drafts)
     v
  S4 step 3 Review (the gate)       (variants: duplicate, stale, expired, cap, snapshot pending)
     |  tick + "Confirm review and open jobs.example.com"
     v      (new tab opens on the real ATS; user fills, optionally with extension popup E1-E7)
  S5 step 4 Open Example ATS (handoff)
     |  "I submitted it"
     v
  S6 Attest dialog
     v
  S7 Submission detail (history, resume copy, evidence)   <--- timeline entry link, Apply card link
     states: Waiting, Confirmed, No confirmation seen, ATS refused, Failed, Abandoned
  Timeline entries T1-T5
  Settings: Applications card, device-token scope
```

Screens: S1 Apply panel (7 states), S1b How this works, S2 Resume step, S3 Details step, S4 Review gate (+6 states), S5 Handoff, S6 Attest dialog, S7 Submission detail, T1-T5 timeline entries, E1-E7 extension popup, Settings (2).

Routing recommendation (for the frontend implementer): `/opportunities/:id/apply` with `?step=resume|details|review|open` so the browser Back button and deep links work and draft state is server-side; `/opportunities/:id/submissions/:sid` for detail. Both are single-id routes (no list route exists, by design, NG-3).

## (c) Per-screen design

### S1. Apply panel (opportunity page)

Placement: a Card at the top of the right rail on the Timeline tab (the `20rem` column beside the timeline, above Next steps). On phones the rail stacks below the timeline in the current code; the design makes the Apply card `order-first` on phones so it is not buried under a long timeline. (Mockup 1.)

```
Desktop (rail, 20rem)                 Phone (full width, above composer)
+-------------------------------+     +--------------------------+
| Apply                         |     | Apply                    |
| Where   Example ATS (host)    |     | [chip]  note             |
| Req. id REQ-2041              |     | one sentence             |
| Resume  Platform Eng (Final)  |     | [ Primary action ]       |
| You will review everything,   |     | How this works           |
| then fill in and submit the   |     +--------------------------+
| form on the ATS yourself.     |
| [  Apply on Example ATS  ]    |
| How this works                |
+-------------------------------+
```

States and exact copy:

| State                                                    | Chip                                  | Body copy                                                                                                                                               | Actions                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready                                                    | none                                  | "You will review everything, then fill in and submit the form on the ATS yourself."                                                                     | Button "Apply on Example ATS" (default variant, full width). Link "How this works".                                                                                                                                                                                                                                                                                             |
| Not eligible: stage dismissed or closed                  | none                                  | "This opportunity is Closed. Reopen it to apply." (or "Dismissed", the stage's own name)                                                                | The button looks disabled (dimmed, not-allowed cursor, no hover colour) but is `aria-disabled`, not `disabled`, so it stays focusable, and `aria-describedby` the reason. The reason is visible text right after the button (`aria-live="polite"`). A click does nothing else and answers in that line, in normal text colour: "<button label> is not available yet. <reason>". |
| Not eligible: another stage (New, In process, Offer)     | none                                  | "This opportunity is In process. Applying is available at Interested, Preparing or Applied. Change its stage to apply." (the stage's own name)          | As for "stage dismissed or closed".                                                                                                                                                                                                                                                                                                                                             |
| Not eligible: no ATS identified                          | none                                  | "We have not recognised this company's application system yet. Open the posting from the Details tab, or use Find posting."                             | The button reads "Apply on an ATS". Otherwise as for "stage dismissed or closed".                                                                                                                                                                                                                                                                                               |
| Not eligible: posting needs review                       | none                                  | "This opportunity's posting needs review. Confirm it on the Details tab first."                                                                         | As for "stage dismissed or closed".                                                                                                                                                                                                                                                                                                                                             |
| Not eligible: no base resume (flow state A)              | none                                  | "Add a base resume to start."                                                                                                                           | As for "stage dismissed or closed", with a link "Open the Resume tab" under the reason (the Resume tab, `?tab=resume`).                                                                                                                                                                                                                                                         |
| Not eligible: a base, nothing for this opportunity (B)   | none                                  | "Choose the resume to start from."                                                                                                                      | As for "stage dismissed or closed", with a link "Open the Resume tab" under the reason (the Resume tab, `?tab=resume`).                                                                                                                                                                                                                                                         |
| Not eligible: tailored copy in Draft (C)                 | none                                  | "\"Acme tailored\" is still a Draft. Tailor it, then mark it as final to apply." (the resume's own title)                                               | As for "stage dismissed or closed", with a link "Open the Resume tab" under the reason (the Resume tab, `?tab=resume`).                                                                                                                                                                                                                                                         |
| Not eligible: tailored copy In review (D)                | none                                  | "\"Acme tailored\" is still In review. Mark it as final to apply." (the resume's own title)                                                             | As for "stage dismissed or closed", with a link "Open the Resume tab" under the reason (the Resume tab, `?tab=resume`).                                                                                                                                                                                                                                                         |
| Not eligible: a resume recorded as sent, none usable (H) | none                                  | "A resume is already recorded as sent for this opportunity. To apply here too, mark a resume as final."                                                 | As for "stage dismissed or closed", with a link "Open the Resume tab" under the reason (the Resume tab, `?tab=resume`).                                                                                                                                                                                                                                                         |
| Not eligible: feature off (instance or user)             | the whole card is absent; no teaser   |                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                 |
| In progress: Draft                                       | Draft                                 | "Your application is saved as a draft."                                                                                                                 | "Continue" (links to the current step), "Cancel this application" (link).                                                                                                                                                                                                                                                                                                       |
| In progress: Reviewed                                    | Reviewed + "Review valid until 14:42" | "Your review is saved. Nothing has been sent anywhere."                                                                                                 | "Continue to open Example ATS", "Cancel this application".                                                                                                                                                                                                                                                                                                                      |
| In progress: Opened on ATS                               | Opened on ATS + "Opened 35 min ago"   | "Finish the form on Example ATS and press its own Submit button. Then tell Opportun."                                                                   | "I submitted it", "Instructions".                                                                                                                                                                                                                                                                                                                                               |
| Done: Submitted                                          | Submitted + date                      | "Waiting for a confirmation email" (clock icon)                                                                                                         | "View submission".                                                                                                                                                                                                                                                                                                                                                              |
| Done: Confirmed                                          | Confirmed + date                      | "Confirmation email received." (or "Confirmation page recorded.")                                                                                       | "View submission", quiet button "Apply again..." (re-apply flow requires a typed reason).                                                                                                                                                                                                                                                                                       |
| Done: No confirmation seen                               | No confirmation seen                  | "Nothing arrived yet. This is not a failure."                                                                                                           | "View submission".                                                                                                                                                                                                                                                                                                                                                              |
| Daily limit                                              | none                                  | Amber `role="status"` banner: "You have reviewed 10 applications in the last 24 hours, which is the limit. You can start another after 09:14 tomorrow." | Button disabled with `aria-describedby` the banner.                                                                                                                                                                                                                                                                                                                             |

The resume rows (A to D, and H) are the resume flow's own sentences: the panel asks `resumeFlowState` and says `flowSentence` (https://github.com/bgoleno/opportun/issues/428), so it and the Resume tab say the same about the same data. They apply only when no resume assisted apply can use is there (Final or Submitted, not archived, a base or this opportunity's own).

Tooltip (reuse `Tooltip`) on the disabled button is not relied on (touch users); the reason is always visible text. Tooltip on the chip "No confirmation seen": "Not a failure. Many employers send no confirmation, and some emails land in spam."

"How this works" explainer: Dialog (ConfirmDialog shell). Title: "How Assisted apply works". Body: "Opportun cannot apply to a job for you, and does not try to. You do the applying, Opportun keeps the record." Then five numbered steps (You choose a resume; You review; You open the real form; You press that site's Submit button; You tell Opportun) and the closing line "Opportun never sends anything to the application site, never logs in there, and never applies to more than one job at a time." Single button "Got it". (Mockup 1, bottom.)

### S2. Apply page, step 1: Resume

Header: back link to the opportunity (same `BackLink` style), `h1` "Apply to Northwind Example Co.", muted line "Senior Platform Engineer, REQ-2041, on Example ATS". Stepper below, then the "Opportun will not submit this" callout (short form) so the promise is visible from step one.

```
< Senior Platform Engineer
Apply to Northwind Example Co.
(1 Resume)--(2 Details)--(3 Review)--(4 Open Example ATS)
[shield] Opportun will not submit this. You will press the submit button on jobs.example.com yourself.
+-- Choose the resume to use ---------------------------+
| Only resumes marked Final can be used. The copy is    |
| saved now, so later edits will not change it.         |
| Resume [ Platform Eng, tailored (Tailored, Final) v ] |
| Saved copy                                            |
|  [file] Sam-Rivera-Platform-Eng.pdf  (Ready)          |
|  PDF, 142 KB   Fingerprint 3fa9c1d2   Saved 14:12     |
|  [ text preview, scrollable, focusable ]              |
|  [Download copy]   [Next: Details]                    |
+-------------------------------------------------------+
```

Desktop: single column, max about 48rem. Phone: same, buttons full width.

Snapshot states (Mockup 3):

- **Preparing**: spinner (static icon if reduced motion) + "Preparing your resume file..." + "This usually takes a few seconds. You can keep reading." `role="status"`. Next is disabled with visible reason.
- **Ready**: success badge "Ready" with check icon, file name, type, size, "Fingerprint" (hash prefix; label chosen because "hash" is jargon, with a tooltip "A short code that identifies this exact file"), saved time, text preview, Download copy.
- **Could not export**: `role="alert"` error: "Opportun could not save a PDF of this resume. \<reason>." plus "You can still apply: download or export the file yourself, then attach it on the application site." Buttons "Try again" and "I will attach it myself" (the second continues with no snapshot; the Review screen then shows "Resume: you will attach it yourself" and the record notes that).
- **Resume not Final**: amber banner "This resume is still In review. Mark it Final to use it here." with "Open resume".
- Changing the dropdown re-runs Preparing, and any earlier review is discarded (a status line says "Your earlier review no longer counts" only if one existed).

### S3. Apply page, step 2: Details

Two Cards. (Mockup 4.)

1. "Your details": "Used to fill the form. Changes here apply to this application only, not to your profile." Inputs for full name, email, phone, location, work authorisation, links in a responsive 2-column grid (1 column on phones). A field that differs from the profile gets a left amber rule and the line "Differs from your profile (profile says: ...)" with a pencil icon (not colour alone).
2. "Questions on this form": variant A (questions known): "Example ATS publishes these questions. Answer the ones you want to prefill. Anything left empty you answer on the site." Each question: label with "(required)" or "(optional)" text, input, and an answer-source badge: "Typed by you" or "AI draft accepted". Variant B (unknown): "This site asks its own questions. You will answer them on the form before you press its Submit button."

AI draft block: muted panel, badge "AI draft", text "Draft, not used until you accept it", buttons "Accept draft", "Edit first", "Discard". Accepting is one click per answer. Unaccepted drafts appear on Review as "Not used".

Footer: "Back", "Next: Review". Validation: required published questions with no answer show inline "This question is required by the form. You can answer it now or on the site." (a warning, not a blocker, because the user may answer on the site; this avoids pushing users to fabricate).

### S4. Apply page, step 3: Review (the gate)

(Mockup 5; states Mockup 6.) Order, top to bottom, nothing collapsed:

```
(1)--(2)--(3 Review)--(4)
Check everything before you open the form
This is what Opportun will help you put on the form. Nothing leaves Opportun from this page.
| [shield] Opportun will not submit this. You will press the submit button on jobs.example.com. |
+ Where it goes ------------------------------+
| Application site  Example ATS               |
| Company, role     Northwind ..., Senior ... |
| Requisition       REQ-2041                  |
| Address           https://jobs.example.com/northwind/2041/apply |
|                   Opens in a new tab.       |
+ Resume -------------------------------------+
| [file] name.pdf   3fa9c1d2                  |
| [ full text preview ]                       |
+ Your details -------------------------------+
| label : value ...  [Edited for this application] |
+ Your answers -------------------------------+
| Q / A pairs; "Not used" for unaccepted drafts   |
| Anything else the site asks, you answer on the form. |
+ Ready to open the form? (2px primary border) +
| [ ] I have read the resume and my answers, and I will press Submit myself on jobs.example.com. |
| [Confirm review and open jobs.example.com] [Back] [Cancel application] |
| Tick the box to continue. Your review stays valid until 14:42 today, and you can review again after that. |
| 3 of 10 reviews used in the last 24 hours.   |
+---------------------------------------------+
```

Behaviour:

- The destination address is shown in full (host and path) in monospace so a lookalike host is noticeable.
- Primary button is `aria-disabled="true"` until the checkbox is ticked, then enabled; it is never auto-focused. Activating the disabled button moves focus to the checkbox and announces "Tick the box to continue".
- Phone: one column; the gate card's three buttons stack, primary first. The primary stays reachable by normal scroll (it is the last card; no sticky bar, since a sticky confirm button would reward not reading).
- On success: focus moves to the Handoff step heading; the new tab opens via `window.open` triggered by the click. If blocked, S5 shows the fallback link.

Review states (Mockup 6), all banners above the destination card unless noted:

| State             | Copy                                                                                                                                                                                                                                                                | Behaviour                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Duplicate warning | "**You already applied to this role.** You submitted REQ-2041 on Oct 20, 2026 (Confirmed). Applying twice can look like a mistake to the employer." plus field "Why are you applying again? (required)" and help "Saved on the submission. Not shared with anyone." | Confirm stays disabled until the reason has text.           |
| Stale review      | "**Something changed while you were reviewing.** Your resume choice was updated, so your earlier review no longer counts. Check the highlighted part, then confirm again." Changed item shown with a "Changed" warning badge, pencil icon and amber left rule       | Checkbox resets to unticked. Focus goes to the banner.      |
| Expired review    | "**Your review expired at 14:42.** We ask you to review again so what you checked is what you use. Nothing was lost." with "Review again"                                                                                                                           | Re-renders the gate with a fresh digest, checkbox unticked. |
| Daily limit       | "**Review limit reached for today.** You have reviewed 10 applications in the last 24 hours. You can confirm another after 09:14 tomorrow. Your draft is saved."                                                                                                    | Confirm disabled.                                           |
| Snapshot pending  | "Still preparing your resume file. The Confirm button turns on when it is ready." (info, spinner)                                                                                                                                                                   | Confirm disabled.                                           |
| Server error      | `FormError`: "Could not save your review. Nothing was opened. Check your connection and try again."                                                                                                                                                                 | Stays on page, focus to message.                            |

### S5. Apply page, step 4: Open Example ATS (handoff)

(Mockup 7.) Success banner: "The form opened in a new tab. Opportun has not submitted anything and cannot see that page." Two cards side by side on desktop, stacked on phones.

"On the application site" (numbered): 1 Fill the form (with the extension: open it on that page and choose Prefill; without: type or paste from the Review screen), 2 Attach your resume (Download button for the saved copy), 3 Answer any other questions the site asks, 4 Press the site's own Submit button. "Only you can do this." Fallback line: "Did the tab not open? Open jobs.example.com (opens in a new tab)."

"When you are done": "Opportun cannot tell whether you submitted. It only records what you tell it." Buttons "I submitted it" (default) and "I did not submit it" (outline). Footnote: "Opened 4 minutes ago. There is no deadline here: come back whenever you finish." (No countdown.)

"I did not submit it" opens a small ConfirmDialog-style dialog: "Stop this application?" "Nothing was submitted. You can start again later." Buttons "Keep going" / "Stop application"; result state Abandoned. If the cause was a problem (site would not load), a second optional link "Something went wrong" records Failed with a one-line reason field.

The persistent Apply card on the opportunity page offers the same two actions, so closing this tab loses nothing.

### S6. Attest dialog

(Mockup 8.) Native Dialog. Title: "Record that you submitted this application?" Description: "Opportun cannot see the application site, so this is your word. Only continue if you pressed Submit and the site accepted the form." Field: "When did you submit?" (datetime-local, default now; may not be in the future). Summary under "This will add:" three bullets: timeline Application entry ("resume and answered questions listed, no field values"); "Submitted to Example ATS / Northwind Example Co." on the resume; "A watch for a confirmation email from jobs.example.com or northwind.example.com for 3 days." Checkbox pre-ticked "Move this opportunity to Applied" (answer to open question Q3; see (j)). Buttons: "Not yet" (outline) and "Yes, I submitted it" (default variant, not destructive: the action is a record, not a deletion). The primary label is the user's first-person claim on purpose.

Focus: opens on the dialog title region (the native dialog default is the first focusable; set `autofocus` on the date field so the primary button is never the first stop). Failure keeps the dialog open with `FormError` inside (ConfirmDialog behaviour). On success: toast "Application recorded" (success), focus returns to the Apply card's "View submission".

### S7. Submission detail with evidence

(Mockup 9.) Page header: `h1` "Application to Northwind Example Co.", muted "Example ATS, REQ-2041. You reported submitting it on Oct 27, 2026 at 14:31." Status chip at right. Two-column body on desktop (stacked on phone, evidence first):

Left: **Evidence** card, then **History**. Right: **Resume used** (name, fingerprint, Download copy, Preview text) and **What you filled in** (field names and values, answered question count; details expandable).

Evidence variants:

- **Confirmation email**: item with Mail badge, subject, sender, date, snippet (never the body, NFR-PRV5), "Matched on:" secondary badges (Sender domain, Role title, Requisition id), actions "Open email" and "Not this application (unlink)". Helper text: "What backs up your report. Opportun checks the sender and role, but cannot prove an email is genuine."
- **Confirmation page**: badge "Captured page", URL, captured time, text preview (collapsed with "Show more", reusing the timeline pattern), "Delete" icon button (labelled "Delete confirmation page").
- **User-asserted**: badge "Note", "You marked this confirmed on Oct 28. No evidence attached." (visibly weaker: no success colour on the evidence block, dashed outline).

History: ordered list of chip + "time, by whom" (you, extension, email match, scheduler).

Status variants of the same page:

| Status                | Banner (role="status")                                                                                                                                | Actions                                                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting (window open) | "Waiting for a confirmation. Most employers send an email within minutes to a few days. Opportun will look until Oct 30." (info)                      | "I saw a confirmation", "Record confirmation page"                                                                                                                                                                                                                          |
| Confirmed             | none; evidence card is the proof                                                                                                                      | "View email" etc.                                                                                                                                                                                                                                                           |
| No confirmation seen  | "**No confirmation seen yet.** This is not a failure. Many employers send nothing, and some emails land in spam. Opportun looked for 3 days." (amber) | Card "What happened?": "I saw a confirmation" (outline), "Record confirmation page" (outline; helper "needs the Opportun extension, open on the thank-you page"), "The site refused it", "Dismiss" (ghost; helper "keeps the submission as it is and closes the next step") |
| ATS refused           | "The application site refused the form. Your note: '\<text>'. Your stage was not changed."                                                            | "Apply again..." (re-apply)                                                                                                                                                                                                                                                 |
| Failed                | "This could not be completed. Nothing was submitted. Reason: \<reason>."                                                                              | "Start again"                                                                                                                                                                                                                                                               |
| Abandoned             | "You stopped before submitting. Nothing was sent."                                                                                                    | "Start again"                                                                                                                                                                                                                                                               |

"The site refused it" opens a dialog with a note field ("What did the site say?") and button "Record refusal". "I saw a confirmation" opens a dialog: "Mark as confirmed? This records that you saw a confirmation. No evidence will be attached." with "Mark confirmed".

### T. Timeline entries

(Mockup 10.) Same `li` shell as `TimelineList.tsx`. Newest first.

- **T1 Application** (existing kind): Badge "Application", title "Applied via Example ATS: Senior Platform Engineer", time. Second line: Submitted chip + "Basis: you reported submitting this". Body: "Resume: Sam-Rivera-Platform-Eng.pdf (3fa9c1d2), saved copy attached. Answered: '...', '...'" Footer links: "View submission", external URL (existing link style).
- **T2 Confirmation email** (existing communication item): unchanged, plus a tag line under the snippet: check-check icon + "Confirms your application" in success text (icon plus words; colour is an extra).
- **T3 Confirmation page**: existing "Captured page" badge, title "Confirmation page recorded (jobs.example.com)", body collapsible via existing `ActivityBody`.
- **T4 Next step**: appears in Next steps panel: "Check whether your application to Northwind Example Co. was received", due date.
- **T5 Notes**: "Marked confirmed by you (no evidence attached)" and "The application site refused the form" with user's note and "Your stage was not changed."
- **Stage entry** (existing): "Interested to Applied" with note "Applied via assisted submission".

No timeline entry for Draft, Reviewed, Opened, Failed or Abandoned (matches Part A section 5.2): the timeline is not a log of attempts.

### Microcopy rules

1. Name the actor. Prefer "You press...", "Opportun records...". Never "we sent", "applied for you".
2. Allowed verbs for Opportun: prepare, save, record, remind, watch for, match. Forbidden: submit (as Opportun's verb), send, apply (as Opportun's verb), automatically, one click, queue, batch, "all".
3. Buttons: verb plus object, host named when leaving the app ("Confirm review and open jobs.example.com"). No "Submit" label anywhere in Opportun's UI, so the only Submit button on screen is the ATS's own.
4. Status text is about evidence: "Submitted" means you said so; "Confirmed" means evidence exists.
5. Errors and banners: what happened, what it means for the user's data ("Nothing was submitted", "Nothing was lost"), one next action. No blame, no jargon ("digest", "snapshot" are internal; the UI says "saved copy" and "fingerprint").
6. Sentence case, no exclamation marks, no emoji, no em dashes. Dates "Oct 27, 2026" (app's `formatDate`).
7. "ATS" is used because the app already uses it (`PostingStateBanner`, settings); the first use per screen is paired with the named vendor ("Example ATS"). "Application site" is the plain-language fallback.
8. Numbers as numerals. Limits stated as limits, not goals.

## (d) Status chip system and timeline

Component `SubmissionStatusChip` = existing `Badge` + a 12px icon + text. Hidden prefix `<span class="sr-only">Submission status: </span>`. Colours are existing tokens only (Mockup 2).

| Status     | Text                 | Badge variant (token)                               | Icon (lucide)  | Other cue      | Contrast measured (light / dark) |
| ---------- | -------------------- | --------------------------------------------------- | -------------- | -------------- | -------------------------------- |
| draft      | Draft                | outline (`--foreground` on transparent, `--border`) | Pencil         |                | n/a (text on card, 12+ : 1)      |
| reviewed   | Reviewed             | secondary                                           | ClipboardCheck |                | 14.0 / 12.7                      |
| handed_off | Opened on ATS        | secondary                                           | ExternalLink   |                | 14.0 / 12.7                      |
| submitted  | Submitted            | default (`--primary`)                               | Check          |                | 6.2 / 6.8                        |
| confirmed  | Confirmed            | success                                             | CheckCheck     | double check   | 4.9 / 8.3                        |
| unknown    | No confirmation seen | warning                                             | CircleHelp     |                | 15.5 / 9.3                       |
| rejected   | ATS refused          | destructive                                         | Ban            |                | 5.2 / 5.8                        |
| failed     | Failed               | destructive                                         | OctagonX       |                | 5.2 / 5.8                        |
| abandoned  | Abandoned            | outline + dashed border                             | Archive        | dashed outline | n/a                              |

Contrast numbers were computed in the browser from the rendered mockup (see (k)). Success in light mode is 4.94:1, above the 4.5:1 threshold but with little headroom; do not lighten `--success`.

Distinguishing the two red statuses and the two secondary ones: they differ by icon shape and label; the history list and banners always spell the status in words. Greyscale and forced-colours: icons use `currentColor`, the badge has a border-colour fallback (`border: 1px solid` transparent turns visible in forced colours), so shapes and words remain.

Tooltips (Radix `Tooltip`, plus the same text on the detail page so touch users get it): Reviewed "You checked it. The real form is not open yet." Opened on ATS "The form was opened. Opportun does not know if you submitted." Submitted "You told Opportun you pressed Submit." Confirmed "A confirmation email or page backs this up." No confirmation seen "Not a failure. Many employers send nothing." ATS refused "The application site rejected the form. This is different from an employer declining you." Failed "It could not be completed. Nothing was submitted." Abandoned "You stopped before submitting."

Note on vocabulary: "ATS refused" is a form-level refusal; an employer's later rejection remains in the existing Closed/Rejected lifecycle (Part A 4.3). The tooltip says so to avoid confusion.

## (e) Extension popup states

(Mockup 11.) Same 320px popup, `popup.css` tokens, `#status[role=status]` line with `data-tone`. The popup keeps the existing "Capture this page" button and adds an "Assisted apply" section below it only when relevant; to avoid two competing primary buttons the capture button becomes secondary weight (outline) in states B, D, F.

| State                         | Heading/line                                                                                                                       | Content                                                                                                                 | Buttons                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A No application ready (info) | "No application is ready. Start Assisted apply in Opportun first." hint "The extension cannot start or review an application."     |                                                                                                                         | Prefill disabled                                                                                                    |
| B Ready on this page          | hint "Ready to fill this page. It will not click anything."                                                                        | Definition list: Company, Role, Site (host plus check mark and the word "matches"), Resume, Fields ("9 will be filled") | "Prefill from Opportun" (primary)                                                                                   |
| C Wrong page (error)          | "Wrong page. Nothing was filled."                                                                                                  | Expected host vs This page                                                                                              | Prefill disabled; hint "Open the form from Opportun's Open Example ATS step, then try again."                       |
| D Prefilled (success)         | "Filled 8 fields. Review the form, then press the site's Submit button."                                                           | "Left for you:" list with reasons ("Phone: the field is locked on this site", "Resume: attach it yourself")             | "Download resume copy", "I submitted this" (primary) with hint "Press this only after the site accepted your form." |
| E Unsupported layout (error)  | "This form's layout is not supported. Nothing was filled." hint "Use your Review screen in Opportun to copy the details across."   |                                                                                                                         | Prefill disabled                                                                                                    |
| F Record confirmation page    | hint "Is this the thank-you page?"                                                                                                 | Page URL, "1,204 characters will be saved"                                                                              | "Record confirmation page" (primary); same host check as B, otherwise state C                                       |
| G Missing scope (error)       | "This token cannot use Assisted apply. Create one with that permission under Settings > Integrations > Extensions and Connectors." |                                                                                                                         | Prefill disabled                                                                                                    |

Existing errors reused verbatim from `render.ts`: unauthorized, rate limited, network ("Could not reach the server. Check the address and that the server is running."), permission_denied, inject_failed. After "I submitted this" succeeds: success line "Recorded in Opportun. You can close this tab." Rules: the popup never auto-runs, never clicks a page control, the Site row shows the host as text and the match as a check icon plus the word, tone colours always accompanied by the words. The popup shows a hint "Press this only after..." because the popup button is the most likely mis-click.

## (f) Settings additions

(Mockup 12.)

1. **Settings > Applications** (new Card, same idiom as `DevicesCard`): title "Applications", description "Controls for Assisted apply. Opportun never submits for you; these set how it helps you keep track." Controls: checkbox "Show Assisted apply on opportunities"; number "Reviews allowed per 24 hours" (default 10, max = instance ceiling; help "You can lower this, up to the limit your server sets (25). A lower limit helps you stay deliberate."); number "Look for a confirmation for (days)" (default 3; help "After this, Opportun marks it 'No confirmation seen' and adds a next step. Nothing is sent."); "Senders that count as a confirmation" list with "Built in" and "Added by you" badges, a text field and Add, and "Remove" on user entries (reuses the pattern of `-mailFilters.tsx`). Save button "Save". If the instance disabled the feature the card shows a one-line note "Assisted apply is turned off on this server." and no controls.
2. **Device token dialog** (`-devices.tsx` `SCOPES`): third checkbox "Assisted apply (apply:assist)" with description below it: "Lets the extension read the one application you have already reviewed and opened, and tell Opportun you submitted it. It cannot start or review an application." `aria-describedby` links the text. The token list shows a scope badge "Assisted apply" next to existing ones.
3. Demo deployment: no Apply card, no Settings card (Part A 3.4 and 11.6).

## (g) Accessibility and phone behaviour

WCAG 2.1 AA targets, per screen:

- **Focus order**. Apply card: chip, text, primary action, secondary link, How this works. Review page: skip link (existing), back link, stepper (not interactive for completed steps unless links), h1, callout, cards in reading order, then checkbox, primary, Back, Cancel. The stepper is `<ol aria-label="Progress">` with `aria-current="step"`; completed steps show "(completed)" as sr-only text. Primary action comes after the checkbox so tabbing in order always passes the acknowledgment first.
- **Focus management**. Moving between steps moves focus to the new step's `h1` (`tabIndex=-1`), as `main` does in `AppShell.tsx`. Dialog focus: native `<dialog>` traps and restores. Attest opens on the date field. Errors move focus to the `role="alert"` message. On stale/expired, focus goes to the banner.
- **Announcements**. Status chips changing on a live page use a polite `role="status"` region ("Submission status: Confirmed"). Snapshot Preparing to Ready is announced politely. Errors `role="alert"`. The disabled-primary explanation is linked with `aria-describedby`. Tooltip text is duplicated as visible text on the detail page. The daily-limit banner is `role="status"`, present on load, not repeatedly announced.
- **Disabled controls**. Use `aria-disabled` plus a visible reason for Apply and Confirm so keyboard users can reach them and learn why (the app's Button uses native `disabled`; an `aria-disabled` variant is needed for these two buttons only). Note: 50% opacity disabled buttons are exempt from contrast rules, which is why the reason text carries the meaning.
- **Colour independence**. Every chip pairs an icon and words; banners carry icons and bold lead-ins; changed fields carry a "Changed" badge and pencil icon and a left rule, not only amber.
- **Contrast**. Measured: chips 4.9:1 to 15.5:1; muted small text on card 6.2:1 in light; callout 11.5:1. Banner text is `amber-900` on `amber-50` (8.8:1, same as `PostingStateBanner`). The `--primary` focus ring (`--ring`) is used for every control; mockups add the same 2px ring.
- **Reduced motion**. The only animation is the spinner; under `prefers-reduced-motion: reduce` it becomes a static icon with the text carrying status. No transitions are required for meaning.
- **Target size**. Buttons at least 32px high (sm) and the primary actions at 36 to 40px; on phones primary buttons are full width. Checkbox rows are label-wrapped so the whole line is the hit area.
- **Reflow and zoom**. Mockups verified at 390px with no horizontal scroll; the review is a single column at 320px and 400% zoom. Long hosts and URLs use `overflow-wrap:anywhere`.
- **Phone specifics**. Apply card first on phones; dialogs use `w-[calc(100%-2rem)]` and the footer stacks with primary on top (existing `DialogFooter` is `flex-col-reverse`, so Cancel is last visually in DOM order; keep the primary last in the DOM so it appears on top). Resume text preview is a scroll region with `tabindex=0` and an accessible name. `datetime-local` uses the native picker on phones. The extension popup is desktop-only (browser extension); the phone path is Option 2 without prefill, so the S5 instructions must work without the extension: "Download the resume copy", "copy details from the Review screen" with a Copy button per field (add to S5 as a collapsed "Your details to copy" list; not in the mockup).
- **Keyboard shortcuts**. No new global shortcut. Specifically do not add one for Confirm or "I submitted it" (a shortcut that creates a record or opens the gate undermines deliberateness). `ShortcutsOverlay` is unchanged.

## (h) Edge cases and error states

| Case                                                                     | Design response                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pop-up blocker prevents the new tab                                      | S5 success banner changes to amber: "Your browser blocked the new tab. Open jobs.example.com yourself." with link. State stays Reviewed until the link is used or "I opened it" is pressed.                                                                         |
| User closes the ATS tab or leaves Opportun mid-flow                      | Apply card shows the in-progress state and "Continue". Draft persists. Reviewed expires quietly after 30 min with an expiry message on return; Handed off persists up to 14 days (sweeper) then becomes Abandoned with a note on return.                            |
| Review expires while the user is on the ATS page                         | Handoff is already recorded; expiry only affects Reviewed. The extension payload is fetched at Prefill press time; if refused: popup shows "This review expired. Review again in Opportun." (tone error).                                                           |
| Resume edited after review                                               | The saved copy is unchanged; Opportun shows nothing on the Review page, but the Resume tab gets "A newer version exists. Use it?" only before review. After review the rule is: edits do not silently alter what was reviewed.                                      |
| Network failure on confirm, attest, or snapshot                          | `FormError` in place, state unchanged, text "Nothing was opened" or "Nothing was recorded".                                                                                                                                                                         |
| Attest clicked twice, or from two tabs                                   | Server is idempotent; second shows toast "Already recorded." and navigates to the detail.                                                                                                                                                                           |
| User attests, then realises they did not submit                          | Detail page action "I did not actually submit this" (in an overflow menu, ConfirmDialog) sets state Abandoned and removes the timeline Application entry (it asks first: "Remove the timeline entry too?"). Wording avoids implying anything was undone on the ATS. |
| Confirmation email matches two submissions                               | Not auto-linked; the existing communications review shows a chip "Possible application" and the detail page offers "Link this email".                                                                                                                               |
| Confirmation email wrong or spoofed                                      | Evidence card states basis and has "Not this application (unlink)". Unlink reverts to Submitted.                                                                                                                                                                    |
| Re-apply to a requisition already Submitted or Confirmed                 | Duplicate banner plus mandatory typed reason (Q6 recommended). Daily cap still applies.                                                                                                                                                                             |
| Daily cap reached mid-draft                                              | S4 banner; draft is saved; nothing is lost.                                                                                                                                                                                                                         |
| Feature off, or demo mode                                                | Card absent, no teaser, no route.                                                                                                                                                                                                                                   |
| ATS not recognised, or company with ats_kind but missing `ats_job_ref`   | Not-eligible state with a path to fix (Find posting).                                                                                                                                                                                                               |
| Snapshot export fails permanently (Reactive Resume or local file source) | Could-not-export state with "I will attach it myself"; the Review page and the record show "Resume: you attached it yourself" (no fingerprint).                                                                                                                     |
| Extension on a different tab or host                                     | State C, nothing filled.                                                                                                                                                                                                                                            |
| Screen reader user at Review                                             | Page headings follow the card order; each card is a `section` labelled by its `h3`; the callout is `role="note"`.                                                                                                                                                   |
| Very long answers or URLs                                                | Wrap with `overflow-wrap:anywhere`; previews scroll within a bounded box.                                                                                                                                                                                           |
| Time zones                                                               | Times use the app's `formatDateTime`; the follow-up window is stated as an absolute date on the detail page.                                                                                                                                                        |
| Timeline clutter                                                         | Only one Application entry per submission; Reviewed, Opened, Abandoned and Failed leave no entries.                                                                                                                                                                 |

## (i) Component inventory

| Component                                                 | Reuse or new                                  | Based on                                                                              | Notes                                                                                           |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ApplyPanel                                                | New                                           | `Card` + `NextStepsPanel` placement                                                   | Contains all seven states.                                                                      |
| SubmissionStatusChip                                      | New (thin)                                    | `Badge`                                                                               | Icon size set inside; sr-only prefix.                                                           |
| HowItWorksDialog                                          | New (content only)                            | `Dialog`                                                                              |                                                                                                 |
| ApplyStepper                                              | New                                           | none in app (the first-run tour is the only step UI)                                  | `<ol>` with `aria-current`; not a tablist.                                                      |
| ApplyCallout ("Opportun will not submit this")            | New                                           | styled with `--accent` and `--primary` border                                         | Single use, deliberately distinctive.                                                           |
| SnapshotCard                                              | New                                           | `Card`, `Badge`, `ResumeTextViewer.tsx` for preview                                   | Reuse the text viewer for the scrollable preview.                                               |
| ResumePicker                                              | Reuse                                         | `Select` + options as in `AttachExistingCard`                                         |                                                                                                 |
| DetailsForm, QuestionField                                | New                                           | `Input`, `Textarea`, `Label`, `FormField.tsx`                                         | AI draft block uses existing `SuggestionCard.tsx` style where possible (Accept, Edit, Discard). |
| ReviewGate (cards + acknowledgment)                       | New                                           | `Card`, `Checkbox`, `Button`                                                          | Needs `aria-disabled` button behaviour.                                                         |
| Banners (stale, expired, duplicate, cap, snapshot)        | Reuse                                         | `PostingStateBanner` markup, `FormError`                                              | Extract the amber classes into a small shared `Banner` or copy them; keep identical classes.    |
| HandoffPanel                                              | New                                           | `Card`, `Button`                                                                      |                                                                                                 |
| AttestDialog                                              | New                                           | `Dialog`, `Input`, `Checkbox`, `FormError`                                            | Pattern of `ConfirmDialog` but with a non-destructive primary.                                  |
| StopApplicationDialog, MarkConfirmedDialog, RefusedDialog | Reuse                                         | `ConfirmDialog` (one with a text field: new variant)                                  |                                                                                                 |
| SubmissionDetail, EvidenceBlock, HistoryList              | New                                           | `Card`, `Badge`, `ActivityBody` (collapsible text)                                    |                                                                                                 |
| Timeline entries                                          | Reuse                                         | `TimelineList.tsx` `li`; one added tag line for matched email; link "View submission" | Add an optional kind-specific footer rather than a new list.                                    |
| Next step                                                 | Reuse                                         | `NextStepsPanel`                                                                      |                                                                                                 |
| ApplicationsSettingsCard                                  | New                                           | `Card`, `Input`, `Checkbox`, pattern of `-mailFilters.tsx`                            |                                                                                                 |
| Device token scope option                                 | Reuse                                         | `SCOPES` array in `-devices.tsx`                                                      | One entry plus description.                                                                     |
| Extension popup sections                                  | New (markup/CSS in `popup.html`, `popup.css`) | existing popup tokens, `render.ts` style                                              | New renderer cases follow `renderOutcome`.                                                      |
| Toasts                                                    | Reuse                                         | `toast()`                                                                             | "Application recorded", "Already recorded."                                                     |

No new libraries and no new tokens.

## (j) UX open questions, and what each answer would change

The owner has since answered Q1 to Q8: the [README](README.md#decisions) has each answer, and decision 11 replaced the terms gate in Q4. This section is kept to show what each answer changes. The design assumes the tech lead's recommended answers (Q1 tracked handoff first with optional prefill, Q3 pre-ticked Applied, Q5 ceiling 10, Q6 re-apply with typed reason, Q7 naming "Assisted apply"/"Apply on \<ATS>", Q8 hidden in demo).

1. **Q1 / Q4: Is extension prefill in v1?** (Matters most.) If no prefill ships: S5 becomes the main instruction page, the extension states A to G collapse to just "I submitted this" and "Record confirmation page" (or are dropped), the device-token scope is deferred, and "Copy" buttons for each field become essential. If prefill ships only for some ATSs: S5 and the Apply card must show per-ATS capability ("Prefill is available for Example ATS" vs "Fill the form yourself"), adding a capability line to S1 and S2.
2. **Q3: "I submitted it" moves the stage to Applied?** Pre-ticked checkbox (designed) vs proposal-only. If proposal-only: remove the checkbox from the attest dialog, add an FR-M2 style proposal card in the timeline ("Move to Applied?" Accept/Dismiss), and the Apply card's Done state needs a second line for the pending proposal. Pre-ticked is faster; proposal-only is more conservative and adds a click.
3. **Q5: Review ceiling, and can the user raise it?** The design shows "n of 10" in small text and a limit banner, and lets users only lower it. If the owner wants no visible count at all, S4 loses its footer line and the limit appears only when hit (less transparent, less "volume" feel). If users may raise it, the Settings help text and the instance-ceiling note change, and a raised limit needs a warning line.
4. **Q6: Re-apply policy.** Designed as typed reason. If refuse outright: remove the reason field and the "Apply again..." button; the Done states say "You already applied to this role." If allowed without reason: drop the field but keep the banner.
5. **Q2: Resume file formats.** If only manual attachment for Reactive Resume and local files, "Could not export" becomes the normal state for those sources; the copy "Opportun could not save a PDF" should change to a neutral "Opportun does not save a file for this resume source. Download it yourself and attach it on the application site." so it does not look like an error.
6. **Q7: Naming.** If "Apply on \<ATS>" is rejected for something like "Prepare application", every button label changes but the structure does not. "Submit to ATS" is rejected because it reads as Opportun's action.
7. **Q8: Demo.** If a read-only sample is wanted, the Apply card renders in a sample state with all actions replaced by "Not available in the demo", and the Review page can be viewed but the gate button is absent.

My own additional UX questions for the owner (not in the tech lead list): (a) whether the "reviews today" count should be visible at all, (b) whether the follow-up window (3 days) should be per-company configurable, (c) whether "Dismiss" on No confirmation seen should also mark the next step done (designed: yes).

## (k) What I did not verify

- Not run inside the real app. The mockups are a static replica of the app's tokens, sizes and patterns, written by hand from the source; pixel parity with Tailwind rendering (fonts, focus rings, the shadow-xs inputs) is approximate. The system font stack matches, so rendering should be close.
- Not tested with a screen reader (VoiceOver, NVDA) or with a real keyboard-only pass on a built app. Focus order, announcements, `aria-disabled` behaviour and dialog focus are specified, not observed. The native `<dialog>` behaviours cited come from `components/ui/dialog.tsx` comments, not from running them.
- What I did check in a browser (Chromium via Playwright, served from localhost because `file:` is blocked): the mockup renders at 1280px and 390px, in light and dark via `prefers-color-scheme` emulation; I measured horizontal overflow at 390px (found and fixed overflow, final scroll width 390 = viewport) and computed contrast ratios for badges, muted text, the callout and amber banners in both schemes. I looked at screenshots of the desktop light page and the phone dark page (apply panel, review, status chips, extension popups, dialog). I did not visually inspect every section in every theme/width combination: Timeline, Submission detail, Settings, and Handoff were viewed only via the overflow and structural checks, and the 1280px dark and 390px light combinations were not screenshotted.
- Did not test `prefers-reduced-motion`, forced-colors or 400% zoom; those are design intent. Contrast was measured on the mockup's DOM colours; the extension popup tokens (hex) were not individually measured.
- The browser-extension popup is shown at 320px wide as in `popup.css`; real browser popup chrome, and the Prefill behaviour (which depends on a spike the tech lead flagged), are not designed beyond states.
- Copy was not tested with users and not run through a localisation pass. I did not invoke the separate design skills as tools; the critique, copy and accessibility passes in this document are my own, applying the same lenses (hierarchy and consistency, UX copy rules, WCAG checks).
- I did not check whether `Badge` icons already render at a sensible size elsewhere in the app (`TimelineList.tsx` places lucide icons inside badges without a size class); the new chip sets its own size to be safe.
- The tech lead's "30 minute timer shown" was deliberately changed to a static clock time. The owner adopted this on 2026-11-01 (README decision 9), and Part A section 11.2 now says the same.
