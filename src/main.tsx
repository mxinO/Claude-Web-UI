import { createRoot } from 'react-dom/client';
import { Component, ErrorInfo, ReactNode } from 'react';
import App from './App';
import './App.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React crash:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#1e1e1e', color: '#f44747', padding: 20, fontFamily: 'monospace', height: '100vh', overflow: 'auto' }}>
          <h2>React Error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ccc' }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#858585', fontSize: 12, marginTop: 12 }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
