import { useState, useMemo } from 'react';

interface Props {
  text: string;
  onExpand: () => void;
}

/**
 * Compact "working" card that shows a snippet of streaming text.
 * Displays the last ~3 lines with a pulsing animation.
 * Click to expand full text in a modal.
 */
export default function StreamingCard({ text, onExpand }: Props) {
  const snippet = useMemo(() => {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    // Show last 3 non-empty lines, truncated
    const lastLines = lines.slice(-3);
    return lastLines.map(l => l.length > 80 ? l.slice(0, 77) + '...' : l).join('\n');
  }, [text]);

  const lineCount = text.split('\n').filter(l => l.trim()).length;

  return (
    <div className="chat-row chat-row--assistant">
      <div className="streaming-card" onClick={onExpand}>
        <div className="streaming-card-header">
          <span className="streaming-card-icon">✦</span>
          <span className="streaming-card-label">Responding...</span>
          <span className="streaming-card-meta">{lineCount} lines</span>
        </div>
        <div className="streaming-card-snippet">{snippet}</div>
        <div className="streaming-card-footer">Click to expand</div>
      </div>
    </div>
  );
}
