import { useState, useRef, useCallback, KeyboardEvent, useEffect } from 'react';
import Autocomplete, { AutocompleteItem } from './Autocomplete';
import FileExplorer from './FileExplorer';

const MAX_HISTORY = 50;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT = 20; // px

// Fallback commands for mock mode or if API is unavailable
const FALLBACK_COMMANDS = [
  { command: '/model', description: 'Switch model' },
  { command: '/compact', description: 'Compact conversation' },
  { command: '/effort', description: 'Set effort level' },
  { command: '/help', description: 'Show help' },
  { command: '/cost', description: 'Show token costs' },
  { command: '/review', description: 'Review a pull request' },
  { command: '/diff', description: 'View uncommitted changes' },
  { command: '/clear', description: 'Clear conversation history' },
  { command: '/exit', description: 'Exit the REPL' },
];

// Commands to hide from autocomplete (managed by the web UI server)
const HIDDEN_COMMANDS = new Set(['/exit']);

// Commands that only affect Claude TUI, shown with a note
const WEB_UI_NOTES: Record<string, string> = {
  '/clear': '(clears Claude context only, not web UI)',
  '/terminal-setup': '(not needed in web UI)',
  '/color': '(affects TUI only)',
  '/theme': '(affects TUI only)',
};

/** Fetch slash commands from the server (scraped from Claude TUI) */
let commandsCache: Array<{ command: string; description: string; category?: string }> | null = null;
async function getSlashCommands(): Promise<Array<{ command: string; description: string }>> {
  if (commandsCache) return commandsCache;
  try {
    const res = await fetch('/api/commands');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        commandsCache = data;
        return data;
      }
    }
  } catch { /* ignore */ }
  return FALLBACK_COMMANDS;
}

type AutocompleteMode = 'none' | 'slash' | 'file';

export default function InputBox() {
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
    updateAutocomplete(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const updateAutocomplete = useCallback(
    async (text: string) => {
      // Slash commands: input starts with / and no space yet (still typing the command name)
      if (text.startsWith('/') && !text.includes(' ')) {
        const query = text.toLowerCase();
        const commands = await getSlashCommands();
        const matches = commands.filter((c) =>
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
        return;
      }

      // @ file completion: find last @ not preceded by a space-less context
      const atMatch = text.match(/@([^\s]*)$/);
      if (atMatch) {
        const atIdx = text.lastIndexOf('@');
        atPosRef.current = atIdx;
        const pathPart = atMatch[1];
        fetchFileSuggestions(pathPart);
        return;
      }

      // Nothing matched
      closeAutocomplete();
    },
    [],
  );

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
        // Insert the command into the input with a trailing space
        // User can then type arguments (e.g. "/model opus") and press Enter to send
        setValue(item.label + ' ');
        closeAutocomplete();
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

    // Slash commands use the special endpoint that captures TUI response
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
