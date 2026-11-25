// A user at their desk for the capture workflow's specs (discoveryCapture.spec.ts, issue #970): a
// browser with the extension connected, the mock LinkedIn and Indeed, the alert emails that bring
// cards, and what the stored state has to be after a capture.
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { browserWithExtension, Popup } from './extension';
import {
  alertMail,
  postingAddress,
  postingPage,
  type AlertCard,
  type MockPosting,
  type Site,
} from './fixtures/postingPages';
import { PASSWORD, registerUser, toasts } from './helpers';

export const COMPANY = 'Initech';
export const PLACE = 'United States';
/** The card leaves within this of the capture's commit (W7, tl's ruling). */
export const LEAVES_WITHIN = 5_000;

export const ADDED = 'Added to your pipeline as Interested.';
export const DESCRIPTION =
  'Initech needs somebody to own its TPS reports, from cover sheet to archive.';

export interface Opportunity {
  id: string;
  title: string;
  stage: string;
  postingState: string;
  location: string | null;
  descriptionMd: string | null;
}
export interface Result {
  id: string;
  disposition: string;
  opportunityId: string | null;
  aiScore: number | null;
  posting: { title: string; externalId: string | null };
}

let ids = 0;
/** A posting no other test has: its id is new, and of the site's own shape. */
export function posting(site: Site, title: string, over: Partial<MockPosting> = {}): MockPosting {
  ids += 1;
  const n = String(Date.now()).slice(-7) + String(ids).padStart(3, '0');
  return {
    site,
    id: site === 'linkedin' ? `4${n}`.slice(0, 10) + String(ids).padStart(3, '0') : `abcdef${n}`,
    title,
    company: COMPANY,
    description: DESCRIPTION,
    ...over,
  };
}

/** One user with the extension connected, and the mock sites. */
export class Desk {
  popup!: Popup;
  page!: Page;
  private token = '';
  private mails = 0;
  private readonly postings = new Map<string, MockPosting>();

  private constructor(readonly context: BrowserContext) {}

  static async open(viewport = { width: 1280, height: 900 }): Promise<Desk> {
    const desk = new Desk(await browserWithExtension(viewport));
    await desk.context.route(
      (url) => /(?:^|\.)(?:linkedin|indeed)\.com$/.test(url.hostname),
      (route) => {
        const url = new URL(route.request().url());
        const found = [...desk.postings.values()].find(
          (p) => url.pathname.includes(p.id) || [...url.searchParams.values()].includes(p.id),
        );
        return found === undefined
          ? route.fulfill({ status: 404, contentType: 'text/html', body: 'no such page' })
          : route.fulfill({ status: 200, contentType: 'text/html', body: postingPage(found) });
      },
    );
    desk.page = await desk.context.newPage();
    await registerUser(desk.page);
    desk.token = (
      await desk.api<{ token: string }>('POST', '/device-tokens', {
        name: 'Chrome extension',
        scopes: ['capture:push', 'mail:push'],
        password: PASSWORD,
      })
    ).token;
    desk.popup = await Popup.connected(desk.context, desk.token);
    return desk;
  }

  async api<T>(method: string, path: string, data?: unknown): Promise<T> {
    const csrf = (await this.context.cookies()).find((c) => c.name === 'opportun_csrf')?.value;
    const res = await this.page.request.fetch(`/api/v1${path}`, {
      method,
      headers: { 'x-csrf-token': csrf ?? '' },
      ...(data === undefined ? {} : { data }),
    });
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  }

  /** The mock sites show these postings. */
  publish(...list: MockPosting[]): void {
    for (const p of list) this.postings.set(p.id, p);
  }

  /**
   * An alert email brings these cards, and each is ranked (unless `ranked` is false): the order has
   * settled. `stored` are the ones a result is made of, when not every one.
   */
  async alert(
    site: Site,
    cards: AlertCard[],
    { ranked = true, stored = cards }: { ranked?: boolean; stored?: AlertCard[] } = {},
  ): Promise<void> {
    this.publish(...cards.map((c) => c.posting));
    this.mails += 1;
    const res = await this.context.request.post('/api/v1/connector/mail/batch', {
      headers: { authorization: `Bearer ${this.token}` },
      data: { messages: [alertMail(site, cards, `${site}-${this.mails}-${Date.now()}`)] },
    });
    expect(res.status(), await res.text()).toBe(200);
    const wanted = stored.map((c) => c.posting.id);
    await expect
      .poll(
        async () =>
          (await this.results()).filter(
            (r) => wanted.includes(r.posting.externalId ?? '') && (!ranked || r.aiScore !== null),
          ).length,
        // Ranked a tenth of a second to a second after the mail is in: looked at that often (#1031).
        { timeout: 45_000, intervals: [50] },
      )
      .toBe(wanted.length);
  }

