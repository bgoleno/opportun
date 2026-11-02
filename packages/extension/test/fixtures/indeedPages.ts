// Synthetic Indeed pages for the capture tests (https://github.com/bgoleno/opportun/issues/74),
// built to the structure in the Indeed capture text contract
// (https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179). Everything here is a
// placeholder: no real company, person, account or job. Job keys are obviously fake hex, and
// there are no banner or logo URLs, no hrefs with query strings, no tracking parameters and no
// aria-label text from the real site. Markup anchors only on data-testid, role and ids, the way
// the extension does.
import type { FixturePage } from './pages';

/** The job both layouts show. */
export const JK = '00000000deadbeef';

/** Other jobs' keys: the results list and the recommended block. */
const OTHER_KEYS = ['00000000000000a1', '00000000000000a2', '00000000000000a3'];

const doc = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title>
  <script>window.__tracking = { never: 'captured' };</script></head>
  <body>${body}</body></html>`;

/** The global nav, outside the job root on both layouts (and outside <main> on the split view). */
const GNAV = `<div id="m-gnav-header">
  <nav id="gnav-main-container">
    <a href="/">Example Logo</a>
    <a href="/jobs">Find jobs</a>
    <a href="/companies">Company reviews</a>
    <a href="/myjobs">My jobs</a>
    <a href="/inbox">Inbox</a>
    <a href="/notifications">Notifications</a>
    <button id="AccountMenu">Account Holder Placeholder</button>
  </nav>
</div>`;

const FOOTER = `<div id="m-gnav-footer"><div>Footer Placeholder Line</div></div>`;

/** Results list card: must never reach the server. */
const resultCard = (jk: string, n: number): string => `<li>
  <div class="slider_container" data-testid="slider_container">
    <div class="slider_item" data-testid="slider_item">
      <table class="mainContentTable" role="presentation"><tbody><tr><td>
        <h3 class="jobTitle"><a class="jcs-JobTitle" role="button" data-jk="${jk}"><span>Results List Title ${n}</span></a></h3>
        <div data-testid="timing-attribute">
          <span data-testid="company-name">Results List Company ${n}</span>
          <div data-testid="text-location">Results List City ${n}, ST</div>
        </div>
        <ul class="metadataContainer"><li>Results List Pay ${n}</li><li>Full-time</li></ul>
      </td></tr></tbody></table>
    </div>
  </div>
</li>`;

/** The recommended jobs block after the description: must never reach the server. */
const RECOMMENDED = `<div>
  <h4 role="heading">Placeholder Recommended jobs</h4>
  <button>Previous</button><button>Next</button>
  ${OTHER_KEYS.map(
    (jk, i) => `<div data-testid="job-card-${jk}"><a><div data-testid="job-card-container">
      <button data-testid="inner-view-details-pressable"><h4 role="heading">Recommended Title ${i + 1}</h4></button>
      <div>Recommended Company ${i + 1}</div><div>Recommended Pay ${i + 1}</div>
      <div role="toolbar"><button>Save</button><button data-testid="dislikeJobButton">Not interested</button></div>
    </div></a></div>`,
  ).join('\n')}
