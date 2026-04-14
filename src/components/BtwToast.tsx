import { useState, useEffect, useCallback } from 'react';
import { MarkdownView } from './MarkdownView';

interface BtwToastProps {
  question: string;
  response: string;
  onClose: () => void;
}

export default function BtwToast({ question, response, onClose }: BtwToastProps) {
  const [expanded, setExpanded] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const preview = response.length > 200 ? response.slice(0, 200) + '...' : response;

  return (
    <div className="btw-toast-overlay" onClick={onClose}>
      <div
        className={`btw-toast ${expanded ? 'btw-toast--expanded' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="btw-toast-header">
          <span className="btw-toast-label">Side question</span>
          <span className="btw-toast-question">{question.slice(0, 60)}</span>
          <button className="btw-toast-close" onClick={onClose}>&times;</button>
        </div>
        <div className="btw-toast-body">
          {expanded ? (
            <MarkdownView content={response} />
          ) : (
            <div className="btw-toast-preview" onClick={() => setExpanded(true)}>
              {preview}
              {response.length > 200 && (
                <span className="btw-toast-expand">Click to expand</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
