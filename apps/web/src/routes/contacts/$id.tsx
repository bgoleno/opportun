import { createFileRoute } from '@tanstack/react-router';
import { ContactDetail } from '@/components/contacts/ContactDetail';

export const Route = createFileRoute('/contacts/$id')({
  component: ContactPage,
});

function ContactPage() {
  const { id } = Route.useParams();
  // Keyed so switching contacts resets the edit form.
  return <ContactDetail key={id} id={id} />;
}