</div>`;

export interface JobRootOptions {
  layout: 'split' | 'viewjob';
  /** Split view: the full header hidden and the sticky compact copy showing (structure 1.4). */
  compactHeaderShowing?: boolean;
  title?: string;
  company?: string;
  /** Leave out a named part to model a layout change. */
  omit?: ('title' | 'company' | 'heading' | 'description')[];
  /** The description body's HTML (default DESCRIPTION_HTML). */
  descriptionHtml?: string;
  withSummary?: boolean;
}

export const TITLE = 'Senior Example Engineer - Platform';
export const COMPANY = 'Example Corp';

export const DESCRIPTION_HTML = `<style>.placeholder-style { color: red; }</style>
  <div>Example Corp builds placeholder software for example customers.</div>
  <div><b>What you will do</b></div>
  <div>Design and run example services.</div>
  <div>Review placeholder code with the team.</div>
  <div><b>What you bring</b></div>
  <div>Five years of example experience.</div>`;

/** The job component `[data-testid=viewjob-main-content]`, shared by both layouts. */
export function jobRoot(o: JobRootOptions): string {
  const omit = new Set(o.omit ?? []);
  const title = o.title ?? TITLE;
  const company = o.company ?? COMPANY;
  const split = o.layout === 'split';
  const hidden = split && o.compactHeaderShowing === true ? ' style="visibility: hidden"' : '';
  const compactText = split && o.compactHeaderShowing === true;
  const metaSeparator = split ? '<div>•</div>' : '';
  return `<div data-testid="viewjob-main-content">
  <style>.css-placeholder { display: flex; }</style>
  ${
    split
      ? ''
      : `<div data-testid="standalone-desktop-search-page"><div data-testid="standalone-desktop-search-form">
      <div data-testid="standalone-desktop-search-shell">
        <input data-testid="standalone-desktop-search-what" value="placeholder query">
        <input data-testid="standalone-desktop-search-where" value="placeholder place">
        <button data-testid="standalone-desktop-search-submit">Search Button Placeholder</button>
      </div></div></div>`
  }
  <div data-testid="desktop-branded-banner">
    <div data-testid="company-banner-wrapper"></div>
    <div data-testid="desktop-branded-logo-position"><div data-testid="company-logo-shadow"><div data-testid="company-logo"></div></div></div>
  </div>
  <div data-testid="desktop-branded-title-reservation"></div>
  ${split ? '<div data-testid="desktop-header-sticky-sentinel"></div>' : ''}
  <div data-testid="desktop-job-header">
    <div data-testid="company-info-title-row"${hidden}>
      ${omit.has('title') ? '' : `<h5 data-testid="vj-job-title" role="heading">\n        ${title}\n      </h5>`}
    </div>
    <div data-testid="company-info-metadata"${hidden}>
      ${omit.has('company') ? `<span>${company}</span>` : `<a role="link">${company}</a>`}
      <div>·</div>
      <div>4.0</div>
      <div>Springfield, ST</div>
      ${metaSeparator}
      <div>Remote</div>
    </div>
    <div data-testid="desktop-embedded-compact-header">${
      compactText
        ? `<h4 data-testid="vj-job-title-compact" role="heading">${title}</h4>
      <a role="link">${company}</a><div>•</div><div>Springfield, ST • Remote</div><div>•</div><div>$100 - $120 an hour</div>`
        : ''
    }</div>
    <div data-testid="job-header-actions">
      <div data-testid="primary-apply-action"><a data-testid="viewjob-indeed-apply" role="link">Apply now</a></div>
      <div data-testid="save-job-action"><button data-testid="vj-saveJobButton">Save</button></div>
      <div data-testid="dislike-job-action"><button data-testid="vj-dislikeJobButton">Not interested</button></div>
      <div data-testid="share-job-action"><button data-testid="desktop-share-dropdown-trigger">Share</button></div>
    </div>
  </div>
  ${
    split
      ? ''
      : `<div role="tablist">
    <div role="tab">Job details Tab Placeholder</div>
    <div role="tab">Company Tab Placeholder</div>
  </div>`
  }
  <div data-testid="viewjob-job-content">
    ${
      o.withSummary === false
        ? ''
        : `<div data-testid="structured-job-summary">
      <h4 role="heading">Job details</h4>
      <div>$100 - $120 an hour</div>
      <div>Monday to Friday</div>
      <div>Full-time</div>
    </div>`
    }
    <div></div>
    <div>
      ${omit.has('heading') ? '' : '<h4 data-testid="vj-job-description-heading" role="heading">Full job description</h4>'}
      <div data-testid="vj-rcv-flag-sentinel-jobDescriptionTitleSeen">Sentinel Title Seen</div>
      <div>${omit.has('description') ? '' : (o.descriptionHtml ?? DESCRIPTION_HTML)}</div>
      <div data-testid="vj-rcv-flag-sentinel-jobDescriptionSeen">Sentinel Description Seen</div>
      <div></div><div></div>
    </div>
    ${RECOMMENDED}
  </div>
  <div><button data-testid="vj-report-job">Report job</button></div>
  <div></div>
</div>`;
}

/** The split view: results list on the left, the job pane on the right, one <main> around both. */
export function splitView(o: Omit<JobRootOptions, 'layout'> = {}, pane = true): FixturePage {
  return {
    url: `https://www.indeed.com/jobs?q=placeholder+query&l=Springfield%2C+ST&vjk=${JK}`,
    html: doc(
      'Now Hiring: 99 Placeholder Query Jobs in Springfield, ST | Indeed',
      `${GNAV}
  <main class="is-i18n">
    <div id="jobsearch-Main"><div><div id="jobsearch-JapanPage"><div class="jobsearch-JapanPageLayout"><div><div>
      <div class="jobsearch-LeftPane">
        <div id="mosaic-jobResults" class="mosaic-zone"><div id="mosaic-provider-jobcards"><ul>
          ${[JK, ...OTHER_KEYS].map((jk, i) => resultCard(jk, i + 1)).join('\n')}
        </ul></div></div>
      </div>
      <div class="jobsearch-RightPane">
        <div id="jobsearch-ViewjobPaneWrapper" role="region">
          <button class="visible-on-focus-only top">Skip to Placeholder</button>
          <h2>Job Post Details</h2>
          <div data-testid="rnvj-content-layer"><div id="rnvjContainerDesktop">
            ${pane ? jobRoot({ ...o, layout: 'split' }) : '<div>Pane Loading Placeholder</div>'}
          </div></div>
        </div>
      </div>
    </div></div></div></div></div></div>
  </main>
  ${FOOTER}`,
    ),
  };
}

/** The single posting page: no <main>, the job root inside plain divs, the nav around it. */
export function viewjobPage(o: Omit<JobRootOptions, 'layout'> = {}, root = true): FixturePage {
  return {
    url: `https://www.indeed.com/viewjob?jk=${JK}&from=placeholder`,
    html: doc(
      `${o.title ?? TITLE} - Springfield, ST - Indeed.com`,
      `${GNAV}
  <div id="root"><div><div><div><div>
    ${root ? jobRoot({ ...o, layout: 'viewjob' }) : '<div>Placeholder page body without a job</div>'}
  </div></div></div></div></div>
  ${FOOTER}`,
    ),
  };
}

/** Text that must never appear in what the extension sends. */
export const NEVER_SENT = [
  'Account Holder Placeholder',
  'Find jobs',
  'My jobs',
  'Inbox',
  'Notifications',
  'Footer Placeholder Line',
  'Results List',
  'Recommended',
  'Report job',
  'Apply now',
  'Search Button Placeholder',
  'Tab Placeholder',
  'Sentinel',
  'Skip to Placeholder',
  'Job Post Details',
  'Now Hiring',
  'placeholder-style',
  'css-placeholder',
  '__tracking',
];
