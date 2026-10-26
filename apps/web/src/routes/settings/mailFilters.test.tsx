import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ConsumerVetoToggle,
  JobSenderList,
  LabelScopeField,
  PatternTester,
  RuleList,
} from './-mailFilters';
import type { JobSender, MailFilterRule } from './-mailFiltersApi';

const rule = (over: Partial<MailFilterRule> = {}): MailFilterRule => ({
  id: 'r1',
  pattern: '*@clinic-a.example',
  effect: 'deny',
  enabled: true,
  source: 'user',
  note: null,
  createdAt: 1,
  ...over,
});

describe('PatternTester', () => {
  it('offers the corrected pattern as one click when the typed one matches nothing', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    render(
      <PatternTester
        onTest={onTest}
        testing={false}
        result={{
          valid: true,
          matchCount: 0,
          sampleDomains: [],
          suggestions: [{ pattern: '*@gmail.com', matchCount: 112 }],
        }}
      />,
    );

    expect(screen.getByTestId('pattern-match-count')).toHaveTextContent(/matches 0/i);
    const fix = screen.getByRole('button', { name: /use \*@gmail\.com instead/i });
    await user.click(fix);

    expect(screen.getByLabelText('Pattern')).toHaveValue('*@gmail.com');
  });

  it('never rewrites the pattern on its own', async () => {
    const user = userEvent.setup();
    render(
      <PatternTester
        onTest={vi.fn()}
        testing={false}
        result={{
          valid: true,
          matchCount: 0,
          sampleDomains: [],
          suggestions: [{ pattern: '*@gmail.com', matchCount: 112 }],
        }}
      />,
    );
    const input = screen.getByLabelText('Pattern');
    await user.type(input, '*.gmail.com');
    expect(input).toHaveValue('*.gmail.com');
  });

  it('reports a pattern it cannot parse', () => {
    render(
      <PatternTester
        onTest={vi.fn()}
        testing={false}
        result={{ valid: false, matchCount: 0, sampleDomains: [], suggestions: [] }}
      />,
    );
    expect(screen.getByTestId('pattern-match-count')).toHaveTextContent(/not a sender pattern/i);
  });

  it('shows how many real senders an explicit pattern matches', () => {
    render(
      <PatternTester
        onTest={vi.fn()}
        testing={false}
        result={{
          valid: true,
          matchCount: 112,
          sampleDomains: ['gmail.com'],
          suggestions: [],
        }}
      />,
    );
    expect(screen.getByTestId('pattern-match-count')).toHaveTextContent(/matches 112/i);
    expect(screen.queryByRole('button', { name: /instead/i })).toBeNull();
  });
});

describe('RuleList', () => {
  it("adds a rule with the list's own effect", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <RuleList
        title="Deny list"
        description="Never fetched or scanned."
        effect="deny"
        rules={[]}
        onAdd={onAdd}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('Add to Deny list'), '*@clinic.test');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(onAdd).toHaveBeenCalledWith('*@clinic.test');
  });

  it('toggles and deletes an existing rule', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    render(
      <RuleList
        title="Deny list"
        description=""
        effect="deny"
        rules={[rule()]}
        onAdd={vi.fn()}
        onToggle={onToggle}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: /enable \*@clinic-a\.example/i }));
    expect(onToggle).toHaveBeenCalledWith('r1', false);

    await user.click(screen.getByRole('button', { name: /remove \*@clinic-a\.example/i }));
    expect(onDelete).toHaveBeenCalledWith('r1');
  });

  it('marks a rule a rejection added so it can be audited', () => {
    render(
      <RuleList
        title="Deny list"
        description=""
        effect="deny"
        rules={[rule({ source: 'rejection', note: 'Rejected 2026-10-19' })]}
        onAdd={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/rejected 2026-10-19/i)).toBeInTheDocument();
  });
});

describe('ConsumerVetoToggle', () => {
  it('is one toggle, not one row per provider', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ConsumerVetoToggle enabled={true} onChange={onChange} />);

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toBeChecked();

    await user.click(boxes[0]!);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('LabelScopeField', () => {
  it('saves a chosen label', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<LabelScopeField label={null} saving={false} onSave={onSave} />);

    await user.type(screen.getByLabelText('Gmail label'), 'JobSearch');
    await user.click(screen.getByRole('button', { name: 'Save label' }));

    expect(onSave).toHaveBeenCalledWith('JobSearch');
  });

  it('clears the label back to watching everything', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<LabelScopeField label="JobSearch" saving={false} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: /watch the whole mailbox/i }));

    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('refuses a label Gmail cannot be asked for', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<LabelScopeField label={null} saving={false} onSave={onSave} />);

    await user.type(screen.getByLabelText('Gmail label'), 'bad"label');

    expect(screen.getByRole('button', { name: 'Save label' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// Known job senders, rule 4 (spec D7 item 4, decision D-3). Two things this list has to get
// right: it must not read as the alert-digest sender list under Integrations, which means
// something else entirely, and a built-in must be switchable off without being deletable, since
// deleting one would freeze today's copy of a list that ships with the release.
const sender = (over: Partial<JobSender> = {}): JobSender => ({
  pattern: 'inmail-hit-reply@linkedin.com',
  platform: 'LinkedIn',
  sends: 'recruiter InMail notifications',
  builtIn: true,
  enabled: true,
  matchCount: 12,
  ruleId: null,
  ...over,
});

describe('JobSenderList', () => {
  const props = {
    senders: [sender()],
    onToggle: vi.fn(),
    onAdd: vi.fn(),
    onDelete: vi.fn(),
  };

  it('says what being on this list means, in the words that are not the digest list', () => {
    render(<JobSenderList {...props} senders={[sender()]} />);

    expect(screen.getByText(/always treated as job mail/i)).toBeInTheDocument();
    expect(screen.queryByText(/job alert digest/i)).toBeNull();
  });

  it('shows each row with what it sends and how much of your mail it matches', () => {
    render(<JobSenderList {...props} senders={[sender({ matchCount: 12 })]} />);

    expect(screen.getByText('inmail-hit-reply@linkedin.com')).toBeInTheDocument();
    expect(screen.getByText(/recruiter inmail notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/matches 12/i)).toBeInTheDocument();
  });

  it('switches a built-in off without offering to delete it', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<JobSenderList {...props} senders={[sender()]} onToggle={onToggle} />);

    await user.click(
      screen.getByRole('checkbox', { name: /enable inmail-hit-reply@linkedin\.com/i }),
    );

    expect(onToggle).toHaveBeenCalledWith(sender(), false);
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('lets the user remove a sender they added themselves', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const own = sender({
      pattern: '*@talentpartners.example',
      platform: '',
      sends: '',
      builtIn: false,
      ruleId: 'r9',
      matchCount: 3,
    });
    render(<JobSenderList {...props} senders={[own]} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: /remove \*@talentpartners\.example/i }));

    expect(onDelete).toHaveBeenCalledWith('r9');
  });

  it('adds a sender of your own', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<JobSenderList {...props} senders={[]} onAdd={onAdd} />);

    await user.type(screen.getByLabelText('Add a job sender'), '*@talentpartners.example');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(onAdd).toHaveBeenCalledWith('*@talentpartners.example');
  });

  it('says plainly that a switched-off built-in is still part of the shipped list', () => {
    render(<JobSenderList {...props} senders={[sender({ enabled: false })]} />);

    expect(screen.getByRole('checkbox', { name: /enable/i })).not.toBeChecked();
    expect(screen.getByText(/switched off/i)).toBeInTheDocument();
  });
});
