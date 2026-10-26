// The popup's two settings, the user's own Opportun server and a capture:push device token,
// kept in chrome.storage.local (this browser profile only, never synced). Pure apart from the
// injected storage; unit-tested.

export interface Settings {
  /** The server's base URL without a trailing slash (https, or http on this computer). */
  serverUrl: string;
  /** A device token (odt_...) with the capture:push scope. Never logged or rendered. */
  token: string;
}

/** The slice of chrome.storage.local this module uses (MV3: promise-returning). */
export interface SettingsStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type ServerUrlError = 'invalid' | 'insecure' | 'ipv6';
export type SaveResult =
  | { ok: true; settings: Settings }
  | { ok: false; field: 'serverUrl'; error: ServerUrlError }
  | { ok: false; field: 'token'; error: 'token_format' };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * True for a dotted-quad in 10/8, 172.16/12, 192.168/16, 127/8 loopback, 169.254/16 link-local
 * or 100.64/10 CGNAT. The literal is parsed before any range is considered, because a prefix
 * match would accept names that merely begin like an address: `10.evil.example.com` is a public
 * domain, and treating it as private would put the device token on the open internet in clear
 * text, which is the one thing this check exists to prevent.
 */
function isPrivateIpv4(host: string): boolean {
  const m = IPV4.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((o) => Number(o) > 255)) return false;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Hosts allowed over plain http (ADR-14, design D17). The canonical deployment is one machine
 * in a household reached from its phones and laptops, on a network with no certificate
 * authority and no public name, so refusing plain http there would refuse the product's normal
 * setup. A public host still needs https: a device token travels on every capture, and the
 * open internet is not a home network.
 *
 * The manifest declares http://*\/* because match patterns cannot express any of this; this
 * predicate is the real rule, and the browser still asks the user before granting one origin.
 * IPv6 literals stay refused: a match pattern cannot name them, so no permission for one could
 * ever be granted even if this accepted it.
 */
export function isPrivateHost(hostname: string): boolean {
  // A fully qualified name may carry the root's trailing dot; it names the same host.
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return false;
  if (host === 'localhost') return true;
  if (isPrivateIpv4(host)) return true;
  // A name the public DNS cannot resolve: mDNS, a home network's own zone (.home.arpa is the
  // standard one, .lan is what several router vendors ship), or no dot at all.
  return (
    host.endsWith('.local') ||
    host.endsWith('.home.arpa') ||
    host.endsWith('.lan') ||
    !host.includes('.')
  );
}
/** apps/server/src/lib/deviceTokens.ts: 'odt_' + base64url. */
const TOKEN_SHAPE = /^odt_[A-Za-z0-9_-]{16,200}$/;
const CAPTURE_PATH = '/api/v1/connector/capture';

export function parseServerUrl(
  input: string,
): { ok: true; base: string } | { ok: false; error: ServerUrlError } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'invalid' };
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'invalid' };
  }
  // No match pattern can name an IPv6 literal, so no permission for one could ever be granted.
  // Say that, rather than send the user off to find a certificate that would not help.
  if (url.hostname.startsWith('[')) return { ok: false, error: 'ipv6' };
  // The token travels in every request: plain http only on a network the user controls.
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return { ok: false, error: 'insecure' };
  }
  return { ok: true, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** True for a string shaped like a device token (odt_ + base64url). */
export const isDeviceToken = (token: string): boolean => TOKEN_SHAPE.test(token);

export const captureEndpoint = (base: string): string => `${base}${CAPTURE_PATH}`;

/**
 * The optional host permission the popup asks for so it may call the server. Match patterns
 * carry no port (a portless pattern matches every port), so a ported server such as
 * http://localhost:3000 asks for http://localhost/*, exactly a declared pattern, and behaves
 * the same in Chrome and Firefox.
 */
export const originPattern = (base: string): string => {
  const url = new URL(base);
  return `${url.protocol}//${url.hostname}/*`;
};

/** The packaged file and fetch, injected so this stays testable (popup.ts wires chrome.*). */
export interface BakedConfigSource {
  url(path: string): string;
  fetch(input: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/** The file the server adds to every download (routes/artifacts.ts SERVER_FILE). */
const BAKED_FILE = 'opportun-server.json';

/**
 * How long bakedServerUrl waits before giving up (issue #79). This value is already optional by
 * design: every other way the read can fail (missing file, malformed body, a refused address)
 * answers with an empty string rather than an error, because a build made from source has no
 * such file at all and that has to be an ordinary outcome, not a bug. A value the code is this
 * willing to do without is a value it should be unwilling to wait forever for, so a hang gets
 * the same empty-string answer on a deadline instead of standing in the caller's way
 * indefinitely. Two seconds is long enough for a local read in the ordinary case and short
 * enough that a popup is never unusable for longer than a person would describe as "slow".
 */
export const BAKED_CONFIG_TIMEOUT_MS = 2000;

/** Rejects after `ms` if `promise` has not settled by then; otherwise settles exactly as it would. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/**
 * The server address this copy of the extension was downloaded from (design D9). It exists so
 * the user pastes only a token: a clipboard holds one value, and Chrome's popup closes as soon
 * as it loses focus, so two values cannot be carried into one popup session.
 *
 * Empty whenever it cannot be trusted or does not exist, which is the normal case for a build
 * made from source, or whenever the read does not finish within BAKED_CONFIG_TIMEOUT_MS. It is a
 * default for an empty field, never an override of a saved address, and it goes through
 * parseServerUrl like anything a user types.
 */
export async function bakedServerUrl(source: BakedConfigSource): Promise<string> {
  try {
    const res = await withTimeout(source.fetch(source.url(BAKED_FILE)), BAKED_CONFIG_TIMEOUT_MS);
    if (!res.ok) return '';
    const body: unknown = await res.json();
    const raw = (body as { baseUrl?: unknown }).baseUrl;
    if (typeof raw !== 'string') return '';
    const parsed = parseServerUrl(raw);
    return parsed.ok ? parsed.base : '';
  } catch {
    return '';
  }
}

export async function loadSettings(storage: SettingsStorage, bakedUrl = ''): Promise<Settings> {
  const got = await storage.get(['serverUrl', 'token']);
  const saved = typeof got.serverUrl === 'string' ? got.serverUrl : '';
  return {
    // Saved settings always win; the baked address only fills an empty field.
    serverUrl: saved === '' ? bakedUrl : saved,
    token: typeof got.token === 'string' ? got.token : '',
  };
}

export async function saveSettings(storage: SettingsStorage, input: Settings): Promise<SaveResult> {
  const server = parseServerUrl(input.serverUrl);
  if (!server.ok) return { ok: false, field: 'serverUrl', error: server.error };
  const token = input.token.trim();
  if (!TOKEN_SHAPE.test(token)) return { ok: false, field: 'token', error: 'token_format' };
  const settings: Settings = { serverUrl: server.base, token };
  await storage.set({ serverUrl: settings.serverUrl, token: settings.token });
  return { ok: true, settings };
}
