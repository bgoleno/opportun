import { ExternalLink } from 'lucide-react';
import { companyHomepageUrl } from '@/lib/opportunities';
import { cn } from '@/lib/utils';

/**
 * A company's name, linked to its homepage once one is confidently resolved (issue #239) and
 * plain text otherwise -- no empty-link affordance while it is unknown, which is most of the
 * time today. `onPointerDown` stops propagation so this works inside a draggable pipeline card
 * (KanbanCard's own article carries the drag listeners) the same way its other interactive
 * children already do; it is a harmless no-op anywhere else.
 */
export function CompanyLink({
  name,
  domain,
  className,
}: {
  name: string;
  domain: string | null | undefined;
  className?: string;
}) {
  const href = companyHomepageUrl(domain);
  if (href === null) {
    return <span className={className}>{name}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onPointerDown={(e) => e.stopPropagation()}
      className={cn('inline-flex items-center gap-1 underline underline-offset-2', className)}
    >
      {name}
      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
  );
}
