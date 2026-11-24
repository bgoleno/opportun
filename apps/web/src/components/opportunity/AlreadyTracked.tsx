// A posting refused because its job is tracked already (https://github.com/bgoleno/opportun/issues/936):
// which opportunity, and the way to it.
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '@/lib/api';

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

/**
 * An error of Find posting, or of attaching a posting, as the user reads it. The shared "That already
 * exists." only when the server names nothing. A name is text from the opportunity: never markup.
 */
export function postingErrorMessage(err: unknown): ReactNode {
  const id =
    err instanceof ApiError && err.code === 'duplicate' ? text(err.details.existingId) : undefined;
  if (!(err instanceof ApiError) || id === undefined) return errorMessage(err);
  const title = text(err.details.existingTitle);
  const company = text(err.details.existingCompany);
  return (
    <>
      This job is already tracked as{' '}
      <Link
        to="/opportunities/$id"
        params={{ id }}
        className="font-medium underline underline-offset-2 [overflow-wrap:anywhere]"
      >
        {/* Unnamed by an older server, or deleted as it was refused. */}
        {title === undefined || company === undefined
          ? 'another opportunity'
          : `${title} at ${company}`}
      </Link>
      .
    </>
  );
}
