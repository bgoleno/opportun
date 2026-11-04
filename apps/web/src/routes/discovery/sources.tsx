import { createFileRoute } from '@tanstack/react-router';
import { SourcesManager } from '@/components/discovery/SourcesManager';
import { SourceVolume } from '@/components/discovery/SourceVolume';

export const Route = createFileRoute('/discovery/sources')({
  component: SourcesPage,
});

/** The sources, then each board's posting volume and ranking cost (#209). */
function SourcesPage() {
  return (
    <div className="grid gap-6">
      <SourcesManager />
      <SourceVolume />
    </div>
  );
}
