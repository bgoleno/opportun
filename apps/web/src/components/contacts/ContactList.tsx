// The contacts page (FR-C1): search by name or email, add a contact, open one.
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useHotkeys } from '@/lib/useHotkeys';
import { CONTACTS_PAGE_SIZE, useContacts, useCreateContact, type Contact } from './api';

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

export const SOURCE_LABELS: Record<Contact['source'], string> = {
  manual: 'Added by you',
  linkedin_export: 'LinkedIn export',
  capture: 'Captured',
};

/** The title of the contact's latest history entry at their current company, if any. */
export function currentTitle(c: Contact): string | null {
  const last = c.history.at(-1);
  return last !== undefined &&
    c.currentCompanyName !== null &&
    last.company.toLowerCase() === c.currentCompanyName.toLowerCase()
    ? last.title
    : null;
}

function AddContactCard() {
  const create = useCreateContact();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        ...(company.trim() === '' ? {} : { company: company.trim() }),
        ...(email.trim() === '' ? {} : { emails: [email.trim()] }),
      },
      {
        onSuccess: (c) => {
          setName('');
          setCompany('');
          setEmail('');
          toast({ title: 'Contact added', description: c.name, variant: 'success' });
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a contact</CardTitle>
        <CardDescription>
          Or import your connections from a{' '}
          <Link to="/settings/data" className={linkClass}>
            LinkedIn data export
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor="contact-name">Name</Label>
            <Input
              id="contact-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-company">Company</Label>
            <Input
              id="contact-company"
              value={company}
              maxLength={200}
              onChange={(e) => setCompany(e.currentTarget.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-email">Email</Label>
            <Input
              id="contact-email"
              type="email"
              value={email}
              maxLength={320}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <Button type="submit" disabled={create.isPending || name.trim() === ''}>
            <Plus aria-hidden="true" />
            Add
          </Button>
          {create.error ? (
            <div className="sm:col-span-4">
              <FormError message={errorMessage(create.error)} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Previous/next/first/last through a result set paged at CONTACTS_PAGE_SIZE (issue #207).
 * Keyboard-reachable (the owner's standing ruling: every function reachable from the
 * keyboard), matching the `?` overlay added alongside this. Paging, not infinite scroll or
 * load-more: an alphabetical list this long needs a place to come back to ("281-400 of
 * 1,754" says where you are), and scrolling to accumulate 1,754 rows in the DOM has no
 * upper bound as the contact count grows.
 */
function ContactPager({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  const hasPrev = page > 0;
  const hasNext = page < pageCount - 1;
  useHotkeys({
    n: () => {
      if (hasNext) onPageChange(page + 1);
    },
    p: () => {
      if (hasPrev) onPageChange(page - 1);
    },
    Home: () => {
      if (hasPrev) onPageChange(0);
    },
    End: () => {
      if (hasNext) onPageChange(pageCount - 1);
    },
  });
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Contacts pages" className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        aria-label="First page"
        disabled={!hasPrev}
        onClick={() => onPageChange(0)}
      >
        <ChevronsLeft aria-hidden="true" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        aria-label="Previous page"
        disabled={!hasPrev}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="px-2 text-sm text-muted-foreground">
        Page {page + 1} of {pageCount}
      </span>
      <Button
        variant="outline"
        size="icon"
        aria-label="Next page"
        disabled={!hasNext}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        aria-label="Last page"
        disabled={!hasNext}
        onClick={() => onPageChange(pageCount - 1)}
      >
        <ChevronsRight aria-hidden="true" />
      </Button>
    </nav>
  );
}

export function ContactList() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const contacts = useContacts(q, page);
  const items = contacts.data?.items ?? [];
  const total = contacts.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / CONTACTS_PAGE_SIZE));
  const start = page * CONTACTS_PAGE_SIZE + 1;
  const end = page * CONTACTS_PAGE_SIZE + items.length;

  // A search for a different query starting on whatever page the last one left off on is
  // the failure this ticket calls out by name: page three of an old query, silently showing
  // results for a new one.
  function search(value: string) {
    setQ(value);
    setPage(0);
  }

  function goToPage(next: number) {
    setPage(Math.min(Math.max(next, 0), pageCount - 1));
  }

  return (
    <div className="grid gap-6">
      <AddContactCard />
      <Card data-tour="contacts-list">
        <CardHeader className="gap-3">
          <CardTitle>Your contacts</CardTitle>
          <div className="relative max-w-sm">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            />
            <Input
              aria-label="Search contacts"
              placeholder="Search by name or email"
              className="pl-9"
              value={q}
              maxLength={200}
              onChange={(e) => search(e.currentTarget.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          {contacts.isPending ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : contacts.isError ? (
            <FormError message={errorMessage(contacts.error)} />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {q.trim() === '' ? 'No contacts yet.' : 'No contact matches that search.'}
            </p>
          ) : (
            <Table aria-label="Contacts">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead className="hidden md:table-cell">Email</TableHead>
                  <TableHead className="hidden sm:table-cell">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link to="/contacts/$id" params={{ id: c.id }} className={linkClass}>
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {c.currentCompanyName ?? <span className="text-muted-foreground">None</span>}
                      {currentTitle(c) !== null ? (
                        <span className="block text-xs text-muted-foreground">
                          {currentTitle(c)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden break-all text-muted-foreground md:table-cell">
                      {c.emails[0] ?? ''}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline">{SOURCE_LABELS[c.source]}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {contacts.data !== undefined && items.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Showing {start}–{end} of {total}.
              </p>
              <ContactPager page={page} pageCount={pageCount} onPageChange={goToPage} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
