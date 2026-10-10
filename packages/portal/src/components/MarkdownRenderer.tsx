import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { isValidElement, type ReactElement } from 'react';
import DocScreenshot from './DocScreenshot';

// Defined once at module level: an inline object would give `pre` a new identity on every render,
// remounting its subtree (and collapsing any expanded screenshot).
const MARKDOWN_COMPONENTS: Components = {
  // ```screenshot fenced blocks render as a collapsible screenshot (see DocScreenshot).
  pre({ node: _node, children, ...props }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement(child)) {
      const { className, children: code } = (child as ReactElement<{ className?: string; children?: unknown }>).props;
      if (className?.split(' ').includes('language-screenshot')) {
        return <DocScreenshot spec={String(code ?? '')} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },
};

interface MarkdownRendererProps {
  content: string;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="prose prose-slate max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSlug,
          [rehypeAutolinkHeadings, { behavior: 'wrap' }],
          rehypeHighlight,
        ]}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