  async results(): Promise<Result[]> {
    const all: Result[] = [];
    for (;;) {
      const page = await this.api<{ items: Result[]; total: number }>(
        'GET',
        `/discovery/results?limit=200&offset=${all.length}`,
      );
      all.push(...page.items);
      if (all.length >= page.total || page.items.length === 0) return all;
    }
  }

  async opportunities(title: string): Promise<Opportunity[]> {
    const { items } = await this.api<{ items: Opportunity[] }>('GET', '/opportunities?limit=200');
    return items.filter((o) => o.title === title);
  }

  /** The capture entries of an opportunity's timeline. */
  async entries(id: string): Promise<{ title: string; externalUrl: string | null }[]> {
    const { items } = await this.api<{ items: { title: string; externalUrl: string | null }[] }>(
      'GET',
      `/opportunities/${id}/activities?limit=200`,
    );
    return items;
  }

  async discovery(): Promise<void> {
    await this.page.goto('/discovery');
    await expect(this.page.getByText(/^\d+ results? to review\.$/)).toBeVisible();
  }

  /** The cards: the list's own items, not the locations listed inside one. */
  get cards() {
    return this.page.getByRole('list', { name: 'Results to review' }).locator('> li');
  }

  row(title: string, company = COMPANY) {
    return this.page
      .getByRole('list', { name: 'Results to review' })
      .getByRole('listitem', { name: `${title} at ${company}` });
  }

  /** The card's own Posting button: the job's tab, shown by the mock at its stored address. */
  async openPosting(p: MockPosting): Promise<Page> {
    const opened = this.context.waitForEvent('page');
    await this.row(p.title)
      .getByRole('link', { name: `Open posting for ${p.title} at ${p.company}` })
      .click();
    const tab = await opened;
    await expect(tab).toHaveURL(postingAddress(p));
    return tab;
  }

  /** The job's tab, reached without Discovery. */
  async visit(p: MockPosting, address = postingAddress(p)): Promise<Page> {
    const tab = await this.context.newPage();
    await tab.goto(address);
    return tab;
  }

  /** Captures the posting in its tab, with one click, and says what the popup said. */
  async capture(p: MockPosting, address = postingAddress(p)): Promise<string> {
    const tab = await this.visit(p, address);
    const said = await this.popup.capture(address);
    await tab.close();
    return said;
  }

  /** Goes back to the Discovery tab, as switching to it does. */
  async back(events: ('visibilitychange' | 'focus')[] = ['visibilitychange', 'focus']) {
    await this.page.bringToFront();
    await this.page.evaluate((list) => {
      for (const e of list) {
        (e === 'focus' ? window : document).dispatchEvent(new Event(e));
      }
    }, events);
  }

  /** W5 to W7: exactly one opportunity, at Interested, with the captured text; no card, no result left. */
  async oneAtInterested(p: MockPosting, over: Partial<Opportunity> = {}): Promise<Opportunity> {
    const list = await this.opportunities(p.title);
    expect(list).toHaveLength(1);
    const one = list[0] as Opportunity;
    expect(one).toMatchObject({ stage: 'interested', ...over });
    if (over.descriptionMd === undefined) expect(one.descriptionMd).toContain(DESCRIPTION);
    const results = (await this.results()).filter((r) => r.posting.title === p.title);
    expect(results.map((r) => [r.disposition, r.opportunityId])).toEqual(
      results.map(() => ['accepted', one.id]),
    );
    return one;
  }

  /** The card leaves by itself: no reload, no action on it. */
  async leaves(title: string, left: number): Promise<void> {
    await expect(this.row(title)).toHaveCount(0, { timeout: LEAVES_WITHIN });
    await expect(this.page.getByText(remaining(left))).toBeVisible();
  }

  /** Nothing asked and nothing failed: no dialog, no toast. */
  async quiet(): Promise<void> {
    await expect(this.page.getByRole('dialog')).toHaveCount(0);
    await expect(toasts(this.page).getByRole('listitem')).toHaveCount(0);
  }
}

export const remaining = (n: number): string =>
  n === 0
    ? 'Nothing to review. New results appear here after your sources run.'
    : n === 1
      ? '1 result to review.'
      : `${n} results to review.`;

/** Runs with a desk of its own, closed after it whatever happens. */
export async function atDesk(
  run: (desk: Desk) => Promise<void>,
  viewport?: { width: number; height: number },
): Promise<void> {
  const desk = await Desk.open(viewport);
  try {
    await run(desk);
  } finally {
    await desk.context.close();
  }
}
