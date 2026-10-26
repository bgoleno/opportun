// Stage 1 rule evaluation (spec D1 rules 0, 1, 2 and the inert rule 4).
//
// Two layers: evaluateRules covers only the user's own table (allow beats deny beats
// job_sender), and triageSender composes that with the built-in consumer-domain veto to give
// ingest a single verdict. Rule 2 sits BELOW the user's lists, so an allow rule rescues a
// recruiter writing from Gmail and a deny rule is not undone by anything.
import { describe, expect, it } from 'vitest';
import type { MailFilterRuleRow } from '../src/repos/mailFilters';
import { evaluateRules, triageMessage, triageSender } from '../src/lib/mailTriage';

let seq = 0;
function rule(partial: Partial<MailFilterRuleRow>): MailFilterRuleRow {
  seq += 1;
  return {
    id: `rule-${seq}`,
    userId: 'u1',
    pattern: '*@example.test',
    effect: 'deny',
    enabled: true,
    source: 'user',
    note: null,
    createdAt: seq,
    updatedAt: seq,
    ...partial,
  } as MailFilterRuleRow;
}

describe('evaluateRules', () => {
  it('returns none when nothing matches', () => {
    expect(evaluateRules('a@nowhere.test', [rule({ pattern: '*@other.test' })])).toEqual({
      decision: 'none',
      ruleId: null,
      pattern: null,
    });
  });

  it('lets an allow rule beat a deny rule for the same address', () => {
    const rules = [
      rule({ pattern: '*@gmail.com', effect: 'deny' }),
      rule({ pattern: 'recruiter@gmail.com', effect: 'allow' }),
    ];
    expect(evaluateRules('recruiter@gmail.com', rules).decision).toBe('allow');
    expect(evaluateRules('someone@gmail.com', rules).decision).toBe('deny');
  });

  it('prefers the more specific pattern among rules of the same effect', () => {
    const broad = rule({ pattern: '*@*.acme.test', effect: 'deny' });
    const exact = rule({ pattern: 'hr@jobs.acme.test', effect: 'deny' });
    expect(evaluateRules('hr@jobs.acme.test', [broad, exact]).ruleId).toBe(exact.id);
  });

  it('ignores a disabled rule', () => {
    const rules = [rule({ pattern: '*@gmail.com', effect: 'deny', enabled: false })];
    expect(evaluateRules('a@gmail.com', rules).decision).toBe('none');
  });

  it('reports which rule decided, so a filtered row can say why', () => {
    const deny = rule({ pattern: '*@clinic.test', effect: 'deny' });
    expect(evaluateRules('info@clinic.test', [deny])).toEqual({
      decision: 'deny',
      ruleId: deny.id,
      pattern: '*@clinic.test',
    });
  });

  it('treats a job_sender rule as inert until Plan 2 implements rule 4', () => {
    const rules = [rule({ pattern: '*@greenhouse-mail.io', effect: 'job_sender' })];
    expect(evaluateRules('no-reply@greenhouse-mail.io', rules).decision).toBe('none');
  });

  it('still lets a deny rule beat a job_sender rule for the same address', () => {
    const rules = [
      rule({ pattern: '*@greenhouse-mail.io', effect: 'job_sender' }),
      rule({ pattern: '*@greenhouse-mail.io', effect: 'deny' }),
    ];
    expect(evaluateRules('no-reply@greenhouse-mail.io', rules).decision).toBe('deny');
  });
});

