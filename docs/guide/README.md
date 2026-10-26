# Opportun user guide

This guide walks through Opportun as you use it day to day: tracking opportunities,
tailoring resumes, triaging recruiter mail, finding new postings, working your network, and
configuring the instance. It assumes Opportun is already running. If it is not, start with
the [installation guide](../install.md).

Every screenshot was taken from a real Opportun instance filled with made-up data (Initech,
Hooli, Globex and friends, plus fictional people). In that instance the AI, Google and job
board connections were replaced by the test fakes the project ships for its end-to-end tests,
so a few AI-written lines read "Mock answer." where your own model would write a sentence.

## Pages

1. [Getting started](getting-started.md): first account, signing in, the dashboard, themes.
2. [Pipeline](pipeline.md): opportunities, the board, stage moves, the opportunity tabs, and
   finding a posting.
3. [Resumes](resumes.md): base and tailored resumes, the tailoring chat, match scores, and
   Reactive Resume.
4. [Inbox](inbox.md): Gmail, classification, review flags, linking mail, and Apple Mail.
5. [Discovery](discovery.md): companies, job boards (Workday included), job alert emails,
   the review queue, capture, ranking prompts, and dismissal learning.
6. [Browser extension](browser-extension.md): capturing a profile or posting from the page
   you are looking at, and why it works the way it does.
7. [Network](network.md): contacts, the LinkedIn export, and referrals.
8. [Settings](settings.md): AI keys and models, prompts, security, users, device tokens,
   import and export, and backups.

## A word on AI

Opportun uses AI models you pay for with your own keys. Every AI call has a cost, a daily
budget per task, and a line in the usage table under **Settings > AI**. The AI drafts and
ranks; it never sends an application, email or message, and it never changes a stage or a
document without your click. Treat its scores and suggestions as a second opinion, not a
verdict.
