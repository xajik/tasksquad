import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { isValidElement, type ReactElement } from 'react';
import DocScreenshot from './DocScreenshot';
import { DesignSystemExample } from './DesignSystemExample';

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

const DESIGN_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  pre({ node: _node, children, ...props }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement<{ className?: string; children?: unknown }>(child) &&
        child.props.className?.split(' ').includes('language-design-example') &&
        String(child.props.children).trim() === 'graph-controls') {
      return <DesignSystemExample />;
    }
    return <pre {...props}>{children}</pre>;
  },
  table({ node: _node, children }) {
    return <div className="my-4 max-w-full overflow-x-auto rounded-lg border [contain:inline-size]">
      <table className="w-full text-left text-sm">{children}</table>
    </div>;
  },
  th({ node: _node, children }) {
    return <th scope="col" className="bg-muted px-3 py-2 font-semibold">{children}</th>;
  },
  td({ node: _node, children }) {
    const hex = typeof children === 'string' && /^#[0-9a-f]{6}$/i.test(children) ? children : null;
    return <td className="border-t px-3 py-2 align-top">{hex ? (
      <span className="inline-flex items-center gap-2 whitespace-nowrap font-mono text-xs">
        <span aria-hidden="true" className="size-4 rounded-sm border border-black/20" style={{ backgroundColor: hex }} />
        {hex}
      </span>
    ) : children}</td>;
  },
};

interface MarkdownRendererProps {
  content: string;
  designSystem?: boolean;
}

export default function MarkdownRenderer({ content, designSystem }: MarkdownRendererProps) {
  return (
    <div className="prose prose-slate max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSlug,
          [rehypeAutolinkHeadings, { behavior: 'wrap' }],
          rehypeHighlight,
        ]}
        components={designSystem ? DESIGN_COMPONENTS : MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