describe('triageSender', () => {
  const noRules: MailFilterRuleRow[] = [];

  it('passes an ordinary corporate sender', () => {
    const out = triageSender('recruiter@northwind.example', noRules, true);
    expect(out).toMatchObject({ decision: 'pass', matchedRule: 'none' });
  });

  it('drops a consumer-domain sender when the veto is on', () => {
    const out = triageSender('someone@gmail.com', noRules, true);
    expect(out).toMatchObject({ decision: 'drop', matchedRule: 'consumer_domain' });
  });

  it('passes a consumer-domain sender when the veto is off', () => {
    expect(triageSender('someone@gmail.com', noRules, false).decision).toBe('pass');
  });

  it('lets a user allow rule rescue a consumer-domain sender', () => {
    const rules = [rule({ pattern: 'recruiter@gmail.com', effect: 'allow' })];
    const out = triageSender('recruiter@gmail.com', rules, true);
    expect(out).toMatchObject({ decision: 'pass', matchedRule: 'allow_list' });
  });

  it('drops a user-denied sender even when the veto is off', () => {
    const rules = [rule({ pattern: '*@clinic.test', effect: 'deny' })];
    const out = triageSender('info@clinic.test', rules, false);
    expect(out).toMatchObject({ decision: 'drop', matchedRule: 'deny_list' });
  });

  it('passes a sender whose address cannot be read, and says so', () => {
    // Fail open toward the human: senderAddress returns '' for any From header it will not
    // vouch for, including legitimate ones (two mailboxes in the header). No rule can match
    // an address we cannot read, so dropping would hide real mail to no defensive end.
    expect(triageSender('', noRules, true)).toMatchObject({
      decision: 'pass',
      matchedRule: 'unreadable_sender',
    });
  });

  it('does not apply the consumer veto to an unreadable sender', () => {
    expect(triageSender('two@gmail.com, other@gmail.com', noRules, true).decision).toBe('pass');
  });

  it("never filters the account's own address, even at a consumer provider", () => {
    // I1: the settings page promises "your own address is always exempt". Implicit rather
    // than a seeded allow rule, so it cannot be deleted and cannot over-reach to the domain.
    const out = triageSender('me@gmail.com', noRules, true, 'me@gmail.com');
    expect(out).toMatchObject({ decision: 'pass', matchedRule: 'own_address' });
  });

  it('does not extend that exemption to the rest of the provider', () => {
    expect(triageSender('someone@gmail.com', noRules, true, 'me@gmail.com').decision).toBe('drop');
  });

  it('matches the account address case-insensitively', () => {
    expect(triageSender('ME@Gmail.com', noRules, true, 'me@gmail.com').decision).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// The full funnel (spec D1 rules 0 to 7). The order IS the design, so these tests are mostly
// about precedence: which rule wins when two of them have something to say about one message.

const message = (over: Partial<Parameters<typeof triageMessage>[0]> = {}) =>
  triageMessage({
    address: 'someone@acme.example',
    subject: 'Hello',
    body: 'Nothing in particular.',
    rules: [],
    consumerVeto: true,
    selfAddress: 'me@mine.example',
    threadLinked: false,
    digestSender: false,
    ...over,
  });

const JOB_SENDER = 'no-reply@candidate.fyi';

describe('triageMessage', () => {
  it('drops a message with no signal at all', () => {
    const v = message();
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('no_signal');
  });

  it('passes a message carrying job vocabulary', () => {
    const v = message({ body: 'Are you open to an interview next week?' });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('vocabulary');
    expect(v.signal).toBe('interview');
  });

  it('passes a bare reply on a thread the user linked to an opportunity', () => {
    // Rule 6: "Thursday works" carries no job word and is still the most important mail there is.
    const v = message({ body: 'Thursday works.', threadLinked: true });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('thread');
  });

  it('passes a known job sender whatever the words are', () => {
    const v = message({ address: JOB_SENDER, body: 'Your reminder is below.' });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('job_sender');
  });

  it('counts an alert-digest sender as rule 4, since a digest body may hold no job words', () => {
    // spec D1 names job_senders and alert_senders together at rule 4. The caller resolves the
    // list, because it is a user setting and this function does no IO. Without this, rule 7
    // drops a digest whose postings happen to use none of rule 5's words, and Discovery empties
    // with nothing in the UI to explain it.
    const v = message({
      address: 'jobalerts-noreply@linkedin.com',
      subject: 'Your job alert for product manager',
      body: '3 new postings in Portland, OR.',
      digestSender: true,
    });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('job_sender');
    // Same message, same sender, not on the list: rule 7.
    expect(
      message({
        address: 'jobalerts-noreply@linkedin.com',
        subject: 'Your job alert for product manager',
        body: '3 new postings in Portland, OR.',
      }).matchedRule,
    ).toBe('no_signal');
  });

  it('does NOT let an alert-digest sender override the content veto (3b)', () => {
    const v = message({
      address: 'jobalerts-noreply@linkedin.com',
      body: 'Your claim number is 99-12.',
      digestSender: true,
    });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('private_content');
  });

  // Review Focus 1: the state-benefits case, where one domain carries both hiring mail and
  // benefit records. Rule 3a yields to a job sender; rule 3b does not.
  it('lets a job sender override the private-content SENDER signal (3a)', () => {
    // The local part must NOT be a hiring mailbox here: those cancel 3a on their own, which
    // would make this test pass whatever the rule 3 / rule 4 precedence was.
    const v = message({
      address: 'noreply@valleymedicalgroup.example',
      rules: [rule({ pattern: '*@valleymedicalgroup.example', effect: 'job_sender' })],
      body: 'We would like to schedule a call.',
    });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('job_sender');
  });

  it('does NOT let a job sender override the private-content CONTENT signal (3b)', () => {
    const v = message({
      address: JOB_SENDER,
      subject: 'About your hiring event',
      body: 'Your claim number is 99-12.',
    });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('private_content');
    expect(v.signal).toBe('claim number');
  });

  it('drops a private sender that is not a job sender, naming the signal', () => {
    const v = message({ address: 'noreply@firstnationalbank.example' });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('private_content');
    expect(v.signal).toBe('bank');
  });

  it('keeps rule 0 above every heuristic, including the content veto', () => {
    // The user said yes to this sender explicitly. Nothing below rule 0 overrules that.
    const v = message({
      address: 'billing@valleymedicalgroup.example',
      body: 'Your superbill is attached.',
      rules: [rule({ pattern: 'billing@valleymedicalgroup.example', effect: 'allow' })],
    });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('allow_list');
  });

  it('keeps the deny list above the pass rules', () => {
    const v = message({
      address: 'recruiter@agency.example',
      body: 'Are you open to an interview?',
      rules: [rule({ pattern: '*@agency.example', effect: 'deny' })],
    });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('deny_list');
  });

  it('keeps the consumer veto above the pass rules', () => {
    const v = message({ address: 'friend@gmail.com', body: 'Are you open to an interview?' });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('consumer_domain');
  });

  // Brian's decision, 2026-10-19: rule 2 yields to a thread the user linked themselves. Three
  // referral conversations from personal Gmail were the reason, and they are the mail a job
  // seeker can least afford to lose. Linking a thread is the user's own act, so a stranger
  // cannot trigger this.
  it('lets a linked thread survive the consumer-domain veto', () => {
    const v = message({
      address: 'friend@gmail.com',
      body: 'Happy to make the referral.',
      threadLinked: true,
    });
    expect(v.decision).toBe('pass');
  });

  it('still vetoes consumer mail that only has a job word, with no linked thread', () => {
    // The discriminator against the wider reading: vocabulary alone does NOT beat rule 2, or a
    // stranger writing 'referral' from a Gmail account would be through.
    const v = message({ address: 'friend@gmail.com', body: 'Happy to make the referral.' });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('consumer_domain');
  });

  it('keeps the content veto above a linked thread', () => {
    // Rule 3b is not what rule 2 yielded to: private content still drops, linked or not.
    const v = message({
      address: 'friend@gmail.com',
      body: 'Your superbill is attached.',
      threadLinked: true,
    });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('private_content');
  });

  it('exempts the account own address from every heuristic', () => {
    const v = message({ address: 'me@mine.example', body: 'note to self' });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('own_address');
  });

  it('honors a job sender the user added themselves', () => {
    const v = message({
      address: 'talent@boutique-search.example',
      body: 'A note about a role.',
      rules: [rule({ pattern: '*@boutique-search.example', effect: 'job_sender' })],
    });
    expect(v.matchedRule).toBe('job_sender');
  });

  it('stops honoring a built-in job sender the user switched off', () => {
    // D-3: a disabled rule naming the built-in pattern is how a code-shipped list stays
    // editable. The message then falls through to the pass rules, which find nothing here.
    const v = message({
      address: JOB_SENDER,
      body: 'Your reminder is below.',
      rules: [rule({ pattern: '*@candidate.fyi', effect: 'job_sender', enabled: false })],
    });
    expect(v.decision).toBe('drop');
    expect(v.matchedRule).toBe('no_signal');
  });

  it('passes an unreadable sender rather than hiding it', () => {
    const v = message({ address: '' });
    expect(v.decision).toBe('pass');
    expect(v.matchedRule).toBe('unreadable_sender');
  });

  it('reads the subject as well as the body', () => {
    expect(message({ subject: 'Interview request', body: '' }).matchedRule).toBe('vocabulary');
    expect(message({ subject: 'Your superbill', body: '' }).matchedRule).toBe('private_content');
  });
});
