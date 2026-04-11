import { useState, useCallback } from 'react';

interface PermissionBarProps {
  eventId: number;
}

type Decision = 'allowed' | 'denied' | null;

export default function PermissionBar({ eventId }: PermissionBarProps) {
  const [decision, setDecision] = useState<Decision>(null);
  const [loading, setLoading] = useState(false);

  const decide = useCallback(
    async (allow: boolean) => {
      setLoading(true);
      try {
        // First, look up the permission ID for this event
        const res = await fetch(`/api/permission-for-event/${eventId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const permissionId: string = data.id ?? data.permission_id;

        // Post the decision
        await fetch(`/api/permission-decision/${permissionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allow }),
        });

        setDecision(allow ? 'allowed' : 'denied');
      } catch (err) {
        console.error('Permission decision failed:', err);
      } finally {
        setLoading(false);
      }
    },
    [eventId]
  );

  if (decision) {
    return (
      <div className="permission-bar">
        <span
          style={{
            color: decision === 'allowed' ? 'var(--green)' : 'var(--red)',
            fontWeight: 'bold',
          }}
        >
          {decision === 'allowed' ? 'Allowed' : 'Denied'}
        </span>
      </div>
    );
  }

  return (
    <div className="permission-bar">
      <span className="permission-info">Permission requested</span>
      <button
        className="btn-approve"
        onClick={() => decide(true)}
        disabled={loading}
      >
        Allow
      </button>
      <button
        className="btn-deny"
        onClick={() => decide(false)}
        disabled={loading}
      >
        Deny
      </button>
    </div>
  );
}
