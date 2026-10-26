// The tour definition (FR-U11). Steps are keyed by id, not index, so a reorder cannot corrupt
// saved progress. Each step's variant is chosen from the checklist when the step opens.
import type { Checklist, TourStepId } from '@opportun/core';

export type TourRoute =
  | '/'
  | '/settings/ai'
  | '/settings/integrations'
  | '/inbox'
  | '/pipeline'
  | '/discovery'
  | '/resumes'
  | '/contacts';
export type Placement = 'bottom' | 'top' | 'right' | 'left';

/** What a Do it now does after the tour pauses: go somewhere, then focus the first match. */
export interface DoItNow {
  label: string;
  route: TourRoute;
  search?: Record<string, unknown>;
  /** `[data-tour]` ids in priority order; a disabled control is passed over. */
  focus: string[];
}

export interface StepView {
  title: string;
  body: string;
  /** `[data-tour]` ids in priority order. Empty means a centered step. */
  targets: string[];
  placement?: Placement;
  doItNow?: DoItNow;
  /** A secondary in-card link that pauses the tour the same way (step 3's Apple Mail). */
  altAction?: DoItNow;
  /** Checklist item this step sets up; drives the pill's "that's done" state. */
  item?: 'aiKey' | 'mail' | 'firstOpportunity';
}

export interface TourStep {
  id: TourStepId;
  route?: TourRoute;
  view: (c: Checklist, demo: boolean) => StepView;
}

/** Numbered steps: the welcome screen is not counted (design section 2). */
export const STEP_COUNT = 9;

