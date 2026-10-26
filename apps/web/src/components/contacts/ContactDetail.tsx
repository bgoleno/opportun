// One contact (FR-C1, C4): edit their details, see their company history and every referral
// ask made of them. The LinkedIn URL is metadata: a link the user may open, never fetched.
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate, safeHttpUrl } from '@/lib/opportunities';
import {
  useContact,
  useDeleteContact,
  useUpdateContact,
  type ContactDetail as ContactDetailData,
} from './api';
import { SOURCE_LABELS } from './ContactList';
import { ReferralStatusBadge } from './ReferralsTab';

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

function EditForm({ contact }: { contact: ContactDetailData }) {
  const update = useUpdateContact(contact.id);
  const [name, setName] = useState(contact.name);
  const [company, setCompany] = useState(contact.currentCompanyName ?? '');
  const [emails, setEmails] = useState(contact.emails.join(', '));
  const [linkedinUrl, setLinkedinUrl] = useState(contact.linkedinUrl ?? '');
  const [strength, setStrength] = useState(
    contact.strength === null ? '' : String(contact.strength),
  );
  const [tags, setTags] = useState(contact.tags.join(', '));
  const [notes, setNotes] = useState(contact.notes ?? '');

  function submit(e: FormEvent) {
    e.preventDefault();
    update.mutate(
      {
        name: name.trim(),
        company: company.trim() === '' ? null : company.trim(),
        emails: splitList(emails),
        linkedinUrl: linkedinUrl.trim() === '' ? null : linkedinUrl.trim(),
        strength: strength === '' ? null : Number(strength),
        tags: splitList(tags),
        notes,
      },
      { onSuccess: () => toast({ title: 'Contact saved', variant: 'success' }) },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="c-name">Name</Label>
          <Input
            id="c-name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="c-company">Current company</Label>
          <Input
            id="c-company"
            value={company}
            maxLength={200}
            onChange={(e) => setCompany(e.currentTarget.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="c-emails">Emails (comma separated)</Label>
          <Input id="c-emails" value={emails} onChange={(e) => setEmails(e.currentTarget.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="c-linkedin">LinkedIn profile URL</Label>
          <Input
            id="c-linkedin"
            type="url"
            value={linkedinUrl}
            maxLength={2048}
            onChange={(e) => setLinkedinUrl(e.currentTarget.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="c-strength">How well you know them</Label>
          <Select
            id="c-strength"
            value={strength}
            onChange={(e) => setStrength(e.currentTarget.value)}
          >
            <option value="">Not set</option>
            <option value="1">1: acquaintance</option>
            <option value="2">2: know well</option>
            <option value="3">3: close</option>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="c-tags">Tags (comma separated)</Label>
          <Input id="c-tags" value={tags} onChange={(e) => setTags(e.currentTarget.value)} />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="c-notes">Notes</Label>
        <Textarea
          id="c-notes"
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
      </div>
      {update.error ? <FormError message={errorMessage(update.error)} /> : null}
      <div>
        <Button type="submit" disabled={update.isPending || name.trim() === ''}>
          {update.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

export function ContactDetail({ id }: { id: string }) {
  const { data: contact, error, isPending } = useContact(id);
  const remove = useDeleteContact(id);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  const back = (
    <Link
      to="/contacts"
      className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Contacts
    </Link>
  );
  if (error) {
    return (
      <section className="grid gap-4">
        {back}
        <FormError message={errorMessage(error)} />
      </section>
    );
  }
  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;

  const profile = safeHttpUrl(contact.linkedinUrl);
  return (
    <section className="grid gap-6">
      <div className="grid gap-3">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{contact.name}</h1>
            <p className="text-sm text-muted-foreground">
              {contact.currentCompanyName ?? 'No current company'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{SOURCE_LABELS[contact.source]}</Badge>
              {contact.tags.map((t) => (
                <Badge key={t} variant="secondary">
                  {t}
                </Badge>
              ))}
              {profile !== null ? (
                <a
                  href={profile}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className={linkClass}
                >
                  <ExternalLink className="mr-1 inline size-3.5" aria-hidden="true" />
                  LinkedIn profile
                </a>
              ) : null}
            </div>
          </div>
          <Button variant="outline" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <EditForm key={contact.updatedAt} contact={contact} />
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Referral asks</CardTitle>
            </CardHeader>
            <CardContent>
              {contact.referrals.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet. Ask from an opportunity's Referrals tab.
                </p>
              ) : (
                <ul className="grid gap-2" aria-label="Referral asks">
                  {contact.referrals.map((r) => (
                    <li
                      key={r.activityId}
                      className="flex items-start justify-between gap-2 text-sm"
                    >
                      <div className="grid">
                        <Link
                          to="/opportunities/$id"
                          params={{ id: r.opportunityId }}
                          className={linkClass}
                        >
                          {r.opportunityTitle}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {r.companyName}, {formatDate(r.occurredAt)}
                        </span>
                      </div>
                      <ReferralStatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              {contact.history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No company history recorded.</p>
              ) : (
                <ol className="grid gap-2 text-sm" aria-label="Company history">
                  {[...contact.history].reverse().map((h, i) => (
                    <li key={`${h.company}-${i}`}>
                      <span className="font-medium">{h.company}</span>
                      {h.title !== null ? (
                        <span className="text-muted-foreground">, {h.title}</span>
                      ) : null}
                      {h.from !== null || h.to !== null ? (
                        <span className="block text-xs text-muted-foreground">
                          {[h.from, h.to].filter((x) => x !== null).join(' to ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this contact?"
        description="Their referral asks stay on each opportunity's timeline."
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
            toast({ title: 'Contact deleted', description: contact.name });
            await navigate({ to: '/contacts' });
          } catch (err) {
            toast({ title: 'Not deleted', description: errorMessage(err), variant: 'destructive' });
          }
        }}
      />
    </section>
  );
}
