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

export function SharedDemoNotice({ about = 'entries' }: { about?: 'entries' | 'mail' }) {
  const shared = useSharedDemoAccount();
  if (shared !== true) return null;
  return (
    <Notice label="Shared demo account">
      <span>{about === 'mail' ? SHARED_DEMO_MAIL_WARNING : SHARED_DEMO_WARNING}</span>
    </Notice>
  );
}
