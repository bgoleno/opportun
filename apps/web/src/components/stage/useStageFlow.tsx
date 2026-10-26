// One place for every stage change in the UI: validates the move against the core state
// machine (plus the server's explicit-reopen rule), asks for a reason before closing or
// dismissing, keeps an optimistic override while the request is in flight and snaps back
// with the server's message when it fails.
import type { OpportunityStage } from '@opportun/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import {
  changeStage,
  isTerminal,
  qk,
  reopenTargets,
  stageLabel,
  stageTargets,
  type OpportunityView,
  type Page,
  type StageChange,
} from '@/lib/opportunities';
import { StageReasonDialog, type ReasonKind, type ReasonResult } from './StageReasonDialog';

export type StageSubject = Pick<OpportunityView, 'id' | 'stage' | 'title' | 'companyName'>;

export interface StageFlow {
  /** Asks to move `opp` to `to`; closed and dismissed open the reason dialog first. */
  request: (opp: StageSubject, to: OpportunityStage) => void;
  /** Explicit reopen out of closed or dismissed (sends reopen: true). */
  reopen: (opp: StageSubject, to: OpportunityStage) => void;
  /** Opens the dismiss dialog for `opp`. */
  dismiss: (opp: StageSubject) => void;
  /** Stage to display for opportunities with a move in flight. */
  overrides: ReadonlyMap<string, OpportunityStage>;
  /** Render once; holds the reason dialog. */
  dialogs: ReactNode;
}

export function subjectLabel(opp: Pick<StageSubject, 'companyName' | 'title'>): string {
  return `${opp.companyName}: ${opp.title}`;
}

export function useStageFlow(): StageFlow {
  const qc = useQueryClient();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, OpportunityStage>>(new Map());
  const [pendingReason, setPendingReason] = useState<{
    kind: ReasonKind;
    opp: StageSubject;
  } | null>(null);

  const mutation = useMutation({
    mutationFn: (v: { id: string; change: StageChange }) => changeStage(v.id, v.change),
    onMutate: ({ id, change }) => setOverrides((o) => new Map(o).set(id, change.to)),
    onSuccess: (updated) => {
      qc.setQueriesData<Page<OpportunityView>>({ queryKey: qk.opportunities }, (old) =>
        old === undefined
          ? old
          : { ...old, items: old.items.map((o) => (o.id === updated.id ? updated : o)) },
      );
      qc.setQueryData(qk.opportunity(updated.id), updated);
    },
    onError: (err) =>
      toast({ title: 'Stage not changed', description: errorMessage(err), variant: 'destructive' }),
    onSettled: async (_data, _err, { id }) => {
      setOverrides((o) => {
        const next = new Map(o);
        next.delete(id);
        return next;
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.opportunities }),
        qc.invalidateQueries({ queryKey: qk.opportunity(id) }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
      ]);
    },
  });
  const { mutate } = mutation;

  const send = useCallback((id: string, change: StageChange) => mutate({ id, change }), [mutate]);

  const request = useCallback(
    (opp: StageSubject, to: OpportunityStage) => {
      if (opp.stage === to) return;
      if (!stageTargets(opp.stage).includes(to)) {
        toast({
          title: 'Stage not changed',
          description:
            isTerminal(opp.stage) && !isTerminal(to)
              ? `Use Reopen to move a ${stageLabel(opp.stage).toLowerCase()} opportunity back to ${stageLabel(to)}.`
              : `${stageLabel(opp.stage)} cannot move to ${stageLabel(to)}.`,
          variant: 'destructive',
        });
        return;
      }
      if (to === 'closed' || to === 'dismissed') {
        setPendingReason({ kind: to, opp });
        return;
      }
      send(opp.id, { to });
    },
    [send],
  );

  const reopen = useCallback(
    (opp: StageSubject, to: OpportunityStage) => {
      if (!reopenTargets(opp.stage).includes(to)) return;
      send(opp.id, { to, reopen: true });
    },
    [send],
  );

  const dismiss = useCallback((opp: StageSubject) => request(opp, 'dismissed'), [request]);

  function confirmReason(result: ReasonResult) {
    if (pendingReason === null) return;
    const { opp } = pendingReason;
    const note = result.note === undefined ? {} : { note: result.note };
    // Closes only once the server confirms (#124): closing on submit, before the request even
    // went out, told the person it worked before anything happened. onError leaves the dialog
    // open (the mutation's own onError still toasts) rather than close as if it had succeeded.
    mutate(
      {
        id: opp.id,
        change:
          result.kind === 'closed'
            ? { to: 'closed', closedReason: result.reason, ...note }
            : { to: 'dismissed', dismissedReason: result.reason, ...note },
      },
      { onSuccess: () => setPendingReason(null) },
    );
  }

  const dialogs = (
    <StageReasonDialog
      kind={pendingReason?.kind ?? null}
      subject={pendingReason ? subjectLabel(pendingReason.opp) : ''}
      pending={mutation.isPending}
      onCancel={() => setPendingReason(null)}
      onConfirm={confirmReason}
    />
  );

  return { request, reopen, dismiss, overrides, dialogs };
}
