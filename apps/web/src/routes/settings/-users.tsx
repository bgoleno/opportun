// Settings > Users (admins only): every account on the instance, the password reset of last
// resort (it also turns off the account's two-factor sign-in), and the registration toggle.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { api, errorMessage } from '@/lib/api';
import { relativeTime } from './-devices';

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}

const usersQuery = {
  queryKey: ['admin', 'users'] as const,
  queryFn: () => api<{ items: AdminUser[] }>('/admin/users'),
};
const registrationQuery = {
  queryKey: ['admin', 'registration'] as const,
  queryFn: () => api<{ open: boolean }>('/admin/registration'),
};

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function UsersCard({ currentUserId }: { currentUserId: string }) {
  const qc = useQueryClient();
  const users = useQuery(usersQuery);
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [issued, setIssued] = useState<{ user: AdminUser; password: string } | null>(null);

  async function reset(u: AdminUser) {
    try {
      const res = await api<{ temporaryPassword: string }>(
        `/admin/users/${encodeURIComponent(u.id)}/reset-password`,
        { method: 'POST' },
      );
      setIssued({ user: u, password: res.temporaryPassword });
      void qc.invalidateQueries({ queryKey: usersQuery.queryKey });
    } catch (err) {
      toast({
        title: 'Could not reset the password',
        description: errorMessage(err),
        variant: 'destructive',
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <CardDescription>
          Everyone with an account on this instance. A password reset is the recovery of last
          resort: it also turns off two-factor sign-in for someone who lost their authenticator and
          recovery codes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {users.isError ? <FormError message={errorMessage(users.error)} /> : null}
        {users.data === undefined ? null : (
          <Table aria-label="Accounts">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Two-factor</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.displayName}</TableCell>
                  <TableCell className="break-all">{u.email}</TableCell>
                  <TableCell>
                    {u.isAdmin ? (
                      <Badge>Administrator</Badge>
                    ) : (
                      <Badge variant="secondary">Member</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {u.totpEnabled ? (
                      <Badge variant="success">2FA on</Badge>
                    ) : (
                      <Badge variant="outline">2FA off</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {dateFmt.format(new Date(u.createdAt))}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {u.lastSeenAt === null ? 'Never' : relativeTime(u.lastSeenAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {u.id === currentUserId ? null : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Reset password for ${u.displayName}`}
                        onClick={() => setTarget(u)}
                      >
                        Reset password
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={`Reset password for ${target?.displayName ?? ''}?`}
        description="This sets a new temporary password, signs them out everywhere, revokes their device tokens and turns off their two-factor sign-in. You will see the temporary password once, to hand over yourself."
        confirmLabel="Reset password"
        onConfirm={async () => {
          if (target !== null) await reset(target);
        }}
      />
      {issued === null ? null : (
        <TemporaryPasswordDialog
          user={issued.user}
          password={issued.password}
          onDone={() => setIssued(null)}
        />
      )}
    </Card>
  );
}

/** The temporary password, shown once: closing the dialog forgets it. */
function TemporaryPasswordDialog(props: { user: AdminUser; password: string; onDone: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.password);
      toast({ title: 'Temporary password copied', variant: 'success' });
    } catch {
      toast({ title: 'Copy failed', description: 'Select the text and copy it instead.' });
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onDone();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Temporary password</DialogTitle>
          <DialogDescription>
            Give this to {props.user.displayName} over a channel you trust. It is not stored or
            shown again; they should change it under Settings, Security after signing in.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="temporary-password">
            Temporary password for {props.user.displayName}
          </Label>
          <div className="flex gap-2">
            <Input
              id="temporary-password"
              readOnly
              value={props.password}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Copy temporary password"
              onClick={() => void copy()}
            >
              <Copy className="size-4" aria-hidden="true" />
              Copy
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={props.onDone}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RegistrationCard() {
  const qc = useQueryClient();
  const state = useQuery(registrationQuery);
  const [busy, setBusy] = useState(false);

  async function set(next: boolean) {
    setBusy(true);
    try {
      const res = await api<{ open: boolean }>('/admin/registration', {
        method: 'PATCH',
        body: { open: next },
      });
      qc.setQueryData(registrationQuery.queryKey, res);
      toast({
        title: res.open ? 'Registration opened' : 'Registration closed',
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'Could not change registration',
        description: errorMessage(err),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }

  const open = state.data?.open;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Registration</CardTitle>
        <CardDescription>
          This instance stops accepting new accounts after the first one. Open registration to let
          someone sign up, then close it again.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {open === undefined ? null : (
          <>
            <p role="status" className="text-sm text-muted-foreground">
              Registration is {open ? 'open' : 'closed'}.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void set(!open)}>
              {open ? 'Close registration' : 'Open registration'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
