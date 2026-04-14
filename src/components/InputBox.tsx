import { useState, useRef, useCallback, KeyboardEvent, useEffect } from 'react';
import Autocomplete, { AutocompleteItem } from './Autocomplete';
import FileExplorer from './FileExplorer';

const MAX_HISTORY = 50;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT = 20; // px

// Fallback commands for mock mode or if API is unavailable
const FALLBACK_COMMANDS = [
  { command: '/btw', description: 'Ask a side question without interrupting the main conversation' },
  { command: '/model', description: 'Switch model (opus, sonnet, haiku)' },
  { command: '/plan', description: 'Toggle plan mode — Claude plans before acting' },
  { command: '/compact', description: 'Compact conversation to free context' },
  { command: '/effort', description: 'Set effort level (low, medium, high, max)' },
  { command: '/permission-mode', description: 'Switch permission mode' },
  { command: '/cost', description: 'Show token costs and usage' },
  { command: '/diff', description: 'View uncommitted changes and per-turn diffs' },
  { command: '/review', description: 'Review a pull request' },
  { command: '/resume', description: 'Resume a previous session' },
  { command: '/status', description: 'Show status, version, model, and account info' },
  { command: '/branch', description: 'Create a branch of the conversation' },
  { command: '/export', description: 'Export conversation to file or clipboard' },
  { command: '/fast', description: 'Toggle fast mode (Opus only)' },
  { command: '/help', description: 'Show help' },
  { command: '/clear', description: 'Clear conversation history' },
  { command: '/memory', description: 'Edit Claude memory files' },
  { command: '/mcp', description: 'Manage MCP servers' },
  { command: '/tasks', description: 'List and manage background tasks' },
  { command: '/loop', description: 'Run a prompt or command on a recurring interval' },
  { command: '/batch', description: 'Plan and execute a large-scale change in parallel' },
  { command: '/agents', description: 'Manage agent configurations' },
  { command: '/rename', description: 'Rename the current conversation' },
  { command: '/exit', description: 'Exit the REPL' },
];

// Commands to hide from autocomplete (managed by the web UI server)
const HIDDEN_COMMANDS = new Set(['/exit']);

