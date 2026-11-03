# Mail filters

[Guide home](README.md) · Previous: [Inbox](inbox.md) · Next: [Discovery](discovery.md)

Mail filters decide which messages from Gmail and the Apple Mail connector Opportun reads at
all. They run before any AI sees a message, so they are also how you keep mail that is none of
Opportun's business out of it. They live under **Settings > Mail filters**. Messages from a
LinkedIn data export do not go through them.

## Which Gmail messages are fetched

**What Opportun watches** takes a Gmail label. With one set, mail outside that label is never
fetched, on every sync, not just the first. Leave it empty, or press **Watch the whole
mailbox**, to read your whole mailbox (within the lookback window). A label cannot contain a
quote, a backslash or a line break. This setting is for Gmail only.

## How a message is checked

Every message Opportun receives is checked in this order, on your own Opportun server, and
nothing is sent anywhere for these steps. Most of them look only at the sender; the private
content and job wording steps also read the subject and text. The first step that applies
decides whether a message is let through or kept out:

1. **Your own address** is always let through.
2. A match on your **allow list** is let through. An allow rule beats everything below,
   including a deny rule that matches the same sender.
3. A match on your **deny list** is kept out.
4. **Personal email providers** are kept out while **Skip mail from personal email providers**
   is on, which it is by default: Gmail, Outlook, iCloud, ISP addresses and the like. A message
   in a thread you have linked to an opportunity is not caught by this step.
5. **Private content** is kept out: a subject or text that reads as medical, financial or
   personal (for example "explanation of benefits", "claim number" or "routing number"), even
   from a known job sender. So is a sender whose domain name looks like a healthcare, pharmacy,
   insurance or bank one, unless it is a known job sender.
6. With assisted apply on, a message from **an address an application of yours expects** is let
   through: one at the company's own domain, for an application you submitted in the last 14
   days. An automated "we received your application" note often has no job wording in it, and
   this is how it reaches the confirmation matching. The AI check below does not look at it.
7. A **known job sender** (see below) is let through.
8. **Job wording** in the subject or text, such as "interview", "hiring", "recruiter" or
   "salary", lets a message through.
9. A message in a **thread you have linked to an opportunity** is let through.
10. **Anything else** is kept out: there is nothing in it about a job.

A sender address Opportun cannot read is let through, so a filter never hides a message it
could not check.

### The AI check

A message let through at step 7, 8 or 9 gets one more check: the `comms.triage` AI task sends
the sender's address, the subject and the first 500 characters of the message to your AI
provider, which decides whether it is part of your job search. Only a confident "no" keeps a message out. If the model
is unsure, or cannot answer at all (no AI key, the daily budget spent, a provider error), the
message is let through. The check is skipped for your allow list, your own address, and the
job alert senders that [Discovery](discovery.md#job-alert-emails) reads.

Messages that get through both go on to classification, described in
[Inbox](inbox.md#how-classification-works).

## Writing a rule

The allow list, the deny list and the known job senders all take sender patterns:

| You type                             | It matches                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| `someone@example.com`                | That address                                                      |
| `*@example.com` or `example.com`     | Any address at example.com, but not at its subdomains             |
| `*@*.example.com` or `*.example.com` | Any address at a subdomain of example.com, but not at example.com |
| `jobs-*@example.com`                 | Any address at example.com whose name starts with `jobs-`         |

A pattern is matched against the sender's address only, never the display name, and case does
not matter. `*` matches within one side of the `@` and never crosses it, so `*@example.com`
cannot match `someone@example.com.other.test`. Each rule has a switch, so you can turn one off
without deleting it.

**Try a pattern** counts how many of the senders already in your mail a pattern matches,
before you save it. That is how you catch a rule that matches nothing: `*.gmail.com`, for
example, means subdomains of gmail.com and matches no ordinary Gmail address. When it can, the
tester suggests a pattern instead; nothing is changed unless you use it.

For Gmail, a deny rule for a whole domain (`example.com` or `*@example.com`) is added to the
Gmail search, so that mail is never fetched at all. A deny rule for one address or for
subdomains is applied after fetching: the message is read, then kept out. If you deny a great
many domains, the ones that no longer fit in Gmail's search are also applied after fetching.

A rule applies to mail Opportun reads after you save it. Mail it has already read, let through
or kept out, stays as it is.

## Known job senders

Mail from a known job sender is treated as job mail: it is never kept out for a sender domain
that looks private, or for carrying no job words. Steps 1 to 5 above still come first, so your
deny list, the personal email provider step and private content in the message all beat it.

The list starts with built-in senders, such as LinkedIn's recruiter-message addresses
(`hit-reply@linkedin.com` and others) and Greenhouse (`*@greenhouse-mail.io`). Switching a
built-in off keeps it in the list, turned off, and you can add your own. The job alert senders
that Discovery reads count as known job senders too.

## What happens to a message that is kept out

A message kept out by a filter or by the AI check is stored without its content:

- **Kept**: who sent it (the From line, name and address), who it was sent to (the To line),
  the date, the rule that decided, and the ids that link back to the original in your mailbox
  (which mail source it came from, and its message and thread ids).
- **Not kept**: the subject, the text, and any links in it.

It is never classified and never creates an opportunity. It appears in the **Blocked** tab of
the [Inbox](inbox.md), with the rule that kept it out ("blocked by your deny list", "blocked by
nothing in it about a job") and, where there is one, **Open the original**. If a sender you
want is there, add them to your allow list so their next message gets through. **See filtered
mail**, at the bottom of the Mail filters page, opens that tab.

For a message the AI check kept out, the sender's address, the subject and the first 500
characters were sent to your AI provider before it decided. Opportun does not store them.

<!-- nav:bottom -->

---

| [← Inbox](inbox.md) | [Guide home](README.md) | [Discovery →](discovery.md) |
| :------------------ | :---------------------: | --------------------------: |
