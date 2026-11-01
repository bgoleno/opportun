import { createFileRoute } from '@tanstack/react-router';
import { NetworkList } from '@/components/network/NetworkList';
import { PageHeader } from '@/components/PageHeader';

export const Route = createFileRoute('/network/')({
  component: NetworkPage,
});

function NetworkPage() {
  return (
    <section>
      <PageHeader
        title="Network"
        description="The people in your network, and who could refer you where."
      />
      <NetworkList />
    </section>
  );
}
