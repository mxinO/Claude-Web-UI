import { DiffEditor } from '@monaco-editor/react';

interface Props {
  original: string;
  modified: string;
  language: string;
  fileName: string;
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    h: 'c', hpp: 'cpp', css: 'css', html: 'html', json: 'json', yaml: 'yaml',
    yml: 'yaml', md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell',
    toml: 'toml', xml: 'xml', rb: 'ruby', php: 'php',
  };
  return map[ext] || 'plaintext';
}

export function DiffViewer({ original, modified, language, fileName }: Props) {
  const lang = language || detectLanguage(fileName);
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={lang}
      theme="vs-dark"
      options={{
        readOnly: true,
        renderSideBySide: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineNumbers: 'on',
        wordWrap: 'on',
      }}
      height="100%"
    />
  );
}
