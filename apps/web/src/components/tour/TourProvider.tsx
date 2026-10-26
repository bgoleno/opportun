// The tour's state machine (FR-U11): welcome, the numbered steps, and the paused pill. Every
// state change is written to the server and awaited before the UI shows it (design principle
// 6): a Skip whose write fails shows a toast and leaves the tour where it was. Progress lives on
// the server, so a pause survives reloads, other devices and the Google OAuth full-page
// redirect a Do it now leads to.
import type { Checklist, TourStepId } from '@opportun/core';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Check, Circle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { doneCount, useOnboarding, usePutTour } from './api';
import { ResumePill } from './ResumePill';
import { neighbour, stepIndex, TOUR_STEPS, type DoItNow } from './steps';
import { TourOverlay, type TourAction } from './TourOverlay';
import { focusFirst, SHEET_QUERY, useMediaQuery, useTourTarget } from './useTourTarget';

type Mode =
  | { kind: 'idle' }
  /** `resumeAt`: a relaunch after a skip or pause past step 1 offers to pick up there. */
  | { kind: 'welcome'; resumeAt: TourStepId | null }
  /** `checklist` is the snapshot the step's variant was chosen from when it opened. */
  | { kind: 'step'; stepId: TourStepId; checklist: Checklist }
  | { kind: 'paused'; stepId: TourStepId };

interface TourCtx {
  /** The account menu's and the checklist's "Take the tour". */
  launch: () => void;
}

const Ctx = createContext<TourCtx | null>(null);

export function useTour(): TourCtx {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useTour must be used inside <TourProvider>');
  return ctx;
}

/** Top-level pages only: never auto-start over /opportunities/$id, /resumes/$id and the like. */
const isTopLevel = (pathname: string) => pathname.split('/').filter(Boolean).length <= 1;

const EMPTY_CHECKLIST: Checklist = {
  aiKey: false,
  mail: false,
  firstOpportunity: false,
  dismissed: false,
  activatedAt: null,
};

