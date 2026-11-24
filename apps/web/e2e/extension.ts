// The built browser extension in a Chromium of its own, for the capture workflow
// (discoveryCapture.spec.ts, https://github.com/bgoleno/opportun/issues/970). Everything the popup
// does is the shipped code: its settings, its reading of the tab (chrome.scripting on the page the
// mock serves at the site's own address), its request and its sentence.
//
// Two things differ from a user's browser, and both only here:
// - the popup is opened as a page, since a test cannot click the browser's toolbar. So
//   chrome.tabs.query is answered with the job's tab, which the toolbar popup would find itself.
// - the test server's origin is in the copy's host_permissions, which a user grants at runtime in
//   a browser dialog no test can answer.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config';

const run = promisify(execFile);
const EXTENSION = fileURLToPath(new URL('../../../packages/extension/', import.meta.url));

let built: Promise<string> | undefined;

/** Builds the Chrome extension once per worker, into a folder of its own. */
export function builtExtension(): Promise<string> {
  built ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-e2e-extension-'));
    const vite = createRequire(join(EXTENSION, 'package.json')).resolve('vite/package.json');
    await run(
      process.execPath,
      [
        join(dirname(vite), 'bin', 'vite.js'),
        'build',
        '--mode',
        'chrome',
        '--outDir',
        dir,
        '--emptyOutDir',
      ],
      { cwd: EXTENSION },
    );
    const path = join(dir, 'manifest.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this run's own temp folder
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { host_permissions: string[] };
    manifest.host_permissions.push(`http://${new URL(BASE_URL).hostname}/*`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this run's own temp folder
    await writeFile(path, JSON.stringify(manifest));
    return dir;
  })();
  return built;
}

/** Removes what builtExtension made. */
export async function removeBuiltExtension(): Promise<void> {
  if (built === undefined) return;
  const dir = await built;
  built = undefined;
  await rm(dir, { recursive: true, force: true });
}

/** A browser with the extension installed, on a profile of its own. */
export async function browserWithExtension(viewport: {
  width: number;
  height: number;
}): Promise<BrowserContext> {
  const dir = await builtExtension();
  return chromium.launchPersistentContext('', {
    // The full Chromium: the headless shell has no extensions.
    channel: 'chromium',
    headless: true,
    baseURL: BASE_URL,
    colorScheme: 'light',
    viewport,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
}

interface ChromeApi {
  tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> };
  storage: { local: { set(v: object): Promise<void> } };
}

async function extensionId(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    let id: string | null = null;
    await expect
      .poll(async () => {
        id = await page.evaluate(
          () =>
            document
              .querySelector('extensions-manager')
              ?.shadowRoot?.querySelector('extensions-item-list')
              ?.shadowRoot?.querySelector('extensions-item')?.id ?? null,
        );
        return id;
      })
      .not.toBeNull();
    return id as unknown as string;
  } finally {
    await page.close();
  }
}

export class Popup {
  private constructor(
    private readonly context: BrowserContext,
    private readonly id: string,
  ) {}

  /** Installs the user's server and token, as saving the popup's settings does. */
  static async connected(context: BrowserContext, token: string): Promise<Popup> {
    const id = await extensionId(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.evaluate(
      ([serverUrl, t]) =>
        (globalThis as unknown as { chrome: ChromeApi }).chrome.storage.local.set({
          serverUrl,
          token: t,
        }),
      [BASE_URL, token],
    );
    await page.close();
    return new Popup(context, id);
  }

  /** The popup over the tab that shows `url`. */
  async over(url: string): Promise<Page> {
    const page = await this.context.newPage();
    await page.setViewportSize({ width: 320, height: 520 });
    await page.addInitScript((u) => {
      const { tabs } = (globalThis as unknown as { chrome: ChromeApi }).chrome;
      const all = tabs.query.bind(tabs);
      tabs.query = async () => (await all({})).filter((t) => t.url === u);
    }, url);
    await page.goto(`chrome-extension://${this.id}/popup.html`);
    await expect(page.getByRole('button', { name: 'Capture this page' })).toBeVisible();
    return page;
  }

  /** One click on Capture this page, and the sentence the user reads. Closes the popup. */
  async capture(url: string): Promise<string> {
    const page = await this.over(url);
    await page.getByRole('button', { name: 'Capture this page' }).click();
    const status = page.locator('#status');
    await expect(status).toHaveText(/\S/);
    await expect(status).not.toHaveText(/^Capturing…/, { timeout: 35_000 });
    const said = (await status.innerText()).trim();
    await page.close();
    return said;
  }
}
