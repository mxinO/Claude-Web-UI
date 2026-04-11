import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

interface Props { content: string; }

export function MarkdownView({ content }: Props) {
  return (
    <div className="markdown-content">
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{content}</ReactMarkdown>
    </div>
  );
}
