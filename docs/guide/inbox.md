# Inbox

[Guide home](README.md) · Previous: [Resumes](resumes.md) · Next: [Mail filters](mail-filters.md)

The inbox collects recruiter mail, classifies it with AI, links it to the opportunities it is
about, and suggests stage changes. It never sends, labels, moves or deletes mail.

Mail can come from three places, shown as a badge on each message: **Gmail**, **Apple Mail**
(through a connector on your Mac) and **LinkedIn** (messages from your LinkedIn data export,
see [Network](network.md#import-your-linkedin-export)).

## Connect Gmail

Gmail uses the same Google OAuth client as resumes (see
[Resumes](resumes.md#connect-google)), but its read-only access is a separate grant:

1. Open **Settings > Integrations**.
2. Under **Gmail**, press **Connect Gmail (read-only)** and approve the read-only permission.
3. Optionally set **How far back to read (days)**: 1 to 1095, default 180. The first sync
   reads that far back, outside spam and trash. Changing it later makes the next sync re-read
   the whole window: widening pulls older mail in, narrowing keeps what is already there.

Which messages Opportun reads at all is up to your [mail filters](mail-filters.md): a Gmail
label to watch, allow and deny lists, and the checks every message passes before it is
classified.

Opportun syncs every 15 minutes on its own. **Sync now** (on the Inbox or the Gmail card)
runs one immediately.

![The Gmail card showing read-only access granted, 4 messages stored and the lookback window, with the Extensions and Connectors card below it reporting Apple Mail connected](images/integrations-gmail-devices.png)

_The Gmail card with its lookback window, and the Extensions and Connectors card that tracks the Apple Mail connector._

## How classification works

Before a message is classified, your mail filters (under **Settings > Mail filters**) decide
whether it is about your job search at all. They run on your own Opportun server: they read the
sender and, for some checks, the subject and text, and send nothing anywhere. For some
messages a short AI check, the `comms.triage` task, then sends the sender's address, the
subject and the first 500 characters to your AI provider to decide the same. A message either
one keeps out is stored without its subject or text;
[Mail filters](mail-filters.md#what-happens-to-a-message-that-is-kept-out) lists what is kept.
It appears in the **Blocked** tab, so you can spot a sender kept out by mistake and change the
rule.

Each message that gets through goes to the `comms.classify` AI task, which decides:

- **What it is**: Outreach, Scheduling, Follow-up, Rejection, Offer, Networking or Other.
- **For outreach, what kind**: **Targeted** (written to you about a real role),
  **Broadcast** (mass or templated spam) or **Not a fit** (a genuine role that conflicts
  with your role targets, with the reason).
- **Which opportunity it is about**, if any you track.
- **Whether it implies a stage change**, such as an interview request for a role you applied
  to.

Targeted outreach about a role you do not track yet creates an opportunity in New.

Classification costs one AI call per message. A first Gmail sync over 180 days can mean
hundreds of calls; the default model for this task is a small, cheap one, and the per-task
daily budget stops calls once it is spent, until the next UTC day (see
[Settings](settings.md#models-and-budgets)). Messages synced before you added an AI key stay
unclassified and are queued automatically when you add one.

Classification uses prompt caching (the same mechanism as discovery's
[prompt caching](discovery.md#the-review-queue)). Opportun puts the part of the prompt that is the same
for every message of a sync first: the instructions, your role targets, the rules for what to
decide and your open opportunities (the 200 most recently updated, listed by when each was
created, so one being updated does not change the list). The message comes after it. The first
call writes that part to Anthropic's cache and the following calls read it at a tenth of the input
price. Only Anthropic models are marked, and only when that part is large enough for the model's
minimum. A new opportunity changes the list, so the next call writes the cache again. A prompt you
edited yourself keeps its own order and text, and what is cached is whatever comes before the
message in it. qa measured one batch of 36 messages with 10 open opportunities on
`claude-haiku-5-5`: the cost per classify call fell about 43%, from $0.00047 to $0.00026
([the measurement](https://github.com/bgoleno/opportun/pull/433#issuecomment-6807923311)). That is
one batch, not a promise for yours.

## The five tabs

| Tab          | What it holds                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs review | Job-related messages that are not linked to an opportunity yet, messages the classifier was unsure about (below 50% confidence), and messages that just created an opportunity |
| Linked       | Messages linked to an opportunity                                                                                                                                              |
| Spam         | Broadcast outreach. It never creates opportunities. **Not spam** brings one back                                                                                               |
| Filtered     | Not-a-fit outreach, with the reason it does not fit                                                                                                                            |
| Blocked      | Messages kept out before classification (see above), each shown with its sender, its date and the rule that decided, and a link to the original where there is one             |

![The Linked tab: a targeted Apple Mail message, and a Gmail interview request with a suggested move to In process](images/inbox-linked.png)

_Linked mail with its channel badges (Apple Mail, Gmail). The interview request suggests moving Contoso to In process._

![The Spam tab with one broadcast message and a Not spam button](images/inbox-spam.png)

_Broadcast outreach lands in Spam and never creates an opportunity._

## Acting on a message

- **Open** shows the snippet Opportun kept, up to 500 characters, and, for Gmail and most
  Apple Mail messages, a link back to the original in your own mailbox (LinkedIn messages,
  and the rare Apple Mail one the connector could not identify precisely, have none). Opportun
  does not store or show the full body. While a new message waits to be classified, its full
  text sits in the classification task, encrypted with your server's secrets key, and is
  removed when that task finishes; from that change on
  ([#175](https://github.com/bgoleno/opportun/issues/175)), neither the database files nor
  Opportun's backups hold it unencrypted. Text of messages classified before it may remain in
  unused database space until reused; an administrator can clear it once (see
  [install guide section 6](../install.md#clearing-message-text-left-from-before-encrypted-classification)).
- **Suggested stage**: **Move to ...** applies the suggested stage change; **Ignore** drops
  the suggestion. A suggestion never moves an opportunity back to an earlier stage, and only
  appears when the classifier is at least 70% confident.
- **Link to opportunity** / **Change link** searches your opportunities by company or title.
  **Unlink** removes the link.
- **Reclassify** corrects the type or outreach kind. Saving a correction (even one that
  changes nothing) clears the review flag on a linked message.

Your corrections are kept. Once a week (Mondays), if you made at least five since the last
time, the `discovery.refine_prompt` task proposes a revised classification prompt. The
proposal appears at the top of **Settings > AI**, and nothing changes until you accept it.

## Apple Mail

Apple Mail has no server API, so a small command-line connector on your Mac reads the
mailboxes you name and pushes them to Opportun with a **device token**. Your mail password
never reaches the server, and the token can only push mail in, never read anything back.

1. Under **Settings > Integrations > Extensions and Connectors**, press **Create token**, tick only
   **Apple Mail connector (mail:push)**, and confirm with your password. Copy the token: it is
   shown once.
2. Build, configure and schedule the connector on your Mac:
   [install guide section 11](../install.md#11-apple-mail-macos) has every command.

The Extensions and Connectors card then reports the connector, for example "Apple Mail:
connected, last batch 4 minutes ago (1 message)", and each token's last use. Messages it pushes
show the **Apple Mail** badge and go through the same classification as Gmail. Revoke a token
from the same card and the connector is cut off on its next request.

<!-- nav:bottom -->

---

| [← Resumes](resumes.md) | [Guide home](README.md) | [Mail filters →](mail-filters.md) |
| :---------------------- | :---------------------: | --------------------------------: |
