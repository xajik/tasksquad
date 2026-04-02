import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypePrettyCode from 'rehype-pretty-code';

interface MarkdownRendererProps {
  content: string;
}

const prettyCodeOptions = {
  theme: 'github-dark',
  keepBackground: true,
};

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="prose prose-slate max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSlug,
          [rehypeAutolinkHeadings, { behavior: 'wrap' }],
          [rehypePrettyCode, prettyCodeOptions],
        ]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
