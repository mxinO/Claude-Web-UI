import { createRoot } from 'react-dom/client';

function App() {
  return <div style={{ color: '#ccc', background: '#1e1e1e', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    Claude Code Web UI — loading...
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
