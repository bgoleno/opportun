import { createFileRoute } from '@tanstack/react-router';
import { ContactList } from '@/components/contacts/ContactList';
import { PageHeader } from '@/components/PageHeader';

export const Route = createFileRoute('/contacts/')({
  staticData: { layout: 'fluid' },
  component: ContactsPage,
});

function ContactsPage() {
  return (
    <section>
      <PageHeader
        title="Contacts"
        description="The people in your network, and who could refer you where."
      />
      <ContactList />
    </section>
  );
}
