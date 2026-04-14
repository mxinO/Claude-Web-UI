import { useRef, useEffect } from 'react';

export interface AutocompleteItem {
  label: string;
  detail?: string;
  icon?: string;
}

interface AutocompleteProps {
  items: AutocompleteItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  visible: boolean;
}

export default function Autocomplete({ items, selectedIndex, onSelect, visible }: AutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current && listRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!visible || items.length === 0) return null;

  return (
    <div className="autocomplete-dropdown" ref={listRef}>
      {items.map((item, i) => (
        <div
          key={`${item.label}-${i}`}
          ref={i === selectedIndex ? selectedRef : undefined}
          className={`autocomplete-item${i === selectedIndex ? ' selected' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault(); // prevent textarea blur
            onSelect(i);
          }}
        >
          {item.icon && <span className="autocomplete-icon">{item.icon}</span>}
          <span className="autocomplete-label">{item.label}</span>
          {item.detail && <span className="autocomplete-detail">{item.detail}</span>}
        </div>
      ))}
    </div>
  );
}
