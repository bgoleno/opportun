# ADR-14: LAN-first access over plain HTTP; TLS recommended, never required

- **Status:** Accepted 2026-10-18; amended the same day (decision 7) to change the Compose
  bind default after the owner's own conversion to Docker showed the loopback default
  reproduces the exact failure this ADR exists to prevent.
- **Deciders:** the owner (owner), recorded while designing in-app extension downloads.
- **Related:** `docs/superpowers/specs/2026-10-18-extension-downloads-design.md`, ADR-10 (Apple
  Mail connector), C-1 (no automated LinkedIn retrieval).
- **Amended 2026-10-22 (issue #333):** decision 2's per-request `Secure` derivation depends on
  which proxies are trusted for `X-Forwarded-*`. That trust is no longer the broad
  `['loopback','linklocal','uniquelocal']` default this ADR was written against (which let any
  LAN client spoof its own address past the per-IP rate limits); it is now an explicit
  `OPPORTUN_TRUSTED_PROXIES` list, empty by default (trust nothing). This does not weaken decision
  2 for the canonical LAN install: a directly reached instance derives `Secure` from the socket
  scheme, with no proxy in the path, so nothing changes for it. The Compose deployment pins its
  network subnet and sets `OPPORTUN_TRUSTED_PROXIES` to cover Caddy, which is what keeps the
  per-request derivation working behind the proxy; that wiring is the subnet pin and
  `OPPORTUN_TRUSTED_PROXIES` line in `deploy/compose.yml`.

## Context

The canonical deployment is a household, not a data centre. A user runs Opportun on their own
desktop or laptop and reaches it from a phone or tablet on the couch, or another member of the
household reaches it from their own desktop. One machine, several client devices, a home
network, no public DNS and no certificate authority.

Until 2026-10-18 the owner's own instance did not look like that. It bound `127.0.0.1` only and
was published through `tailscale serve`, which gave it a publicly-trusted https hostname
(`<host>.<tailnet>.ts.net`). That configuration is not how users will consume the
product, and it distorted design decisions: the capture extension's https-only server rule
(`packages/extension/src/settings.ts`, `LOCAL_HOSTS`) was written against it, as was the choice
to derive the `Secure` cookie flag from `OPPORTUN_BASE_URL`. On 2026-10-18 the owner removed the
tailnet route and reconfigured the instance to bind every interface and serve plain HTTP, in
order to develop against the real shape.

Four facts constrain any TLS requirement, and they were checked rather than assumed:

- **`.local` names can never hold a publicly-trusted certificate.** `.local` is a reserved mDNS
  namespace and public CAs may not issue for it. `https://<machine>.local:8080` with a trusted
  certificate does not exist at any price, and `<machine>.local` is exactly the address macOS
  advertises to the phone on the couch.
- The remaining routes to trusted TLS are a VPN that provisions certificates for its own
  namespace (Tailscale and `*.ts.net`), a real domain validated by a DNS-01 challenge (which
  needs a Caddy build carrying that DNS provider's plugin plus an API token), or a private CA
  installed on every client device (on iOS, a configuration profile plus a manual full-trust
  toggle under Settings > General > About > Certificate Trust Settings).
- Each of those excludes the target user, who owns no domain, runs no VPN and will not install a
  root certificate on a tablet.
- Google is the one dependency that genuinely resists plain HTTP: it rejects non-https OAuth
  redirect URIs for every host except `localhost` and `127.0.0.1`.

## Decision

1. **Plain HTTP over a private network is a first-class, supported access path.** TLS is
   recommended for an internet-exposed install and is never required on a LAN. The owner's
   position, stated 2026-10-18: "I am on my own LAN and I am not concerned with TLS."
2. **No runtime behavior may assume a single canonical origin.** One install is reachable
   simultaneously at `localhost` on the host machine, at `<machine>.local` from another device,
   and at a LAN IP, and `OPPORTUN_BASE_URL` can only name one of them. Concretely, the `Secure`
   flag on the session and CSRF cookies must be derived from the request, not from
   `OPPORTUN_BASE_URL` as it is today (`routes/auth.ts:152`, `routes/auth.ts:172`,
   `routes/oauthLogin.ts:187`).
3. **`OPPORTUN_BASE_URL` keeps its narrower jobs**: Google's OAuth redirect URI
   (`app.ts:225`, `routes/googleAuth.ts:84`) and the HSTS decision (`app.ts:206`). For a LAN
   install it should be `http://localhost:<port>`, which is the only value that is both legal for
   Google and non-https (so cookies are not marked `Secure` and LAN logins work).
4. **The Google connection is established once, from a browser on the machine running
   Opportun.** This follows from point 3 and from Google's redirect-URI rules; it is not a
   limitation Opportun can remove. The app already carries the machinery for saying so:
   `requiredOrigin` and `OriginWarning` in `apps/web/src/routes/settings/-googleOrigin.tsx`.
5. **The capture extension accepts plain HTTP for private hosts.** Chrome match patterns cannot
   express "private host", so the manifest declares `http://*/*` among its
   `optional_host_permissions` while `parseServerUrl` enforces the precise rule: http is allowed
   for `localhost`, `.local`, `.lan` and `.home.arpa` names, names with no dots, and RFC1918,
   CGNAT, loopback and link-local IPv4 addresses, and still refused for public hosts. An address
   is parsed and range-checked rather than prefix-matched, because `10.evil.example.com` is a
   public domain. **IPv6 literals are not supported at all**, over either scheme: a Chrome match
   pattern cannot name one, so the permission could never be granted, and the extension says so
   rather than suggesting https would help. Declaring an optional permission grants nothing until
   the popup requests that one origin and the user approves it.
6. **Both install paths default to loopback, in different places, and both must be told how to
   reach the LAN.** On bare node, `OPPORTUN_HOST` defaults to `127.0.0.1` (`config.ts:144`). On
   Docker the container itself is fine (`deploy/Dockerfile` sets `OPPORTUN_HOST=0.0.0.0`), but
   `deploy/compose.yml` publishes Caddy at
   `${OPPORTUN_BIND_ADDRESS:-127.0.0.1}:${OPPORTUN_HTTP_PORT:-8080}:80`, so a Compose user is
   equally unreachable from the couch until they set `OPPORTUN_BIND_ADDRESS=0.0.0.0`. The same
   user-facing defect exists at two different layers; neither install path reaches another device
   out of the box.

7. **The Compose deployment publishes on every interface by default.**
   `OPPORTUN_BIND_ADDRESS` defaults to `0.0.0.0` in `.env.example` and in `deploy/compose.yml`,
   rather than `127.0.0.1`. A default that makes this ADR's canonical deployment fail, with no
   error the user can see and no sign that a setting is responsible, is the wrong default.
   Restricting it to the host stays available by setting `127.0.0.1`.

   The framing mattered as much as the value: `0.0.0.0` previously appeared only under
   "Exposing to the internet", alongside a domain and TLS, so a user who wanted nothing but
   their own phone on their own sofa had no reason to think the setting was theirs. The
   install guide now has "2.1 Reaching it from another device" as its own section.

   The bare-node default (`OPPORTUN_HOST`, `config.ts:144`) is deliberately **not** changed in
   the same stroke. The risk profiles differ: on Compose the exposed listener is Caddy, a
   hardened reverse proxy, with the application container not published at all, while on bare
   node it would be the Node process itself with nothing in front of it. Bare node is also the
   contributor path rather than the path a new user is sent down. Issue #24 keeps that half open.

## Consequences

Accepted costs, stated plainly because they are real:

- **Session cookies and device tokens cross the LAN in clear text.** Anyone on the network can
  read them, and on a shared home or apartment network that includes guests and untrusted
  devices. The owner accepted this explicitly for a home LAN.
- **No HSTS on a plain-HTTP install**, since `app.ts:206` keys it off the base URL's scheme.
- **Google cannot be connected from the couch**, only from the host machine.
- A LAN-bound server is reachable by every device on the network, including whatever else is on
  it. Binding a specific interface instead of `0.0.0.0` narrows this; `0.0.0.0` also exposes VM
  and VPN interfaces, which on the owner's machine meant the app stayed reachable at its
  Tailscale IP after the published tailnet hostname was removed.
- Opening either default widens exposure deliberately. On Docker, `OPPORTUN_BIND_ADDRESS=0.0.0.0`
  publishes Caddy on every host interface; on bare node, `OPPORTUN_HOST=0.0.0.0` does the same for
  the server process.

Follow-ups filed separately rather than folded into the extension work: the per-request `Secure`
derivation, the `OPPORTUN_HOST` default for bare-node installs, the `OriginWarning` copy (which
currently tells a phone user to "open http://localhost:8080", meaning the phone itself), and the
install documentation for reaching an instance from another device.

## Rejected alternatives

- **Require TLS everywhere.** Impossible for the `.local` address the target user will actually
  type, and the workarounds (VPN, owned domain plus a DNS plugin, private CA on every device)
  each exclude that user.
- **Keep a VPN as the supported path.** It worked, and it is what the owner ran until
  2026-10-18, but it is not how the product will be consumed and it hid this entire class of
  problem from the design.
- **Self-signed or private-CA certificates.** Per-device trust installation, worst on iOS and
  repeated at every renewal, for a warning most users would click through anyway.
- **Make the extension https-only and let the web app be http.** Internally inconsistent: it
  would mean the primary setup flow hands the user a pre-filled server address that the
  extension then refuses to save.