export function TourProvider({ children }: { children: ReactNode }) {
  const onboarding = useOnboarding();
  const putTour = usePutTour();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const sheet = useMediaQuery(SHEET_QUERY);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const data = onboarding.data;
  const demo = data?.demo ?? false;
  const checklist = data?.checklist ?? EMPTY_CHECKLIST;

  /** Where the tour itself sent the router; any other location means the user navigated. */
  const expectedPath = useRef<string | null>(null);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  /** Focused before the overlay opened, restored when it closes (section 8). */
  const origin = useRef<Element | null>(null);
  const autoTried = useRef(false);
  const restoredPause = useRef(false);

  // A pause recorded earlier (this tab before a reload, another device, before the OAuth
  // redirect) comes back as the pill.
  useEffect(() => {
    if (restoredPause.current || data === undefined) return;
    restoredPause.current = true;
    const t = data.tour;
    if (t.status === 'paused' && t.stepId !== null && t.stepId !== 'welcome') {
      setMode((m) => (m.kind === 'idle' ? { kind: 'paused', stepId: t.stepId! } : m));
    }
  }, [data]);

  const openWelcome = useCallback((resumeAt: TourStepId | null) => {
    origin.current = document.activeElement;
    expectedPath.current = pathnameRef.current;
    setMode({ kind: 'welcome', resumeAt });
  }, []);

  // Auto-start: once, when the server says so, on a top-level page, after any open dialog.
  useEffect(() => {
    if (autoTried.current || data === undefined || !data.autoStart || mode.kind !== 'idle') return;
    if (!isTopLevel(pathname)) return;
    let timer: number | undefined;
    const tryOpen = () => {
      if (document.querySelector('dialog[open]') !== null) {
        timer = window.setTimeout(tryOpen, 300);
        return;
      }
      autoTried.current = true;
      openWelcome(null);
    };
    tryOpen();
    return () => window.clearTimeout(timer);
  }, [data, mode.kind, pathname, openWelcome]);

  const restoreFocus = useCallback(() => {
    const el = origin.current;
    origin.current = null;
    // After the dialog has closed and the router has settled.
    window.setTimeout(() => {
      if (el instanceof HTMLElement && el.isConnected && el !== document.body) el.focus();
      else document.getElementById('main')?.focus();
    }, 0);
  }, []);

  /** Writes the state, and only then lets the caller change the UI. */
  const record = useCallback(
    async (status: 'in_progress' | 'paused' | 'completed' | 'skipped', stepId: TourStepId) => {
      setBusy(true);
      try {
        await putTour.mutateAsync({ status, stepId });
        return true;
      } catch (err) {
        toast({
          title: 'Could not save the tour',
          description: errorMessage(err),
          variant: 'destructive',
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [putTour],
  );

  const goTo = useCallback(
    async (stepId: TourStepId) => {
      if (!(await record('in_progress', stepId))) return;
      const step = TOUR_STEPS[stepIndex(stepId)]!;
      if (origin.current === null) origin.current = document.activeElement;
      if (step.route !== undefined && step.route !== pathnameRef.current) {
        expectedPath.current = step.route;
        await navigate({ to: step.route });
      }
      expectedPath.current = step.route ?? pathnameRef.current;
      setMode({ kind: 'step', stepId, checklist: onboarding.data?.checklist ?? EMPTY_CHECKLIST });
    },
    [record, navigate, onboarding.data],
  );

  const end = useCallback(
    async (status: 'completed' | 'skipped', stepId: TourStepId) => {
      if (!(await record(status, stepId))) return;
      expectedPath.current = null;
      setMode({ kind: 'idle' });
      restoreFocus();
    },
    [record, restoreFocus],
  );

  const pause = useCallback(
    async (stepId: TourStepId) => {
      if (!(await record('paused', stepId))) return false;
      expectedPath.current = null;
      origin.current = null;
      setMode({ kind: 'paused', stepId });
      return true;
    },
    [record],
  );

  const doItNow = useCallback(
    async (action: DoItNow, stepId: TourStepId) => {
      // Awaited before anything moves: Set up Gmail leads to a full-page redirect to Google,
      // and the pill must be there when the user comes back.
      if (!(await pause(stepId))) return;
      await navigate({ to: action.route, ...(action.search ? { search: action.search } : {}) });
      await focusFirst(action.focus, sheet);
    },
    [pause, navigate, sheet],
  );

  // The user navigated during a running tour (browser back, say): pause rather than drag them
  // back. A welcome screen that has recorded nothing just closes.
  useEffect(() => {
    if (busy || expectedPath.current === null || pathname === expectedPath.current) return;
    if (mode.kind === 'step') void pause(mode.stepId);
    else if (mode.kind === 'welcome') {
      expectedPath.current = null;
      setMode({ kind: 'idle' });
    }
  }, [pathname, mode, busy, pause]);

  const launch = useCallback(() => {
    if (mode.kind === 'welcome' || mode.kind === 'step') return;
    const t = onboarding.data?.tour;
    let resumeAt: TourStepId | null = null;
    if (
      t !== undefined &&
      (t.status === 'skipped' || t.status === 'paused') &&
      t.stepId !== null &&
      stepIndex(t.stepId) > stepIndex('checklist')
    ) {
      // A pause resumes after the step that paused it, as the pill does.
      resumeAt =
        t.status === 'paused' ? (neighbour(t.stepId, 1, checklist, demo) ?? t.stepId) : t.stepId;
    }
    openWelcome(resumeAt);
  }, [mode.kind, onboarding.data, checklist, demo, openWelcome]);

  const stepMode = mode.kind === 'step' ? mode : null;
  const step = stepMode === null ? null : TOUR_STEPS[stepIndex(stepMode.stepId)]!;
  const view = stepMode === null || step === null ? null : step.view(stepMode.checklist, demo);
  const target = useTourTarget(
    view?.targets ?? [],
    stepMode !== null,
    stepMode?.stepId ?? '',
    sheet,
  );

  let overlay: ReactNode = null;
  if (mode.kind === 'welcome') {
    const first = neighbour('welcome', 1, checklist, demo) ?? 'ai-key';
    const resumeAt = mode.resumeAt;
    const actions: TourAction[] =
      resumeAt === null
        ? [
            { label: 'Not now', variant: 'outline', onClick: () => void end('skipped', 'welcome') },
            {
              label: 'Start the tour',
              variant: 'default',
              initialFocus: true,
              onClick: () => void goTo(first),
            },
          ]
        : [
            { label: 'Start over', variant: 'outline', onClick: () => void goTo(first) },
            {
              label: `Resume at step ${stepIndex(resumeAt)}`,
              variant: 'default',
              initialFocus: true,
              onClick: () => void goTo(resumeAt),
            },
          ];
    const welcome = TOUR_STEPS[0]!.view(checklist, demo);
    overlay = (
      <TourOverlay
        open
        target={null}
        searching={false}
        sheet={sheet}
        step={null}
        stepKey="welcome"
        title={welcome.title}
        body={
          demo
            ? 'This demo is already set up with sample data, so you can see Opportun working right away. The tour takes about two minutes.'
            : welcome.body
        }
        extra={demo ? undefined : <WelcomeItems checklist={checklist} />}
        actions={actions}
        onNext={actions[1]!.onClick}
        // Closing a relaunch keeps the step it would have resumed at.
        onSkip={() => void end('skipped', onboarding.data?.tour.stepId ?? 'welcome')}
        busy={busy}
      />
    );
  } else if (stepMode !== null && step !== null && view !== null) {
    const id = stepMode.stepId;
    const next = neighbour(id, 1, stepMode.checklist, demo);
    const prev = neighbour(id, -1, stepMode.checklist, demo);
    const onNext = () => void (next === null ? end('completed', id) : goTo(next));
    const onBack = prev === null ? undefined : () => void goTo(prev);
    const actions: TourAction[] = [];
    if (onBack !== undefined) actions.push({ label: 'Back', variant: 'outline', onClick: onBack });
    if (view.doItNow !== undefined) {
      const action = view.doItNow;
      actions.push({
        label: action.label,
        variant: 'default',
        initialFocus: true,
        onClick: () => void doItNow(action, id),
      });
    }
    actions.push({
      label: next === null ? 'Done' : 'Next',
      variant: view.doItNow === undefined ? 'default' : 'outline',
      initialFocus: view.doItNow === undefined,
      onClick: onNext,
    });
    const alt = view.altAction;
    overlay = (
      <TourOverlay
        open
        target={target.el}
        searching={target.status === 'searching'}
        sheet={sheet}
        placement={view.placement}
        step={stepIndex(id)}
        stepKey={id}
        title={view.title}
        body={view.body}
        extra={
          alt === undefined ? undefined : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void doItNow(alt, id)}
              className="justify-self-start text-sm text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {alt.label}
            </button>
          )
        }
        actions={actions}
        onNext={onNext}
        onBack={onBack}
        onSkip={() => void end('skipped', id)}
        busy={busy}
      />
    );
  }

  let pill: ReactNode = null;
  if (mode.kind === 'paused') {
    const id = mode.stepId;
    const item = TOUR_STEPS[stepIndex(id)]!.view(checklist, demo).item;
    pill = (
      <ResumePill
        step={stepIndex(id)}
        done={item !== undefined && checklist[item]}
        busy={busy}
        onResume={() => {
          origin.current = document.activeElement;
          const next = neighbour(id, 1, checklist, demo);
          void (next === null ? end('completed', id) : goTo(next));
        }}
        onDismiss={() => void end('skipped', id)}
      />
    );
  }

  return (
    <Ctx.Provider value={{ launch }}>
      {children}
      {overlay}
      {pill}
    </Ctx.Provider>
  );
}

/** The welcome screen's view of the three setup items, with their current ticks. */
function WelcomeItems({ checklist }: { checklist: Checklist }) {
  const items = [
    ['Add your AI key', checklist.aiKey],
    ['Connect your mail', checklist.mail],
    ['Get your first opportunity', checklist.firstOpportunity],
  ] as const;
  return (
    <ul aria-label={`Setup: ${doneCount(checklist)} of 3 done`} className="grid gap-1.5 text-sm">
      {items.map(([label, done]) => (
        <li key={label} className="flex items-center gap-2">
          {done ? (
            <Check aria-hidden="true" className="size-4 text-success" />
          ) : (
            <Circle aria-hidden="true" className="size-4 text-muted-foreground" />
          )}
          <span>{label}</span>
          <span className="sr-only">{done ? '(done)' : '(not done)'}</span>
        </li>
      ))}
    </ul>
  );
}
