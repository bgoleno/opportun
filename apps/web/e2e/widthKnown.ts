// The views that do not meet the desktop width standard yet (desktop.spec.ts, issue
// https://github.com/bgoleno/opportun/issues/33), with the issue that fixes each and the exact
// findings it excuses. Every other finding on these views still fails, and an excuse that stops
// matching fails too, so this list can only shrink: a fix removes its excuses.
import { line, WIDTHS, type Excuse } from './widthStandard';

/** Running text at reading width across views (W3). */
export const READING_WIDTH = 'https://github.com/bgoleno/opportun/issues/34';
/** The tailoring chat in its own column, capped when stacked (W4). */
export const CHAT_COLUMN = 'https://github.com/bgoleno/opportun/issues/35';

/**
 * Views that do not meet the standard yet, by test title (the route, or a seeded view's name),
 * with the issue that fixes them and the findings that excuses. Taken from the CI run on
 * https://github.com/bgoleno/opportun/pull/52 before this list existed (run 41293141446, the
 * same on both e2e legs): every one is a wrapped line wider than the spec's 80ch limit.
 */
export const KNOWN = new Map<string, { issue: string; excuses: readonly Excuse[] }>([
  // Card descriptions and help text under each card title, at the full page width.
  [
    '/settings/security',
    {
      issue: READING_WIDTH,
      excuses: [line('p', 'After your password, sign-in asks for a code', [1280])],
    },
  ],
  [
    '/settings/ai',
    {
      issue: READING_WIDTH,
      excuses: [
        line('p', 'Costs are estimates from list prices; your', WIDTHS),
        line('p', 'Daily budget: $5.00 per task, measured by', WIDTHS),
        line('p', 'Keys are encrypted at rest and sent only to', WIDTHS),
        line('p', 'Saving creates a new version from the active', [1280, 1536]),
        line('p', 'View and edit the instructions each task', [1280]),
      ],
    },
  ],
  [
    '/settings/integrations',
    {
      issue: READING_WIDTH,
      excuses: [
        line('p', 'Compared with Google Docs, this is lossy', WIDTHS),
        line('p', 'Google lists the Drive permission as access', WIDTHS),
        line('p', 'If Google shows an error while you connect', WIDTHS),
        line('p', 'Optional: keep resumes in your own', WIDTHS),
        line('p', 'Reads recruiter mail into the Inbox, where it', WIDTHS),
        line('p', 'Resumes are Google Docs in your own Drive.', WIDTHS),
        line('p', 'The first sync reads this far back (1 to 1095', WIDTHS),
        line('p', 'The grant goes to your own OAuth client and', WIDTHS),
        line('dd', 'The redirect URI on the client must match the', WIDTHS),
        line('p', 'Tokens for programs on your own devices: the', WIDTHS),
        line('p', 'Written for Reactive Resume 6.0 (its REST API', WIDTHS),
        line('p', 'Apple Mail: not connected. Create a token', [1280]),
        line('p', 'Existing resumes stay in the store they were', [1280]),
        line('p', 'Google has no API for creating OAuth clients', [1280]),
        line('p', 'How tailored copies are named in Drive.', [1280]),
        line('dd', 'The Client ID and secret do not belong to one', [1280]),
        line('dd', 'The Drive, Docs or Gmail API is not enabled', [1280]),
        line('p', 'This server has no built extension to hand', [1280]),
        line('p', 'This window applies to everything Opportun', [1280]),
        line('li', 'Add BOTH redirect URIs to the same client.', [1536, 1920, 2560]),
        line('li', 'FIRST check the project name in the chip at', [1536, 1920, 2560]),
        line('li', 'Leave "Use this client for an AI-powered', [1536, 1920, 2560]),
        line('li', 'Optional: if you also browse Opportun at', [1536, 1920, 2560]),
        line('li', 'The Test users list is NOT in that wizard.', [1536, 1920, 2560]),
        line('li', "When Google's setup wizard asks for the", [1536, 1920, 2560]),
        line('p', 'While the app is in Testing, Google expires', [1536, 1920, 2560]),
        line('dd', 'Your account is not a test user, or you', [1536, 1920, 2560]),
        line('li', 'With several Google accounts signed in', [1536]),
      ],
    },
  ],
  [
    '/settings/mail-filters',
    {
      issue: READING_WIDTH,
      excuses: [
        line('p', 'Mail from these senders is always treated as', WIDTHS),
        line('p', 'Mail outside this label is never fetched, so', WIDTHS),
        line('p', 'Gmail, Outlook, iCloud, ISP addresses and the', [1280]),
        line('p', 'What these rules kept out. Opportun stores', [1280]),
      ],
    },
  ],
  [
    '/settings/data',
    {
      issue: READING_WIDTH,
      excuses: [
        line('p', 'Ask LinkedIn for a copy of your data, then', WIDTHS),
        line('p', 'LinkedIn sends it in two emails: a first', WIDTHS),
        line('p', 'Opportun keeps as little as it can of your', WIDTHS),
        line('p', 'Request your archive on LinkedIn and choose', WIDTHS),
        line('p', 'This changes the live database and cannot be', WIDTHS),
        line('p', 'Upload a zip or a folder with', WIDTHS),
        line('li', '0 discovery results would keep their company', [1280]),
        line('li', '0 stored message bodies would be deleted.', [1280]),
        line('p', 'The server snapshots its database every night', [1280]),
        line('p', 'A zip of everything you own: export.json with', [1536, 1920, 2560]),
      ],
    },
  ],
  [
    '/settings/users',
    {
      issue: READING_WIDTH,
      excuses: [
        line('p', 'Everyone with an account on this instance. A', WIDTHS),
        line('p', 'Let people sign in with Google, GitHub or', WIDTHS),
        line('p', 'LinkedIn Developer portal > My apps: an app', WIDTHS),
        line('p', 'Google Cloud console > APIs & Services >', [1280]),
        line('p', 'This instance stops accepting new accounts', [1280]),
      ],
    },
  ],
  [
    '/settings/jobs',
    {
      issue: READING_WIDTH,
      excuses: [line('p', 'Every background job (Gmail sync', WIDTHS)],
    },
  ],
  // The Deny explanation under each suggested company, until the card grid adds a column.
  [
    '/discovery/companies',
    {
      issue: READING_WIDTH,
      excuses: [line('p', 'Stops new postings from this company reaching', [1280, 1536])],
    },
  ],
  // The job description (Markdown) and a timeline note's body.
  [
    '/opportunities/:id details with a long job description',
    {
      issue: READING_WIDTH,
      excuses: [
        line('p', 'You will own the platform that every product', [1536, 1920, 2560]),
        line('li', 'You will own the platform that every product', [1536, 1920, 2560]),
      ],
    },
  ],
  [
    '/opportunities/:id timeline with a long note',
    {
      issue: READING_WIDTH,
      excuses: [line('p', 'Call with the hiring manager. You will own', [1536, 1920, 2560])],
    },
  ],
  // The chat's messages and a suggestion's rationale. The document text and the match report
  // already wrap at reading width.
  [
    '/resumes/:id with text, a conversation and a match report',
    {
      issue: CHAT_COLUMN,
      excuses: [
        line('p', 'Emphasize the platform work for this role.', WIDTHS),
        line('p', 'You will own the platform that every product', WIDTHS),
        line('p', 'Your platform work maps well to this role.', WIDTHS),
      ],
    },
  ],
]);
