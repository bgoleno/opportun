// Settings > AI: the switch for the nightly network probe (https://github.com/bgoleno/opportun/issues/296).
// Off unless the user turns it on: nobody clicks for these requests, and the names it tries come
// from where the user's contacts work. The sentence under it is sec's, word for word.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

interface NetworkBoardCheck {
  enabled: boolean;
}

export const networkBoardCheckKey = ['settings', 'network-board-check'] as const;

export const NETWORK_BOARD_CHECK_TEXT =
  'Each night, Opportun looks up to 20 of these companies up on Greenhouse, Lever and Ashby by name. Those services see the names it tries, which come from where your contacts work, and your server’s address. No contact’s name or details are sent.';

export function NetworkBoardCheckCard() {
  const qc = useQueryClient();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const current = useQuery({
    queryKey: networkBoardCheckKey,
    queryFn: () => api<NetworkBoardCheck>('/settings/network-board-check'),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api<NetworkBoardCheck>('/settings/network-board-check', {
        method: 'PUT',
        body: { enabled },
      }),
    onSuccess: (data) => {
      setError(null);
      qc.setQueryData(networkBoardCheckKey, data);
      toast({
        title: data.enabled ? 'Network job boards on' : 'Network job boards off',
        variant: 'success',
      });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Network job boards</CardTitle>
        <CardDescription>
          For companies where you know someone, and that you have not followed or checked.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {current.error ? <FormError message={errorMessage(current.error)} /> : null}
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={current.data?.enabled === true}
            disabled={current.data === undefined || save.isPending}
            onCheckedChange={(c) => save.mutate(c === true)}
            aria-describedby={`${id}-text`}
          />
          <Label htmlFor={id}>Check job boards for companies in my network</Label>
        </div>
        <p id={`${id}-text`} className="text-sm text-muted-foreground">
          {NETWORK_BOARD_CHECK_TEXT}
        </p>
        <FormError message={error} />
      </CardContent>
    </Card>
  );
}
