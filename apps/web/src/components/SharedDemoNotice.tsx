// The shared-account warning (#546, slice 3 of #542; tl and sec's note,
// https://github.com/bgoleno/opportun/issues/542#issuecomment-6875801710, and the owner's
// decisions 3, 132 and 133). Many visitors sign in to each of the demo's shared accounts, so what
// one enters, or one's mail brings in, the others on that account can read until the nightly
// reset. It shows on the shared accounts only: an account made for one person on a demo server is
// a normal one, and sees nothing of this.
import { Notice } from '@/components/apply/parts';
import { useSharedDemoAccount } from '@/components/tour/api';

/** The design note's words, for every place where a visitor enters their own data. */
export const SHARED_DEMO_WARNING =
  'This is a shared demo account. Anything you enter here is visible to others using it, and is cleared at the nightly reset.';

/** Where mail is connected (decision 132: mail stays on the demo), naming email outright. */
export const SHARED_DEMO_MAIL_WARNING =
  'This is a shared demo account. Email that a connected mailbox brings in, with its senders, subjects and text, can be read by everyone signed in to this account until the nightly reset. It can also mark an application on this account confirmed.';

/**
 * Where resumes are stored (#618, decision 133: told, not refused). A Google account connected on
 * a shared account, with the OAuth client saved for it, is everyone's on it: their tailored copies
 * are made in its Drive.
 */
export const SHARED_DEMO_GOOGLE_WARNING =
  'This is a shared demo account. A Google account connected here, with the OAuth client saved for it, is used by everyone signed in to this account until the nightly reset: their resumes are read, copied and edited in its Drive.';

/** A Reactive Resume connected on a shared account receives everyone's new resumes (#618). */
export const SHARED_DEMO_DOCUMENTS_WARNING =
  'This is a shared demo account. A Reactive Resume connected here, with its address and key, is used by everyone signed in to this account until the nightly reset: their new resumes go to it, and Opportun reads and edits theirs in it.';

type About = 'entries' | 'mail' | 'google' | 'documents';

function warningFor(about: About): string {
  switch (about) {
    case 'mail':
      return SHARED_DEMO_MAIL_WARNING;
    case 'google':
      return SHARED_DEMO_GOOGLE_WARNING;
    case 'documents':
      return SHARED_DEMO_DOCUMENTS_WARNING;
    case 'entries':
      return SHARED_DEMO_WARNING;
  }
}

export function SharedDemoNotice({ about = 'entries' }: { about?: About }) {
  const shared = useSharedDemoAccount();
  if (shared !== true) return null;
  return (
    <Notice label="Shared demo account">
      <span>{warningFor(about)}</span>
    </Notice>
  );
}
