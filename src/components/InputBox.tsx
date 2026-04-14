import { useState, useRef, useCallback, KeyboardEvent, useEffect } from 'react';
import Autocomplete, { AutocompleteItem } from './Autocomplete';
import FileExplorer from './FileExplorer';

const MAX_HISTORY = 50;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT = 20; // px

const SLASH_COMMANDS = [
  { command: '/model', description: 'Switch model', hasSubmenu: true },
  { command: '/compact', description: 'Compact conversation' },
  { command: '/clear', description: 'Clear conversation' },
  { command: '/help', description: 'Show help' },
  { command: '/cost', description: 'Show token costs' },
  { command: '/effort', description: 'Set effort level', hasSubmenu: true },
  { command: '/review', description: 'Review code' },
];

const MODEL_OPTIONS = [
  { value: 'opus', label: 'Opus 4.6 (1M context)' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
];

type AutocompleteMode = 'none' | 'slash' | 'model' | 'effort' | 'file';

export default function InputBox() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    (text: string) => {
      // Slash commands: input starts with /
      if (text.startsWith('/') && !text.includes(' ')) {
        const query = text.toLowerCase();
        const matches = SLASH_COMMANDS.filter((c) =>
          c.command.toLowerCase().startsWith(query),
        );
        setAcMode('slash');
        setAcItems(
          matches.map((c) => ({
            label: c.command,
            detail: c.description,
            icon: c.hasSubmenu ? '>' : undefined,
          })),
        );
        setAcIndex(0);
        return;
      }

      // Model submenu: "/model " typed
      if (text.startsWith('/model ')) {
        const sub = text.slice(7).toLowerCase();
        const matches = MODEL_OPTIONS.filter((m) =>
          m.value.startsWith(sub) || m.label.toLowerCase().includes(sub),
        );
        setAcMode('model');
        setAcItems(
          matches.map((m) => ({ label: m.value, detail: m.label })),
        );
        setAcIndex(0);
        return;
      }

      // Effort submenu: "/effort " typed
      if (text.startsWith('/effort ')) {
        const sub = text.slice(8).toLowerCase();
        const matches = EFFORT_OPTIONS.filter((m) =>
          m.value.startsWith(sub) || m.label.toLowerCase().includes(sub),
        );
        setAcMode('effort');
        setAcItems(
          matches.map((m) => ({ label: m.value, detail: m.label })),
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

  const selectAutocompleteItem = useCallback(
    (index: number) => {
      const item = acItems[index];
      if (!item) return;

      if (acMode === 'slash') {
        const cmd = SLASH_COMMANDS.find((c) => c.command === item.label);
        if (cmd?.hasSubmenu) {
          setValue(item.label + ' ');
        } else {
          send(item.label);
          setValue('');
          closeAutocomplete();
        }
      } else if (acMode === 'model') {
        send('/model ' + item.label);
        setValue('');
        closeAutocomplete();
      } else if (acMode === 'effort') {
        send('/effort ' + item.label);
        setValue('');
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
    [acMode, acItems, value],
  );

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError('');

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
