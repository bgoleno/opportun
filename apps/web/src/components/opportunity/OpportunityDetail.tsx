import { Link } from '@tanstack/react-router';
import { ArrowLeft, Merge, MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { MainWithRail } from '@/components/MainWithRail';
import { CommunicationsTab } from '@/components/comms/CommunicationsTab';
import { ReferralsTab } from '@/components/network/ReferralsTab';
import { FormError } from '@/components/FormError';
import { OpportunityResumeTab } from '@/components/resume/OpportunityResumeTab';
import { useStageFlow } from '@/components/stage/useStageFlow';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api';
import { priorityLabel } from '@/lib/opportunities';
import { ActivityComposer } from './ActivityComposer';
import { useOpportunity, useUpdateOpportunity } from './api';
import { ApplyPanel } from '@/components/apply/ApplyPanel';
import { CompanyLink } from './CompanyLink';
import { DetailsPanel } from './DetailsPanel';
import { MergeDialog } from './MergeDialog';
import { NextStepsPanel } from './NextStepsPanel';
import { PossibleDuplicateBanner } from './PossibleDuplicateBanner';
import { StageControl } from './StageControl';
import { TimelineList } from './TimelineList';

/** The opportunity page's tabs, in order; one of them can be named in the URL (#428). */
export const OPPORTUNITY_TABS = [
  'timeline',
  'details',
  'resume',
  'communications',
  'referrals',
] as const;
export type OpportunityTab = (typeof OPPORTUNITY_TABS)[number];

const isTab = (v: string): v is OpportunityTab =>
  (OPPORTUNITY_TABS as readonly string[]).includes(v);

export function OpportunityDetail({
  id,
  tab,
  onTabChange,
}: {
  id: string;
  /** The tab to show, from the URL (#428); Timeline when none is given. */
  tab?: OpportunityTab;
  /** Told when the user picks another tab, so the URL can follow. */
  onTabChange?: (tab: OpportunityTab) => void;
}) {
  const { data: opp, error, isPending } = useOpportunity(id);
  const update = useUpdateOpportunity(id);
  const flow = useStageFlow();
  const [merging, setMerging] = useState(false);
  // The URL's tab when given, followed when it changes (a link to ?tab=resume on this page).
  const [picked, setPicked] = useState<OpportunityTab>(tab ?? 'timeline');
  const [shownFor, setShownFor] = useState(tab);
  if (tab !== shownFor) {
    setShownFor(tab);
    setPicked(tab ?? 'timeline');
  }
  const current = picked;
  // Radix reports a click's tab on mousedown and again on focus, both before the next render:
  // the last tab told is kept here, so the URL is told once.
  const told = useRef<OpportunityTab>(picked);
  told.current = picked;
  const changeTab = (v: string) => {
    if (!isTab(v) || v === told.current) return;
    told.current = v;
    setPicked(v);
    onTabChange?.(v);
  };

  if (error) {
    return (
      <section className="grid gap-4">
        <BackLink />
        <FormError message={errorMessage(error)} />
      </section>
    );
  }
  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    // grid-cols-1 on these grids keeps a long company or title from widening the track past the
    // screen (a bare grid's auto track grows to the widest child's min-content).
    <section className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-3">
        <BackLink />
        <PossibleDuplicateBanner opp={opp} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <CompanyLink
              name={opp.companyName}
              domain={opp.companyDomain}
              className="text-sm font-medium text-muted-foreground"
            />
            <h1 className="text-2xl font-semibold tracking-tight">{opp.title}</h1>
            {opp.location ? <p className="text-sm text-muted-foreground">{opp.location}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StageControl opp={opp} flow={flow} />
            <div className="flex items-center gap-2">
              <label htmlFor="opportunity-priority" className="text-sm text-muted-foreground">
                Priority
              </label>
              <div className="w-28">
                <Select
                  id="opportunity-priority"
                  value={String(opp.priority)}
                  disabled={update.isPending}
                  onChange={(e) =>
                    update.mutate(
                      { priority: Number(e.currentTarget.value) },
                      {
                        onError: (err) =>
                          toast({
                            title: 'Priority not changed',
                            description: errorMessage(err),
                            variant: 'destructive',
                          }),
                      },
                    )
                  }
                >
                  {[1, 2, 3].map((p) => (
                    <option key={p} value={p}>
                      {priorityLabel(p)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="More actions">
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>More actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setMerging(true)}>
                  <Merge aria-hidden="true" />
                  Merge into...
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <Tabs value={current} onValueChange={changeTab}>
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="resume">Resume</TabsTrigger>
          <TabsTrigger value="communications">Communications</TabsTrigger>
          <TabsTrigger value="referrals">Referrals</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="pt-2">
          <MainWithRail>
            <div className="grid content-start gap-4">
              <ActivityComposer opportunityId={opp.id} />
              <TimelineList opportunityId={opp.id} />
            </div>
            {/* The rail: assisted apply first (it renders nothing where the feature is off). */}
            <div className="grid content-start gap-4">
              <ApplyPanel opp={opp} />
              <NextStepsPanel opportunityId={opp.id} />
            </div>
          </MainWithRail>
        </TabsContent>
        <TabsContent value="details" className="pt-2">
          <DetailsPanel opp={opp} />
        </TabsContent>
        <TabsContent value="resume" className="pt-2">
          <OpportunityResumeTab opportunityId={opp.id} />
        </TabsContent>
        <TabsContent value="communications" className="pt-2">
          <CommunicationsTab opportunityId={opp.id} />
        </TabsContent>
        <TabsContent value="referrals" className="pt-2">
          <ReferralsTab opportunityId={opp.id} companyName={opp.companyName} />
        </TabsContent>
      </Tabs>
      {flow.dialogs}
      <MergeDialog opp={opp} open={merging} onOpenChange={setMerging} />
    </section>
  );
}

function BackLink() {
  return (
    <Link
      to="/pipeline"
      className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Pipeline
    </Link>
  );
}
