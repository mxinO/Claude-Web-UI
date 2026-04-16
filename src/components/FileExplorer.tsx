import { useState, useCallback, useEffect, useRef, type ChangeEvent } from 'react';

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
  const [cwdLabel, setCwdLabel] = useState<string>('');
  const [cwdFull, setCwdFull] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<string>('');
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
      setStatusMsg(`Uploaded ${ok}, failed ${failed}`);
    } else {
      setStatusMsg(`Uploaded ${ok} file${ok > 1 ? 's' : ''}`);
    }
    setTimeout(() => setStatusMsg(''), 3000);
    // Refresh to show new files
    refreshRoot();
  }, [refreshRoot]);

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
              <button
                title="Upload file here"
                onClick={() => triggerUpload(node.entry.path)}
              >
                ↑
              </button>
            )}
            {!node.entry.isDir && (
              <>
                <button
                  title="View file"
                  onClick={() => handleView(node.entry.path)}
                >
                  👁
                </button>
                <button
                  title="Download file"
                  onClick={() => handleDownload(node.entry.path)}
                >
                  ↓
                </button>
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
        <div style={{ fontSize: 11, padding: '2px 8px', color: statusMsg.includes('failed') ? 'var(--red)' : 'var(--green)' }}>
          {statusMsg}
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
    </div>
  );
}
