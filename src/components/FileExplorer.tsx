import { useState, useCallback, useEffect, useRef, lazy, Suspense, type ChangeEvent } from 'react';
import { detectLanguage } from '../lib/detectLanguage';

const LazyEditor = lazy(() =>
  import('@monaco-editor/react').then((m) => ({ default: m.default }))
);

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface TreeNode {
  entry: DirEntry;
  children: TreeNode[] | null; // null = not loaded
  expanded: boolean;
}

interface FileExplorerProps {
  onInsert: (path: string) => void;
}

export default function FileExplorer({ onInsert }: FileExplorerProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewFile, setViewFile] = useState<{ path: string; content: string } | null>(null);
  const [editFile, setEditFile] = useState<{ path: string; content: string } | null>(null);
  const editContentRef = useRef<string>('');
  const [editSaving, setEditSaving] = useState(false);
  const [cwdLabel, setCwdLabel] = useState<string>('');
  const [cwdFull, setCwdFull] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const loadedRef = useRef(false);

  const loadDir = useCallback(async (dirPath: string): Promise<DirEntry[]> => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ls?path=${encodeURIComponent(dirPath)}&_t=${Date.now()}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.items || [];
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRoot = useCallback(async () => {
    let cwd = '.';
    try {
      const status = await fetch('/api/current-status');
      if (status.ok) {
        const data = await status.json();
        if (data.cwd) {
          cwd = data.cwd;
          setCwdFull(cwd);
          setCwdLabel(cwd.split('/').filter(Boolean).pop() || cwd);
        }
      }
    } catch { /* fall back to '.' */ }
    const items = await loadDir(cwd);
    setRoots(items.map((e) => ({ entry: e, children: null, expanded: false })));
  }, [loadDir]);

  // Load root directory on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    refreshRoot();
  }, [refreshRoot]);

  const toggleNode = useCallback(
    async (path: string[], nodes: TreeNode[], setNodes: (n: TreeNode[]) => void) => {
      if (path.length === 0) return;
      const idx = path[0];
      const nodeIdx = nodes.findIndex((n) => n.entry.name === idx);
      if (nodeIdx === -1) return;

      const node = nodes[nodeIdx];
      const updated = [...nodes];

      if (path.length === 1) {
        // Toggle this node
        if (!node.entry.isDir) return;
        if (node.expanded) {
          updated[nodeIdx] = { ...node, expanded: false };
        } else {
          if (node.children === null) {
            const items = await loadDir(node.entry.path);
            updated[nodeIdx] = {
              ...node,
              expanded: true,
              children: items.map((e) => ({ entry: e, children: null, expanded: false })),
            };
          } else {
            updated[nodeIdx] = { ...node, expanded: true };
          }
        }
        setNodes(updated);
      } else {
        // Recurse
        if (node.children) {
          const setChildren = (c: TreeNode[]) => {
            updated[nodeIdx] = { ...node, children: c };
            setNodes(updated);
          };
          await toggleNode(path.slice(1), node.children, setChildren);
        }
      }
    },
    [loadDir],
  );

  const handleView = useCallback(async (filePath: string) => {
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return;
      const data = await res.json();
      setViewFile({ path: data.path || filePath, content: data.content || '' });
    } catch {
      /* ignore */
    }
  }, []);

  const handleDownload = useCallback((filePath: string) => {
    const a = document.createElement('a');
    a.href = `/api/download?path=${encodeURIComponent(filePath)}`;
    a.click();
  }, []);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadDirRef = useRef<string>('');

  const showStatus = useCallback((msg: string, ok = true, duration = 3000) => {
    setStatusMsg({ text: msg, ok });
    if (duration > 0) setTimeout(() => setStatusMsg(null), duration);
  }, []);

  const triggerUpload = useCallback((dirPath: string) => {
    uploadDirRef.current = dirPath;
    uploadInputRef.current?.click();
  }, []);

  const handleUpload = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const dir = uploadDirRef.current;
    let ok = 0, failed = 0;
    for (const file of Array.from(files)) {
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch(`/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        if (res.ok) ok++; else failed++;
      } catch { failed++; }
    }
    // Reset input so the same file can be re-uploaded
    e.target.value = '';
    if (failed > 0) {
      showStatus(`Uploaded ${ok}, failed ${failed}`, false);
    } else {
      showStatus(`Uploaded ${ok} file${ok > 1 ? 's' : ''}`);
    }
    // Refresh to show new files
    refreshRoot();
  }, [refreshRoot, showStatus]);

  const handleCreateFolder = useCallback(async (parentDir: string) => {
    const name = prompt('New folder name:');
    if (!name) return;
    try {
      const res = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirPath: `${parentDir}/${name}` }),
      });
      if (res.ok) { showStatus(`Created folder: ${name}`); refreshRoot(); }
      else { const d = await res.json(); showStatus(d.error || 'Failed', false); }
    } catch { showStatus('Failed to create folder', false); }
  }, [refreshRoot, showStatus]);

  const handleCreateFile = useCallback(async (parentDir: string) => {
    const name = prompt('New file name:');
    if (!name) return;
    try {
      const filePath = `${parentDir}/${name}`;
      const res = await fetch('/api/write-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, content: '' }),
      });
      if (res.ok) { showStatus(`Created file: ${name}`); refreshRoot(); }
      else { const d = await res.json(); showStatus(d.error || 'Failed', false); }
    } catch { showStatus('Failed to create file', false); }
  }, [refreshRoot, showStatus]);

  const handleEdit = useCallback(async (filePath: string) => {
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return;
      const data = await res.json();
      const content = data.content || '';
      editContentRef.current = content;
      setEditFile({ path: data.path || filePath, content });
    } catch { /* ignore */ }
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editFile) return;
    setEditSaving(true);
    try {
      const res = await fetch('/api/write-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: editFile.path, content: editContentRef.current }),
      });
      if (res.ok) {
        showStatus('Saved');
        setEditFile(null);
      } else {
        const d = await res.json();
        showStatus(d.error || 'Save failed', false);
      }
    } catch { showStatus('Save failed', false); }
    finally { setEditSaving(false); }
  }, [editFile, showStatus]);

  const closeEditor = useCallback(() => {
    if (editFile && editContentRef.current !== editFile.content) {
      if (!window.confirm('You have unsaved changes. Discard?')) return;
    }
    setEditFile(null);
  }, [editFile]);

  const renderTree = (nodes: TreeNode[], depth: number, parentPath: string[]): JSX.Element[] => {
    return nodes.map((node) => (
      <div key={node.entry.path}>
        <div
          className="file-explorer-item"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          <span
            className="file-explorer-name"
            onClick={() => {
              if (node.entry.isDir) {
                toggleNode([...parentPath, node.entry.name], roots, setRoots);
              }
            }}
            style={{ cursor: node.entry.isDir ? 'pointer' : 'default' }}
          >
            <span className="file-explorer-icon">
              {node.entry.isDir ? (node.expanded ? '📂' : '📁') : '📄'}
            </span>
            {node.entry.name}
          </span>
          <span className="file-explorer-actions">
            <button
              title="Insert path"
              onClick={() => onInsert(node.entry.path)}
            >
              +
            </button>
            {node.entry.isDir && (
              <>
                <button title="New folder" onClick={() => handleCreateFolder(node.entry.path)}>📁+</button>
                <button title="New file" onClick={() => handleCreateFile(node.entry.path)}>📄+</button>
                <button title="Upload file here" onClick={() => triggerUpload(node.entry.path)}>↑</button>
              </>
            )}
            {!node.entry.isDir && (
              <>
                <button title="Edit file" onClick={() => handleEdit(node.entry.path)}>✎</button>
                <button title="View file" onClick={() => handleView(node.entry.path)}>👁</button>
                <button title="Download file" onClick={() => handleDownload(node.entry.path)}>↓</button>
              </>
            )}
          </span>
        </div>
        {node.expanded && node.children && renderTree(node.children, depth + 1, [...parentPath, node.entry.name])}
      </div>
    ));
  };

  return (
    <div className="sidebar-explorer">
      <div className="file-explorer-header">
        <span>Explorer</span>
        {cwdLabel && <span className="file-explorer-cwd" title={cwdFull}>{cwdLabel}</span>}
        <button
          className="file-explorer-refresh"
          onClick={() => handleCreateFolder(cwdFull || '.')}
          title="New folder"
        >
          📁+
        </button>
        <button
          className="file-explorer-refresh"
          onClick={() => handleCreateFile(cwdFull || '.')}
          title="New file"
        >
          📄+
        </button>
        <button
          className="file-explorer-refresh"
          onClick={() => triggerUpload(cwdFull || '.')}
          title="Upload to root"
        >
          ↑
        </button>
        <button
          className="file-explorer-refresh"
          onClick={refreshRoot}
          disabled={loading}
          title="Refresh"
        >
          ↻
        </button>
        {loading && <span className="file-explorer-loading">...</span>}
      </div>
      {statusMsg && (
        <div style={{ fontSize: 11, padding: '2px 8px', color: statusMsg.ok ? 'var(--green)' : 'var(--red)' }}>
          {statusMsg.text}
        </div>
      )}
      <div className="file-explorer-tree">
        {roots.length === 0 && !loading && (
          <div className="file-explorer-empty">No files found</div>
        )}
        {renderTree(roots, 0, [])}
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleUpload}
      />

      {viewFile && (
        <div className="modal-overlay" onClick={() => setViewFile(null)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ width: '70vw', height: '70vh' }}>
            <div className="modal-header">
              <span className="modal-title">{viewFile.path}</span>
              <button className="modal-close" onClick={() => setViewFile(null)}>
                &times;
              </button>
            </div>
            <div className="modal-body">
              <pre className="bash-output" style={{ maxHeight: 'none' }}>{viewFile.content}</pre>
            </div>
          </div>
        </div>
      )}

      {editFile && (
        <div className="modal-overlay" onClick={closeEditor}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ width: '80vw', height: '80vh' }}>
            <div className="modal-header">
              <span className="modal-title">Edit: {editFile.path}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  className="editor-save-btn"
                  onClick={handleSaveEdit}
                  disabled={editSaving}
                >
                  {editSaving ? 'Saving...' : 'Save'}
                </button>
                <button className="modal-close" onClick={closeEditor}>
                  &times;
                </button>
              </span>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              <Suspense fallback={<div style={{ padding: 20 }}>Loading editor...</div>}>
                <LazyEditor
                  key={editFile.path}
                  defaultValue={editFile.content}
                  language={detectLanguage(editFile.path)}
                  theme="vs-dark"
                  onChange={(v) => { editContentRef.current = v ?? ''; }}
                  options={{
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: 'on',
                    wordWrap: 'on',
                  }}
                  height="100%"
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
