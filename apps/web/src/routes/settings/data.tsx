import { createFileRoute } from '@tanstack/react-router';
import { DataSettings } from '@/components/importExport/DataSettings';

export const Route = createFileRoute('/settings/data')({
  component: DataSettings,
});
