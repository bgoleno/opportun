import { createFileRoute, redirect } from '@tanstack/react-router';

// Alias (issue https://github.com/bgoleno/opportun/issues/22): the section was called Contacts
// and lived at /contacts until it was renamed Network. This keeps bookmarks and links saved
// before the rename working. Nothing in the app links here any more, so it can be removed once
// a release note has announced that /contacts stops working.
export const Route = createFileRoute('/contacts/')({
  beforeLoad: () => {
    throw redirect({ to: '/network', replace: true });
  },
});
