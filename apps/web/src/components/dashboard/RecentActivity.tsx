import { Link } from '@tanstack/react-router';
import { ArrowRightLeft, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, timelineSummary, type TimelineItem } from '@/lib/opportunities';

export function RecentActivity({ items }: { items: TimelineItem[] }) {
  return (
    <Card aria-labelledby="dash-activity" role="region">
      <CardHeader>
        <CardTitle id="dash-activity">Recent activity</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="grid gap-3">
            {items.map((item) => {
              const Icon = item.kind === 'stage' ? ArrowRightLeft : MessageSquare;
              return (
                <li key={`${item.kind}-${item.id}`} className="flex items-start gap-3">
                  <Icon
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-sm">{timelineSummary(item)}</span>
                    <Link
                      to="/opportunities/$id"
                      params={{ id: item.opportunityId }}
                      className="truncate text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                    >
                      {item.opportunityTitle}
                    </Link>
                  </div>
                  <time
                    dateTime={new Date(item.occurredAt).toISOString()}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {formatDateTime(item.occurredAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
