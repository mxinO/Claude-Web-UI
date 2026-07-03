import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

interface Props { content: string; }

// Sentinel href scheme so the path survives react-markdown's prop mapping and
// the <a> renderer can tell a file link from a normal link.
const FILE_HREF = 'cwui-file:';

// File-extension allowlist for BARE filenames (no slash). Paths that contain a
// slash are matched structurally and don't need the allowlist.
const BARE_EXT = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'css', 'scss',
  'less', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'md', 'markdown',
  'mdx', 'txt', 'log', 'csv', 'tsv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'vue', 'svelte',
].join('|');

// A path with at least one slash + extension, OR a bare filename with a known
// extension. Optional :line:col suffix.
// Group 1 = a leading boundary (start-of-string or a non-path char) which we
//   re-emit as text — used INSTEAD of a lookbehind so this works on Safari
//   <16.4 (regex lookbehind isn't supported there; a crash would break ALL
//   markdown rendering). The boundary class excludes ':' and '/' so the path
//   portion of a scheme URL ("https://x.com/a.html") isn't matched.
// Group 2 = the path itself (without any :line suffix).
const PATH_RE = new RegExp(
  String.raw`(^|[^\w@:./\\-])` +
  String.raw`(` +
    String.raw`(?:~|\.\.?)?\/[\w.\-/]*[\w\-]\.\w{1,8}` +     // absolute / ./ ../ ~/ paths
    String.raw`|(?:[\w.\-]+\/)+[\w.\-]+\.\w{1,8}` +          // relative path with slash(es)
    String.raw`|[\w.\-]+\.(?:${BARE_EXT})` +                 // bare filename, known ext
  String.raw`)` +
  String.raw`(?::\d+(?::\d+)?)?` +                           // optional :line / :line:col
  String.raw`(?![\w/\\])`,
  'g',
);

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function linkifyText(value: string): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(value)) !== null) {
    const boundary = m[1];          // start-of-string ('') or a single non-path char
    const pathOnly = m[2];          // the path, without any :line:col suffix
    const linkStart = m.index + boundary.length;
    const linkText = m[0].slice(boundary.length); // path + optional :line:col
    if (linkStart > last) out.push({ type: 'text', value: value.slice(last, linkStart) });
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { href: FILE_HREF + encodeURIComponent(pathOnly), className: ['file-link'] },
      children: [{ type: 'text', value: linkText }],
    });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [{ type: 'text', value }];
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

/** rehype plugin: replace file-path tokens in text nodes with clickable links.
 *  Skips <pre> (code blocks) and existing <a> so it doesn't double-link. */
function rehypeFileLinks() {
  const visit = (node: HastNode, inPre: boolean) => {
    if (!node.children) return;
    const nowInPre = inPre || node.tagName === 'pre';
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && !nowInPre) {
        next.push(...linkifyText(child.value || ''));
      } else {
        if (child.type === 'element' && child.tagName === 'a') {
          next.push(child); // leave real links alone
        } else {
          visit(child, nowInPre);
          next.push(child);
        }
      }
    }
    node.children = next;
  };
  return (tree: HastNode) => visit(tree, false);
}

/** True for an href that points at a local file path rather than an external
 *  resource. Excludes fragments (#…), protocol-relative (//host) and any
 *  scheme URL (http:, https:, mailto:, tel:, data:, cwui-file:, …). Everything
 *  else — relative ("src/x.ts"), absolute ("/home/x"), "./", "../", "~/" — is a
 *  local path that must open in the file viewer, NOT navigate the SPA (which
 *  would land on a blank "new chat" tab). */
function isLocalFileHref(href: string): boolean {
  if (!href || href.startsWith('#')) return false;
  if (href.startsWith('//')) return false;              // protocol-relative URL
  if (/^[a-zA-Z][\w+.-]*:/.test(href)) return false;    // any scheme:  (http, mailto, cwui-file, …)
  return true;
}

function openInViewer(path: string) {
  window.dispatchEvent(new CustomEvent('view-file', { detail: { path } }));
}

const components = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const href = props.href || '';
    // Auto-linkified file paths (sentinel scheme) and real markdown links to
    // local files both open in the shared file viewer.
    const filePath = href.startsWith(FILE_HREF)
      ? decodeURIComponent(href.slice(FILE_HREF.length))
      : isLocalFileHref(href) ? href : null;
    if (filePath !== null) {
      return (
        <a
          href="#"
          className="file-link"
          onClick={(e) => {
            e.preventDefault();
            openInViewer(filePath);
          }}
        >{props.children}</a>
      );
    }
    // External links open in a new tab.
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
};

export function MarkdownView({ content }: Props) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight, rehypeFileLinks]}
        components={components}
      >{content}</ReactMarkdown>
    </div>
  );
}