// Sub-options for commands with known arguments
const MODEL_OPTIONS = [
  { value: 'opus', label: 'Opus 4.6 (1M context)' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
  { value: 'max', label: 'Max effort' },
];

const PERMISSION_MODE_OPTIONS = [
  { value: 'default', label: 'Default — ask for permissions' },
  { value: 'plan', label: 'Plan mode — plan before acting' },
  { value: 'auto', label: 'Auto — auto-approve safe actions' },
  { value: 'acceptEdits', label: 'Accept edits — auto-approve file edits' },
  { value: 'bypassPermissions', label: 'Bypass — skip all permission checks' },
];

// Commands that only affect Claude TUI, shown with a note
const WEB_UI_NOTES: Record<string, string> = {
  '/clear': '(clears Claude context only, not web UI)',
  '/terminal-setup': '(not needed in web UI)',
  '/color': '(affects TUI only)',
  '/theme': '(affects TUI only)',
};

type AutocompleteMode = 'none' | 'slash' | 'file';

interface InputBoxProps {
  isRunning?: boolean;
}

export default function InputBox({ isRunning }: InputBoxProps = {}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<(text: string) => Promise<void>>();

  // Autocomplete state
  const [acMode, setAcMode] = useState<AutocompleteMode>('none');
  const [acItems, setAcItems] = useState<AutocompleteItem[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const acVisible = acMode !== 'none' && acItems.length > 0;

  // File explorer state
  const [explorerVisible, setExplorerVisible] = useState(false);

  // Track @ position for file autocomplete
  const atPosRef = useRef(-1);

  // Listen for external text insertion (e.g. session picker inserts /resume <id>)
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail?.text;
      if (typeof text === 'string') {
        setValue(text);
        textareaRef.current?.focus();
      }
    };
    window.addEventListener('insert-input-text', handler);
    return () => window.removeEventListener('insert-input-text', handler);
  }, []);

  // Auto-resize textarea height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollH = el.scrollHeight;
    const maxH = LINE_HEIGHT * MAX_ROWS + 12;
    el.style.height = `${Math.min(scrollH, maxH)}px`;
  }, [value]);

  // Update autocomplete when value changes
  useEffect(() => {
    let cancelled = false;
    const text = value;

    // Sub-options: "/model " or "/effort " — show argument suggestions
    if (text.startsWith('/') && text.includes(' ')) {
      const spaceIdx = text.indexOf(' ');
      const cmd = text.slice(0, spaceIdx);
      const arg = text.slice(spaceIdx + 1).toLowerCase();

      let options: Array<{ value: string; label: string }> | null = null;
      if (cmd === '/model') options = MODEL_OPTIONS;
      else if (cmd === '/effort') options = EFFORT_OPTIONS;
      else if (cmd === '/permission-mode') options = PERMISSION_MODE_OPTIONS;

      if (options) {
        const matches = options.filter(o =>
          o.value.toLowerCase().startsWith(arg) || o.label.toLowerCase().includes(arg)
        );
        if (matches.length > 0) {
          setAcMode('slash');
          setAcItems(matches.map(o => ({ label: o.value, detail: o.label })));
          setAcIndex(0);
          return () => { cancelled = true; };
        }
      }
      // No sub-options — close
      setAcMode('none');
      setAcItems([]);
      return () => { cancelled = true; };
    }

    // Slash commands: input starts with / and no space yet
    if (text.startsWith('/') && !text.includes(' ')) {
      const query = text.toLowerCase();
      const matches = FALLBACK_COMMANDS.filter((c) =>
        !HIDDEN_COMMANDS.has(c.command) &&
        c.command.toLowerCase().startsWith(query),
      );
      setAcMode('slash');
      setAcItems(
        matches.map((c) => {
          const note = WEB_UI_NOTES[c.command];
          return {
            label: c.command,
            detail: note ? `${c.description} ${note}` : c.description,
          };
        }),
      );
      setAcIndex(0);
      return () => { cancelled = true; };
    }

    // @ file completion
    const atMatch = text.match(/@([^\s]*)$/);
    if (atMatch) {
      const atIdx = text.lastIndexOf('@');
      atPosRef.current = atIdx;
      fetchFileSuggestions(atMatch[1]);
      return () => { cancelled = true; };
    }

    // Nothing matched — close
    setAcMode('none');
    setAcItems([]);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const fetchFileSuggestions = useCallback(async (pathPart: string) => {
    try {
      let url: string;
      if (pathPart.includes('/')) {
        // Directory listing - get the directory part
        const lastSlash = pathPart.lastIndexOf('/');
        const dirPath = pathPart.slice(0, lastSlash + 1) || '/';
        url = `/api/ls?path=${encodeURIComponent(dirPath)}`;
      } else {
        // Recent files
        url = '/api/recent-files';
      }

      const res = await fetch(url);
      if (!res.ok) {
        setAcMode('file');
        setAcItems([]);
        return;
      }
      const data = await res.json();

      let entries: AutocompleteItem[];
      if (data.items) {
        // ls response
        const prefix = pathPart.includes('/')
          ? pathPart.slice(pathPart.lastIndexOf('/') + 1).toLowerCase()
          : '';
        entries = (data.items as Array<{ name: string; path: string; isDir: boolean }>)
          .filter((e) => !prefix || e.name.toLowerCase().startsWith(prefix))
          .map((e) => ({
            label: e.isDir ? e.name + '/' : e.name,
            detail: e.path,
            icon: e.isDir ? '\uD83D\uDCC1' : '\uD83D\uDCC4',
          }));
      } else if (data.files) {
        // recent-files response
        const prefix = pathPart.toLowerCase();
        entries = (data.files as Array<{ name: string; path: string }>)
          .filter((f) => !prefix || f.name.toLowerCase().startsWith(prefix) || f.path.toLowerCase().includes(prefix))
          .map((f) => ({
            label: f.name,
            detail: f.path,
            icon: '\uD83D\uDCC4',
          }));
      } else {
        entries = [];
      }

      setAcMode('file');
      setAcItems(entries.slice(0, 50));
      setAcIndex(0);
    } catch {
      setAcMode('file');
      setAcItems([]);
    }
  }, []);

  const closeAutocomplete = useCallback(() => {
    setAcMode('none');
    setAcItems([]);
    setAcIndex(0);
  }, []);

  /** Send a slash command via the special endpoint that captures TUI response */
  const sendSlashCommand = useCallback(async (command: string) => {
    setError('');
    setValue('');
    closeAutocomplete();
    try {
      const res = await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: command }),
      });
      const data = await res.json();
      if (data.response) {
        setError(`${command}: ${data.response}`);
        // Notify app to refresh model/session info
        window.dispatchEvent(new CustomEvent('claude-command-executed', {
          detail: { command, response: data.response }
        }));
      } else if (!res.ok) {
        setError(data.error || `Failed: ${command}`);
      }
    } catch (err) {
      setError(`Failed: ${err}`);
    }
  }, [closeAutocomplete]);
  const sendSlashRef = useRef(sendSlashCommand);
  sendSlashRef.current = sendSlashCommand;

  const selectAutocompleteItem = useCallback(
    (index: number) => {
      const item = acItems[index];
      if (!item) return;

      if (acMode === 'slash') {
        // Check if we're in sub-option mode (value has a space = already typed the command)
        if (value.includes(' ')) {
          // Sub-option selected: compose full command and send
          const cmd = value.slice(0, value.indexOf(' '));
          sendSlashRef.current(`${cmd} ${item.label}`);
        } else {
          // Command selected: insert with trailing space for argument typing
          // Don't close autocomplete — the useEffect on value will show sub-options if available
          setValue(item.label + ' ');
        }
      } else if (acMode === 'file') {
        const atIdx = atPosRef.current;
        const before = value.slice(0, atIdx);
        const isDir = item.label.endsWith('/');
        const insertPath = item.detail || item.label;
        const after = value.slice(value.length); // cursor is at end for simplicity

        if (isDir) {
          // Insert directory path and re-trigger
          const dirPath = insertPath.endsWith('/') ? insertPath : insertPath + '/';
          setValue(before + '@' + dirPath);
        } else {
          setValue(before + insertPath + ' ' + after);
          closeAutocomplete();
        }
      }
    },
    [acMode, acItems, value, closeAutocomplete],
  );

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError('');

    // /btw side questions — special handling with floating toast response
    if (trimmed.startsWith('/btw ')) {
      setValue('');
      setError('Asking side question...');
      try {
        const res = await fetch('/api/send-btw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed.slice(5) }),
        });
        const data = await res.json();
        if (data.response) {
          // Dispatch event for App to show as floating toast
          window.dispatchEvent(new CustomEvent('btw-response', {
            detail: { question: trimmed.slice(5), response: data.response }
          }));
          setError('');
        } else {
          setError('/btw: no response received');
        }
      } catch (err) {
        setError(`/btw failed: ${err}`);
      }
      return;
    }

    // Other slash commands use the special endpoint that captures TUI response
    if (trimmed.startsWith('/')) {
      sendSlashRef.current(trimmed);
      return;
    }

    try {
      const res = await fetch('/api/send-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error?.includes('Failed to send') || data.error?.includes('tmux')) {
          setError('No tmux session \u2014 using mock mode');
          await simulateEvents(trimmed);
        } else {
          setError(data.error || `Error ${res.status}`);
          return;
        }
      }

      const hist = historyRef.current;
      if (hist[hist.length - 1] !== trimmed) {
        hist.push(trimmed);
        if (hist.length > MAX_HISTORY) hist.shift();
      }
      historyIndexRef.current = -1;
      setValue('');
    } catch (err) {
      setError(`Network error: ${err}`);
    }
  }, []);
  sendRef.current = send;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // When autocomplete is visible, intercept navigation keys
      if (acVisible) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setAcIndex((prev) => (prev > 0 ? prev - 1 : acItems.length - 1));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setAcIndex((prev) => (prev < acItems.length - 1 ? prev + 1 : 0));
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          selectAutocompleteItem(acIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeAutocomplete();
          return;
        }
      }

      // Enter sends, Shift+Enter inserts newline
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(value);
        return;
      }

      // Escape closes file explorer
      if (e.key === 'Escape' && explorerVisible) {
        setExplorerVisible(false);
        return;
      }

      const hist = historyRef.current;
      const isMultiline = value.includes('\n');
      if (!isMultiline && e.key === 'ArrowUp') {
        e.preventDefault();
        if (hist.length === 0) return;
        if (historyIndexRef.current === -1) {
          historyIndexRef.current = hist.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }
        setValue(hist[historyIndexRef.current]);
      } else if (!isMultiline && e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndexRef.current === -1) return;
        if (historyIndexRef.current < hist.length - 1) {
          historyIndexRef.current += 1;
          setValue(hist[historyIndexRef.current]);
        } else {
          historyIndexRef.current = -1;
          setValue('');
        }
      }
    },
    [value, send, acVisible, acItems.length, acIndex, selectAutocompleteItem, closeAutocomplete, explorerVisible],
  );

  const handleInsertFromExplorer = useCallback((path: string) => {
    setValue((prev) => prev + path + ' ');
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="input-container">
      {error && (
        <div style={{ fontSize: 11, color: 'var(--yellow)', padding: '2px 0', marginBottom: 2, width: '100%' }}>
          {error}
        </div>
      )}
      <div className="input-row">
        <div className="input-textarea-wrapper">
          <Autocomplete
            items={acItems}
            selectedIndex={acIndex}
            onSelect={selectAutocompleteItem}
            visible={acVisible}
          />
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a message, /command, or @file... (Shift+Enter for newline)"
            spellCheck={false}
            rows={MIN_ROWS}
          />
        </div>
        <button
          className="file-explorer-toggle"
          onClick={() => setExplorerVisible((v) => !v)}
          title="Browse files"
        >
          📁
        </button>
        {isRunning && (
          <button
            className="stop-button"
            onClick={async () => {
              try {
                const res = await fetch('/api/interrupt', { method: 'POST' });
                const data = await res.json().catch(() => ({}));
                window.dispatchEvent(new CustomEvent('claude-interrupted', {
                  detail: { promptRestored: data.promptRestored }
                }));
              } catch {
                window.dispatchEvent(new CustomEvent('claude-interrupted'));
              }
            }}
            title="Stop (interrupt current operation)"
          >
            ⏹
          </button>
        )}
      </div>
      <FileExplorer
        visible={explorerVisible}
        onClose={() => setExplorerVisible(false)}
        onInsert={handleInsertFromExplorer}
      />
    </div>
  );
}

/** Mock mode: simulate hook events directly when no tmux session */
async function simulateEvents(text: string) {
  let sessionId = 'mock-session';
  try {
    const sessRes = await fetch('/api/sessions/latest');
    if (sessRes.ok) {
      const sess = await sessRes.json();
      sessionId = sess.id;
    }
  } catch { /* ignore */ }

  await fetch('/hooks/session-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, model: 'mock', cwd: '/mock' }),
  }).catch(() => {});

  await fetch('/hooks/user-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, user_input: text }),
  });

  setTimeout(async () => {
    await fetch('/hooks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        assistant_message: `[Mock] You said: "${text}". This is mock mode \u2014 no Claude Code tmux session is running.`,
        stop_reason: 'end_turn',
      }),
    });
  }, 500);
}
