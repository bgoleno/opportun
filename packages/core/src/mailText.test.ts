import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText, splitAddresses } from './index';

// One implementation serves the server's Gmail adapter and the Apple Mail connector CLI.
describe('mail text helpers', () => {
  it('decodes named and numeric entities, leaving unknown ones alone', () => {
    expect(decodeEntities('a&amp;b &#39;c&#x27; &bogus; &#0;')).toBe("a&b 'c' &bogus; &#0;");
  });

  it('strips html to text with block ends as newlines', () => {
    expect(htmlToText('<div>A&nbsp;&#39;quoted&#x27;</div><div>B</div><!-- c -->')).toBe(
      "A 'quoted'\nB",
    );
    expect(htmlToText('<style>p{}</style><script>x()</script><p>Hi<br>there</p>')).toBe(
      'Hi\nthere',
    );
  });

  it('keeps links as "text (url)" when asked', () => {
    expect(
      htmlToText('<p>Apply <a href="https://x.example/job?a=1&amp;b=2">here</a></p>', {
        keepLinks: true,
      }),
    ).toBe('Apply here (https://x.example/job?a=1&b=2)');
    expect(htmlToText('<a href="javascript:alert(1)">bad</a>', { keepLinks: true })).toBe('bad');
  });

  it('splits address lists on commas outside quotes and angle brackets', () => {
    expect(splitAddresses('"Doe, Jane" <jane@x.example>, bob@y.example , ')).toEqual([
      '"Doe, Jane" <jane@x.example>',
      'bob@y.example',
    ]);
    expect(splitAddresses('')).toEqual([]);
  });
});

// core compiles without DOM or node types (see mailText.ts).
declare const URL: new (input: string) => { readonly protocol: string; readonly href: string };

// The implementation before the linear-time rewrite (review F2), kept verbatim as the oracle
// for the output-equivalence fixtures below.
function legacyHtmlToText(html: string, opts: { keepLinks?: boolean } = {}): string {
  const anchor = /<a\b([^>]*)>([^]*?)<\/a\s*>/gi;
  const hrefRe = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  const link = (attrs: string): string | null => {
    const m = hrefRe.exec(attrs);
    const raw = decodeEntities((m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim());
    if (raw === '' || raw.length > 2000) return null;
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  };
  const source =
    opts.keepLinks === true
      ? html.replace(anchor, (_w, attrs: string, inner: string) => {
          const url = link(attrs);
          if (url === null) return inner;
          const text = inner
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text === '') return ` (${url}) `;
          return text.includes(url) ? ` ${text} ` : ` ${text} (${url}) `;
        })
      : html;
  const text = source
    .replace(/<(script|style|head)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const FIXTURES = [
  '<div>A&nbsp;&#39;quoted&#x27;</div><div>B</div><!-- c -->',
  '<html><head><style>p{}</style></head><body><p>Hi &amp; welcome</p><script>x()</script><br>Line two</body></html>',
  '<p>Apply <a href="https://job-boards.greenhouse.io/acme/jobs/1">here</a></p>',
  '<a href="https://x.example/job?gh_jid=42&amp;board=acme">Role</a>',
  '<a href="https://x.example/job/1">https://x.example/job/1</a>',
  '<a href="https://x.example/job/1"><img src="b.png"></a>',
  '<a href="javascript:go()">A</a> <a href="/careers">B</a> <a href="mailto:x@y.example">C</a>',
  '<div>Next steps: <a href="https://www.brightforge.example/careers/job?gh_jid=5550003003&amp;board=brightforge">the role</a></div>',
  '<SCRIPT type="x">a<b</SCRIPT ><P>One</P >Two<BR/>Three<h2>T</h2><ul><li>x</li><li>y</li></ul>',
  '<table><tr><td>a</td><td>b</td></tr></table><blockquote>q</blockquote>   \r\n\n\n\n end',
  '<!-- unclosed comment <p>still text</p>',
  "<a href='https://x.example/a'>single</a> <a href=https://x.example/b>bare</a> <a>no href</a>",
  '<a href="https://x.example/c">unclosed anchor',
  'x < y and y > z, &lt;tag&gt; &bogus; &#0;',
  '<style>a{}</style><style>unclosed',
];

describe('htmlToText rewrite', () => {
  it.each(FIXTURES)('matches the previous output for %s', (html) => {
    expect(htmlToText(html)).toBe(legacyHtmlToText(html));
    expect(htmlToText(html, { keepLinks: true })).toBe(legacyHtmlToText(html, { keepLinks: true }));
  });

  const hostile: Array<[string, string]> = [
    ['unclosed anchors', '<a href='.repeat(62_500)],
    ['unclosed scripts', '<script>'.repeat(62_500)],
    ['unclosed styles with attributes', '<style x=1 '.repeat(45_000)],
    ['unclosed comments', '<!--'.repeat(125_000)],
    ['bare angle brackets', '<'.repeat(500_000)],
    ['unclosed br', '<br '.repeat(125_000)],
    ['anchors without a close tag', '<a href="https://x.example/">x'.repeat(16_000)],
    ['closing tags with runaway whitespace', `</p${' '.repeat(1000)}`.repeat(500)],
  ];
  it.each(hostile)('converts %s in linear time', (_name, html) => {
    for (const keepLinks of [false, true]) {
      const started = Date.now();
      htmlToText(html, { keepLinks });
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('caps the converted input at 200k characters, marking the cut', () => {
    const html = `<p>${'x'.repeat(300_000)}</p><p>tail</p>`;
    const text = htmlToText(html);
    expect(text.endsWith('\n[truncated]')).toBe(true);
    expect(text).not.toContain('tail');
    expect(text.length).toBeLessThanOrEqual(200_000 + '\n[truncated]'.length);
    expect(htmlToText('<p>short</p>')).toBe('short');
  });

  it('applies the cap after scripts and styles are dropped, so a page heavy with them keeps its text', () => {
    const html = `<script>${'s'.repeat(400_000)}</script><p>Job description</p>`;
    expect(htmlToText(html)).toBe('Job description');
  });
});
