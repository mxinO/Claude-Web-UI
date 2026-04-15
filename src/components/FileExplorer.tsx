import { useState, useCallback, useEffect, useRef } from 'react';

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
  const loadedRef = useRef(false);

  // Load root directory on mount
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
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
    })();
  }, []);

  const loadDir = useCallback(async (path: string): Promise<DirEntry[]> => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ls?path=${encodeURIComponent(path)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.items || [];
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

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
            {!node.entry.isDir && (
              <button
                title="View file"
                onClick={() => handleView(node.entry.path)}
              >
                👁
              </button>
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
        {loading && <span className="file-explorer-loading">...</span>}
      </div>
      <div className="file-explorer-tree">
        {roots.length === 0 && !loading && (
          <div className="file-explorer-empty">No files found</div>
        )}
        {renderTree(roots, 0, [])}
      </div>

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
