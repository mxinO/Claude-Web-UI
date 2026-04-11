import { DiffEditor } from '@monaco-editor/react';
import { detectLanguage } from '../lib/detectLanguage';

export { detectLanguage };

interface Props {
  original: string;
  modified: string;
  language: string;
  fileName: string;
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
