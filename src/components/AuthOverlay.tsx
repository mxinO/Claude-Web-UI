interface AuthOverlayProps {
  visible: boolean;
}

export default function AuthOverlay({ visible }: AuthOverlayProps) {
  if (!visible) return null;

  return (
    <div className="auth-overlay">
      <div className="auth-dialog">
        <div className="auth-icon">!</div>
        <h3>Session expired</h3>
        <p>The server was restarted and the access token has changed. Refresh and re-enter the new token from the server console.</p>
        <button onClick={() => window.location.reload()}>Refresh</button>
      </div>
    </div>
  );
}
