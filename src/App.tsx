import { useState, useCallback } from 'react';
import type { TimelineEvent, Session, ReconnectSummary } from './types';
import './App.css';

export default function App() {
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  return (
    <div className="app">
      <div className="header">
        <span style={{ fontWeight: 'bold' }}>Claude Code Web UI</span>
        {session && (
          <>
            <span className="session-info">Session: {session.id.slice(0, 8)}...</span>
            {session.model && <span className="model-badge">{session.model}</span>}
          </>
        )}
        <div className="status">
          <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          <span>{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>
      <div className="main-content">
        <div className="timeline-panel">
          <div className="timeline-events">
            <div style={{ padding: 16, color: 'var(--text-secondary)' }}>
              Waiting for events...
            </div>
          </div>
        </div>
        <div className="detail-panel">
          <div className="empty">Select an event to view details</div>
        </div>
      </div>
      <div className="input-container">
        <input placeholder="Type a message or /command..." spellCheck={false} />
      </div>
    </div>
  );
}
