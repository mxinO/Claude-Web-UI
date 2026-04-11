import { useState, useCallback } from 'react';
import Header from './components/Header';
import Timeline from './components/Timeline';
import { DetailPanel } from './components/DetailPanel';
import InputBox from './components/InputBox';
import { useWebSocket } from './hooks/useWebSocket';
import { useEventStore } from './hooks/useEventStore';
import type { TimelineEvent } from './types';
import './App.css';

export default function App() {
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);
  const { events, addEvent, session, setSession, loadOlderEvents, hasMore, reconnectSummary } = useEventStore();
  const { connected } = useWebSocket({ onEvent: addEvent, session, setSession });

  const handleSelectEvent = useCallback((event: TimelineEvent) => {
    setSelectedEvent(event);
  }, []);

  return (
    <div className="app">
      <Header session={session} connected={connected} />
      <div className="main-content">
        <div className="timeline-panel">
          <Timeline
            events={events}
            selectedId={selectedEvent?.id ?? null}
            onSelect={handleSelectEvent}
            onLoadMore={loadOlderEvents}
            hasMore={hasMore}
            reconnectSummary={reconnectSummary}
          />
        </div>
        <div className="detail-panel">
          <DetailPanel event={selectedEvent} />
        </div>
      </div>
      <InputBox />
    </div>
  );
}