const allDone = (c: Checklist) => c.aiKey && c.mail && c.firstOpportunity;

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    view: () => ({
      title: "Let's get your search running",
      body: 'Three quick steps turn Opportun from a tracker into an assistant that reads your recruiter mail and fills your pipeline for you. The tour takes about two minutes, and you can do each step as you go.',
      targets: [],
    }),
  },
  {
    id: 'checklist',
    route: '/',
    view: () => ({
      title: 'Three steps to a working search',
      body: "Once Opportun can read your recruiter mail with your AI key, your pipeline starts filling itself. This checklist tracks your progress and stays here until you're done.",
      targets: ['setup-checklist'],
    }),
  },
  {
    id: 'ai-key',
    route: '/settings/ai',
    view: (c, demo) => {
      const done = c.aiKey || demo;
      return {
        title: 'Bring your own AI key',
        body: done
          ? 'Your AI key is in, so mail sorting, ranking and tailoring are on. Every task has a daily budget, so costs stay capped.'
          : 'Opportun uses your Anthropic or OpenAI key to sort mail, rank postings and tailor resumes, and you pay the provider directly. Every task has a daily budget, so costs stay capped.',
        targets: ['ai-provider-keys'],
        item: 'aiKey',
        ...(done
          ? {}
          : { doItNow: { label: 'Add my key', route: '/settings/ai', focus: ['ai-provider'] } }),
      };
    },
  },
  {
    id: 'mail',
    route: '/settings/integrations',
    view: (c, demo) => {
      const done = c.mail || demo;
      return {
        title: 'Let your inbox do the data entry',
        body: done
          ? 'Your mail is connected, and new recruiter mail is sorted every 15 minutes. Opportun never sends, moves or deletes mail.'
          : 'Connect Gmail read-only, and recruiter mail about a new role becomes an opportunity on its own. Opportun never sends, moves or deletes mail.',
        targets: ['gmail-card'],
        item: 'mail',
        ...(done
          ? {}
          : {
              // Gmail needs the Google OAuth client first: the connect button when it is
              // usable, otherwise the Google card above it.
              doItNow: {
                label: 'Set up Gmail',
                route: '/settings/integrations',
                focus: ['gmail-connect', 'google-card'],
              },
              altAction: {
                label: 'Use Apple Mail on a Mac instead',
                route: '/settings/integrations',
                focus: ['devices-card'],
              },
            }),
      };
    },
  },
  {
    id: 'inbox',
    route: '/inbox',
    view: (c, demo) =>
      c.mail || demo
        ? {
            title: 'Mail, sorted and linked for you',
            body: 'Each message is classified, linked to the role it is about, and can suggest a stage move. Anything Opportun is unsure of waits in Needs review.',
            targets: ['inbox-tabs'],
          }
        : {
            title: 'Your mail will land here',
            body: 'Once mail is connected, recruiter messages arrive here sorted and linked to your roles. You can connect from this link at any time.',
            // The connect link is absent when the Gmail status request failed: the tabs then.
            targets: ['inbox-connect', 'inbox-tabs'],
          },
  },
  {
    id: 'first-opportunity',
    route: '/pipeline',
    view: (c, demo) =>
      c.firstOpportunity || demo
        ? {
            title: 'Your pipeline is live',
            body: 'Move a role through its stages by dragging it, or with j/k and single keys. Click a card for its timeline, mail, resume and referrals.',
            targets: ['pipeline-board'],
            item: 'firstOpportunity',
          }
        : {
            title: 'Every role, from first look to offer',
            body: "Opportunities move through stages from New to Offer as you drag them or press a key. Add one you're already pursuing to see it work.",
            targets: ['new-opportunity'],
            item: 'firstOpportunity',
            doItNow: {
              label: 'Add an opportunity',
              route: '/pipeline',
              search: { new: true },
              focus: [],
            },
          },
  },
  {
    id: 'discovery',
    route: '/discovery',
    view: () => ({
      title: 'New roles, ranked for you',
      body: 'Discovery reads company job boards and job alert emails, then scores each posting against your role targets. Accept the good ones and they land in your pipeline.',
      targets: ['discovery-sections'],
    }),
  },
  {
    id: 'resumes',
    route: '/resumes',
    view: () => ({
      title: 'One resume, tailored for every role',
      body: 'Register your Google Doc once, then make a tailored copy for each opportunity with an AI chat that proposes edits. Nothing changes in your document until you apply an edit.',
      targets: ['register-resume', 'resumes-header'],
    }),
  },
  {
    id: 'contacts',
    route: '/contacts',
    view: () => ({
      title: 'See who can refer you',
      body: 'Import your LinkedIn connections, and each opportunity shows who you know at that company. Opportun ranks who is best placed to refer you.',
      targets: ['contacts-list'],
    }),
  },
  {
    id: 'finish',
    route: '/',
    view: (c, demo) =>
      allDone(c) || demo
        ? {
            title: "You're all set",
            body: 'Your pipeline now fills itself from your mail. You can replay this tour any time from this menu.',
            targets: ['account-menu'],
          }
        : {
            title: "You're ready to go",
            body: 'Finish the checklist on your dashboard to switch on the self-filling pipeline. You can replay this tour any time from this menu.',
            targets: ['account-menu'],
          },
  },
];

export const stepIndex = (id: TourStepId): number => TOUR_STEPS.findIndex((s) => s.id === id);

/**
 * Whether a step is passed through silently: only step 1, when the checklist card it points at
 * is hidden (all done, dismissed, or the demo, which has no checklist). The count never changes.
 */
export function isPassedThrough(id: TourStepId, c: Checklist, demo: boolean): boolean {
  return id === 'checklist' && (demo || allDone(c) || c.dismissed);
}

/** The next (dir 1) or previous (dir -1) step that is shown, or null past either end. */
export function neighbour(
  id: TourStepId,
  dir: 1 | -1,
  c: Checklist,
  demo: boolean,
): TourStepId | null {
  for (let i = stepIndex(id) + dir; i >= 0 && i < TOUR_STEPS.length; i += dir) {
    const s = TOUR_STEPS.at(i)!;
    if (s.id === 'welcome') return null;
    if (!isPassedThrough(s.id, c, demo)) return s.id;
  }
  return null;
}
