import { createFileRoute, redirect } from '@tanstack/react-router';

// Alias (issue https://github.com/bgoleno/opportun/issues/22): a contact's page lived at
// /contacts/$id until the section was renamed Network. This keeps bookmarks and links saved
// before the rename working. Nothing in the app links here any more, so it can be removed once
// a release note has announced that /contacts stops working.
export const Route = createFileRoute('/contacts/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/network/$id', params: { id: params.id }, replace: true });
  },
});
