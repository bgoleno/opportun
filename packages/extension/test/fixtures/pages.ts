// Synthetic LinkedIn pages as the browser renders them, mirroring the server's capture
// fixtures (apps/server/test/fixtures/capture/pages.ts). Every person and company here is
// invented (Initech-style); none is a real member or page.
import { Window } from 'happy-dom';

export interface FixturePage {
  url: string;
  html: string;
}

/** Site chrome LinkedIn renders above every signed-in page, outside <main>. */
const NAV = `<header id="global-nav">
  <div>0 notifications total</div>
  <a href="#main">Skip to main content</a>
  <nav><div>Home</div><div>My Network</div><div>Jobs</div><div>Messaging</div><div>Me</div></nav>
</header>`;

const doc = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title>
  <script>window.__tracking = { never: 'captured' };</script></head>
  <body>${body}</body></html>`;

export const PROFILE: FixturePage = {
  url: 'https://www.linkedin.com/in/dana-testworth-0a1b2c/?originalSubdomain=us',
  html: doc(
    '(3) Dana Testworth | LinkedIn',
    `${NAV}
  <main id="main">
    <section>
      <h1>Dana Testworth</h1>
      <div>She/Her</div>
      <div>· 2nd</div>
      <div>VP of Platform Engineering at Initech | TPS report modernization</div>
      <div>Austin, Texas, United States</div>
      <div>Contact info</div>
      <div>500+ connections</div>
      <div>Initech</div>
      <button>Message</button>
      <button>Follow</button>
      <div style="display:none">Hidden overlay text</div>
    </section>
    <section>
      <h2>About</h2>
      <p>Building payment platforms at Initech since 2019.</p>
    </section>
    <section>
      <h2>Experience</h2>
      <div>VP of Platform Engineering</div>
      <div>Initech · Full-time</div>
      <div>Jan 2021 - Present · 3 yrs 10 mos</div>
      <div>Director of Engineering</div>
      <div>Globex Corporation</div>
      <div>2016 - 2020 · 4 yrs</div>
    </section>
    <section><h2>Education</h2><div>Example State University</div></section>
  </main>
  <aside><div>People also viewed</div><div>Avery Fixture</div></aside>`,
  ),
};

const JOB_MAIN = `<main id="main">
    <div>Initech</div>
    <h1>Staff Platform Engineer</h1>
    <div>Austin, TX · 2 days ago · 37 applicants</div>
    <div>Hybrid</div>
    <div>Full-time</div>
    <div>$200K/yr - $240K/yr</div>
    <button>Easy Apply</button>
    <button>Save</button>
    <section>
      <h2>About the job</h2>
      <p>Initech is modernizing its TPS reporting platform and needs a Staff Platform Engineer.</p>
      <h3>Responsibilities</h3>
      <div>- Own the payments platform end to end</div>
      <div>- Mentor the platform team</div>
      <h3>Requirements</h3>
      <div>- Go and Kubernetes in production</div>
    </section>
    <section><h2>About the company</h2><div>Initech</div><div>1,001-5,000 employees</div></section>
  </main>`;

export const JOB: FixturePage = {
  url: 'https://www.linkedin.com/jobs/view/3901234567/?refId=abc&trackingId=xyz',
  html: doc('Staff Platform Engineer | Initech | LinkedIn', `${NAV}${JOB_MAIN}`),
};

/** The jobs search split view: the visible detail pane is the job; the URL is not. */
export const JOB_SEARCH: FixturePage = {
  url: 'https://www.linkedin.com/jobs/search/?currentJobId=3901234567&keywords=platform',
  html: doc('Staff Platform Engineer | Initech | LinkedIn', `${NAV}${JOB_MAIN}`),
};

/** The newer jobs search results view: same split layout, same currentJobId parameter. */
export const JOB_SEARCH_RESULTS: FixturePage = {
  url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=3901234567&keywords=platform',
  html: doc('Staff Platform Engineer | Initech | LinkedIn', `${NAV}${JOB_MAIN}`),
};

/**
 * Shaped after issue #246's reported page: the same posting as JOB, but followed, still inside
 * <main>, by everything the owner's paste actually contained: a rail of unrelated "Promoted"
 * jobs with their own salaries, a LinkedIn Learning promo block, the global footer and a
 * language picker.
 */
const PROMOTED_RAIL = [
  ['Zillow', 'Senior Backend Engineer', '$150K/yr - $180K/yr'],
  ['LaunchDarkly', 'Product Manager', '$160K/yr - $190K/yr'],
  ['Render', 'Platform Engineer', '$140K/yr - $170K/yr'],
  ['Confluent', 'Staff Software Engineer', '$190K/yr - $220K/yr'],
  ['ClickUp', 'Engineering Manager', '$180K/yr - $210K/yr'],
  ['Northwind', 'Senior Data Engineer', '$155K/yr - $185K/yr'],
  ['ApartmentIQ', 'Full Stack Engineer', '$130K/yr - $160K/yr'],
  ['GitHub', 'Staff Product Manager', '$200K/yr - $230K/yr'],
  ['Ladders', 'Software Engineer', '$120K/yr - $150K/yr'],
  ['Netflix', 'Senior Platform Engineer', '$210K/yr - $250K/yr'],
  ['MongoDB', 'Product Manager, Platform', '$170K/yr - $200K/yr'],
]
  .map(
    ([company, title, salary]) =>
      `<div><div>Promoted</div><div>${title}</div><div>${company}</div><div>${salary}</div></div>`,
  )
  .join('\n');

const LANGUAGES = [
  'English',
  'Español',
  'Français',
  'Deutsch',
  '日本語',
  '한국어',
  'Português',
  'Italiano',
  'Nederlands',
  'Svenska',
  'Polski',
  'Türkçe',
  'العربية',
  'हिन्दी',
  'ไทย',
  'Tiếng Việt',
  'Bahasa Indonesia',
  'Bahasa Melayu',
  'Dansk',
  'Suomi',
  'Norsk',
  'Čeština',
  'Magyar',
  'Română',
  'Українська',
  'Ελληνικά',
  'עברית',
  'Bahasa',
  '简体中文',
  '繁體中文',
  'Русский',
  'Slovenčina',
  'Hrvatski',
  'български',
]
  .map((l) => `<div>${l}</div>`)
  .join('\n');

const TRAILING_NOISE = `
  <div>
    <h2>More jobs for you</h2>
    ${PROMOTED_RAIL}
  </div>
  <div>
    <div>Mastering Platform Engineering · 12,345 viewers</div>
    <div>Staff Engineer Career Paths · 8,210 viewers</div>
    <div>Show more on LinkedIn Learning</div>
  </div>
  <footer>
    <div>Select language</div>
    ${LANGUAGES}
    <div>About</div>
    <div>Accessibility</div>
    <div>User Agreement</div>
    <div>Privacy Policy</div>
    <div>Cookie Policy</div>
    <div>Copyright Policy</div>
    <div>Brand Policy</div>
    <div>Guest Controls</div>
    <div>Community Guidelines</div>
    <div>LinkedIn Corporation © 2026</div>
  </footer>`;

// A real LinkedIn job posting is usually a few paragraphs plus several bullet lists, long
// enough that it is the bulk of the page even once the rail, promos, footer and language
// picker are appended (confirmed directly: the owner's own real captures keep the posting at
// 77-87% of the page once cut at the rail's first "Promoted" card). A three-sentence fixture
// posting next to that much trailing noise does not reflect that proportion, so this one is
// written at a realistic length instead.
const JOB_DESCRIPTION = `
    <section>
      <h2>About the job</h2>
      <p>Initech is modernizing its TPS reporting platform and needs a Staff Platform Engineer to
      own the payments platform end to end.</p>
      <p>You will partner with finance, risk and the core banking team to replace a decade-old
      batch reporting pipeline with a real-time one, without ever losing a single reconciled
      cent along the way. This is a hands-on, staff-level role: you will design the system,
      write a meaningful share of the code yourself, and mentor the two senior engineers who
      will own it with you once it is live.</p>
      <p>Initech's platform team runs the shared infrastructure every product team at the
      company depends on: the event bus, the batch and streaming job schedulers, the
      reconciliation ledger, and the internal developer tooling that lets every other team ship
      without touching any of it directly. This role sits at the center of that team's current
      bet: moving the TPS reporting pipeline from an overnight batch job to a system that
      reconciles every transaction within minutes of it clearing, while preserving the audit
      trail finance and compliance already rely on.</p>
      <h3>Responsibilities</h3>
      <div>- Own the payments platform end to end, from design through on-call</div>
      <div>- Mentor the platform team, in design reviews and in the code itself</div>
      <div>- Partner with finance and risk on reconciliation guarantees</div>
      <div>- Drive the migration off the legacy batch pipeline onto the new streaming one</div>
      <div>- Define the SLOs the rest of the company builds against</div>
      <div>- Run blameless postmortems when those SLOs slip, and fix the root cause</div>
      <h3>Requirements</h3>
      <div>- 8+ years building and operating backend platforms in production</div>
      <div>- Go and Kubernetes in production, at a scale of hundreds of services</div>
      <div>- Experience with financial reconciliation or ledger-style systems</div>
      <div>- A track record of mentoring senior engineers, not just reviewing their PRs</div>
      <div>- Comfort being the person paged at 2am when the reconciliation job stalls</div>
      <h3>Benefits</h3>
      <div>- Comprehensive medical, dental and vision coverage from day one</div>
      <div>- A 401(k) match and an annual learning stipend</div>
      <div>- Flexible PTO and a genuinely enforced right to use it</div>
    </section>`;

// Deliberately has no "About the company" section: the real posting ends with Benefits and the
// noise starts immediately after, so nothing here can lean on that heading as an incidental
// stop marker the way JOB_MAIN's own layout would.
const JOB_WITH_RAIL_MAIN = `<main id="main">
    <div>Initech</div>
    <h1>Staff Platform Engineer</h1>
    <div>Austin, TX · 2 days ago · 37 applicants</div>
    <div>Hybrid</div>
    <div>Full-time</div>
    <div>$200K/yr - $240K/yr</div>
    <button>Easy Apply</button>
    <button>Save</button>
    ${JOB_DESCRIPTION}
    ${TRAILING_NOISE}
  </main>`;

export const JOB_WITH_RAIL: FixturePage = {
  url: 'https://www.linkedin.com/jobs/view/3901234567/?refId=abc&trackingId=xyz',
  html: doc('Staff Platform Engineer | Initech | LinkedIn', `${NAV}${JOB_WITH_RAIL_MAIN}`),
};

// The posting itself is a sponsored listing and carries its own early "Promoted" badge, well
// before the real rail's own cards. A naive "first marker wins" rule would cut right there,
// below half the page, and lose the entire real description; this fixture exists to prove the
// extractor instead skips that early hit and cuts at the genuine rail boundary later on.
const JOB_WITH_EARLY_PROMOTED_MAIN = `<main id="main">
    <div>Initech</div>
    <h1>Staff Platform Engineer</h1>
    <div>Austin, TX · 2 days ago · 37 applicants</div>
    <div>Hybrid</div>
    <div>Full-time</div>
    <div>$200K/yr - $240K/yr</div>
    <button>Easy Apply</button>
    <button>Save</button>
    <div>Promoted</div>
    ${JOB_DESCRIPTION}
    ${TRAILING_NOISE}
  </main>`;

export const JOB_WITH_EARLY_PROMOTED_BADGE: FixturePage = {
  url: 'https://www.linkedin.com/jobs/view/3901234567/?refId=abc&trackingId=xyz',
  html: doc(
    'Staff Platform Engineer | Initech | LinkedIn',
    `${NAV}${JOB_WITH_EARLY_PROMOTED_MAIN}`,
  ),
};

// No rail, no footer, nothing but a posting followed directly by a Learning promo: isolates the
// end-anchored "linkedin learning" marker as the one actually making the cut.
const JOB_WITH_LEARNING_ONLY_MAIN = `<main id="main">
    <div>Initech</div>
    <h1>Staff Platform Engineer</h1>
    <section>
      <h2>About the job</h2>
      <p>Initech is modernizing its TPS reporting platform and needs a Staff Platform Engineer.</p>
      <h3>Requirements</h3>
      <div>- Go and Kubernetes in production</div>
    </section>
    <div>
      <div>Mastering Platform Engineering · 12,345 viewers</div>
      <div>Show more on LinkedIn Learning</div>
    </div>
  </main>`;

export const JOB_WITH_LEARNING_ONLY: FixturePage = {
  url: 'https://www.linkedin.com/jobs/view/3901234567/?refId=abc&trackingId=xyz',
  html: doc('Staff Platform Engineer | Initech | LinkedIn', `${NAV}${JOB_WITH_LEARNING_ONLY_MAIN}`),
};

/** The signed-in home feed: names and headlines everywhere, but no single profile or job. */
export const FEED: FixturePage = {
  url: 'https://www.linkedin.com/feed/',
  html: doc(
    '(5) Feed | LinkedIn',
    `${NAV}
  <main id="main">
    <div>Start a post</div>
    <article><div>Dana Testworth</div><div>VP of Platform Engineering at Initech</div>
      <p>Excited to share that Initech shipped TPS v2!</p></article>
    <article><div>Avery Fixture</div><div>Recruiter at Initech</div>
      <p>We are hiring a Staff Platform Engineer.</p></article>
  </main>`,
  ),
};

/**
 * A pathological page where a noise marker appears with almost nothing ahead of it: an early,
 * over-eager cut would discard everything, which is the one outcome this extractor refuses no
 * matter what it recognizes (#246's failure-mode requirement: capturing noise is annoying,
 * capturing nothing is a silent data loss on a button the user pressed on purpose).
 */
export const MOSTLY_NOISE: FixturePage = {
  url: 'https://www.linkedin.com/jobs/view/1/',
  html: doc(
    'A Role | Some Co | LinkedIn',
    `<main id="main"><div>A Role</div><div>Promoted</div></main>`,
  ),
};

/** A page without a <main> landmark: the extractor falls back to <body>. */
export const NO_MAIN: FixturePage = {
  url: 'https://www.linkedin.com/in/dana-testworth-0a1b2c/',
  html: doc(
    'Dana Testworth | LinkedIn',
    `<div><h1>Dana Testworth</h1><div>VP of Platform Engineering at Initech</div></div>`,
  ),
};

/** Load a fixture into a fresh happy-dom window and return its document. */
export function load(page: FixturePage): Document {
  const window = new Window({ url: page.url });
  window.document.write(page.html);
  return window.document as unknown as Document;
}
