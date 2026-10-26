// Links out to pages on other people's sites. They move, so they live here as the single
// source of truth and the docs that repeat them are checked against these values by a test
// (components/importExport/dataSettings.test.tsx), which fails the build when one is updated
// and the other is not. Nothing here is ever fetched by Opportun: linkedin.com is in
// safeFetch's PROHIBITED_HOSTS (C-1) and these are links the user clicks.

/** LinkedIn's "Download my data" page, where the user requests their archive (FR-C2). */
export const LINKEDIN_DATA_EXPORT_URL = 'https://www.linkedin.com/mypreferences/d/download-my-data';

/** LinkedIn's own help article, as the fallback when the direct link stops working. */
export const LINKEDIN_DATA_EXPORT_HELP_URL =
  'https://www.linkedin.com/help/linkedin/answer/a1339364/downloading-your-account-data';

/** The guide page for the browser extension (design D12): GitHub main for now, swappable to
 * the planned opportun.app docs site. */
export const BROWSER_EXTENSION_GUIDE_URL =
  'https://github.com/bgoleno/opportun/blob/main/docs/guide/browser-extension.md';
