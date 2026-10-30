// Settings -> Mail filters (spec D7). Its own page rather than a panel under Integrations:
// these rules decide what Opportun is allowed to look at, which is what a cautious user wants
// to find and audit first.
//
// The page reads in the order the spec sets, strongest control first: what is fetched at all,
// then the user's own lists, then rule 4's pass list, then the tester, then what was kept out.
import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ConsumerVetoToggle,
  JobSenderList,
  LabelScopeField,
  PatternTester,
  RuleList,
} from './-mailFilters';
import {
  useCreateRule,
  useDeleteRule,
  useJobSenders,
  useMailFilters,
  useSetBuiltInJobSender,
  useSetConsumerVeto,
  useSetLabel,
  useTestPattern,
  useUpdateRule,
} from './-mailFiltersApi';

export const Route = createFileRoute('/settings/mail-filters')({
  component: MailFiltersSettings,
});

function MailFiltersSettings() {
  const filters = useMailFilters();
  const jobSenders = useJobSenders();
  const setBuiltIn = useSetBuiltInJobSender();
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const deleteRule = useDeleteRule();
  const setLabel = useSetLabel();
  const setVeto = useSetConsumerVeto();
  const test = useTestPattern();

  const rules = filters.data?.rules ?? [];
  const allow = rules.filter((r) => r.effect === 'allow');
  const deny = rules.filter((r) => r.effect === 'deny');

  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>What Opportun watches</CardTitle>
          <CardDescription>
            Narrow this and everything else becomes a backstop rather than the main defense.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LabelScopeField
            label={filters.data?.label ?? null}
            saving={setLabel.isPending}
            onSave={(label) => setLabel.mutate(label)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your lists</CardTitle>
          <CardDescription>
            These come first. Anything the rules below get wrong is one line here away from being
            fixed for good.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6">
          <RuleList
            title="Allow list"
            description="Always let through, whatever else would have filtered them."
            effect="allow"
            rules={allow}
            onAdd={(pattern) => createRule.mutate({ pattern, effect: 'allow' })}
            onToggle={(id, enabled) => updateRule.mutate({ id, enabled })}
            onDelete={(id) => deleteRule.mutate(id)}
          />
          <RuleList
            title="Deny list"
            description="Never scanned. A whole-domain rule is not even fetched; a single address is fetched and then dropped."
            effect="deny"
            rules={deny}
            onAdd={(pattern) => createRule.mutate({ pattern, effect: 'deny' })}
            onToggle={(id, enabled) => updateRule.mutate({ id, enabled })}
            onDelete={(id) => deleteRule.mutate(id)}
          />
          <ConsumerVetoToggle
            enabled={filters.data?.consumerVeto ?? true}
            onChange={(enabled) => setVeto.mutate(enabled)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Known job senders</CardTitle>
        </CardHeader>
        <CardContent>
          <JobSenderList
            senders={jobSenders.data?.senders ?? []}
            onToggle={(sender, enabled) => {
              // A built-in is muted by a rule, not deleted; one the user added is an ordinary
              // rule, so it toggles like any other.
              if (sender.builtIn) setBuiltIn.mutate({ pattern: sender.pattern, enabled });
              else if (sender.ruleId !== null) updateRule.mutate({ id: sender.ruleId, enabled });
            }}
            onAdd={(pattern) => createRule.mutate({ pattern, effect: 'job_sender' })}
            onDelete={(id) => deleteRule.mutate(id)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Try a pattern</CardTitle>
          <CardDescription>
            Counted against the senders already in your mail, so a pattern that matches nothing is
            obvious before you save it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PatternTester
            onTest={(pattern) => test.mutate(pattern)}
            testing={test.isPending}
            result={test.data}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filtered mail</CardTitle>
          <CardDescription>
            What these rules kept out. Opportun stores the sender and the date, never the subject or
            the message, and links back to the original in your mailbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/inbox" search={{ view: 'blocked' }} className="text-sm underline">
            See filtered mail
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
