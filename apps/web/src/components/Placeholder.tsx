import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from './PageHeader';

/** Stand-in for screens a later task builds. */
export function Placeholder(props: { title: string; description: string }) {
  return (
    <section>
      <PageHeader title={props.title} description={props.description} />
      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground">This area is coming soon.</p>
        </CardContent>
      </Card>
    </section>
  );
}
