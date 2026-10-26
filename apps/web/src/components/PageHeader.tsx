import type { ReactNode } from 'react';

export function PageHeader(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** A first-run tour target (components/tour/steps.ts). */
  tourId?: string;
}) {
  return (
    <div data-tour={props.tourId} className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
        {props.description ? (
          <p className="text-sm text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? <div className="flex items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}
