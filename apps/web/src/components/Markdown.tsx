import ReactMarkdown from 'react-markdown';
import { safeHttpUrl } from '@/lib/opportunities';
import { cn } from '@/lib/utils';

/**
 * Renders user or AI-supplied markdown as React elements: raw HTML is dropped, and only
 * http(s) and mailto links survive. Styling lives in the .markdown rules in index.css.
 * Every rendered block wraps at reading width (max-w-prose, docs/design.md section 9), set here
 * so no call site has to remember it (issue https://github.com/bgoleno/opportun/issues/34).
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('markdown max-w-prose', className)}>
      <ReactMarkdown
        skipHtml
        urlTransform={(url) => (url.startsWith('mailto:') ? url : safeHttpUrl(url))}
        components={{
          a: ({ href, title, children }) => (
            <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
