import { Columns3, GripVertical } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import { cx } from '../../lib/cx';
import { Button, IconButton } from '../../primitives/Button';
import { Checkbox } from '../../primitives/Checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/Popover';

export type ChooserColumn = { id: string; label: string; locked: boolean };

export type ColumnChooserProps = {
  /** Columns in their current order. */
  columns: ChooserColumn[];
  visibility: Record<string, boolean>;
  onChange: (next: { visibility: Record<string, boolean>; order: string[] }) => void;
  onReset: () => void;
};

/**
 * Spec 09 · column chooser. Tick to show or hide; Alt+ArrowUp/Down (or drag the handle) to reorder. The locked title
 * column stays on.
 */
export function ColumnChooser({ columns, visibility, onChange, onReset }: ColumnChooserProps) {
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? columns.filter((c) => c.label.toLowerCase().includes(q)) : columns;
  const order = columns.map((c) => c.id);

  const move = (id: string, to: number) => {
    const from = order.indexOf(id);
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    onChange({ visibility, order: next });
    const label = columns.find((c) => c.id === id)!.label;
    setAnnouncement(`${label} moved to position ${to + 1} of ${order.length}`);
  };

  const onItemKeyDown = (e: KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(id, order.indexOf(id) + (e.key === 'ArrowUp' ? -1 : 1));
    // Keep focus on the moved item's checkbox after React reorders the list.
    const target = e.currentTarget.querySelector<HTMLElement>('button[role="checkbox"]');
    requestAnimationFrame(() => target?.focus());
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label="Columns" icon={Columns3} variant="ghost" />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Choose columns"
        align="end"
        className="flex w-72 flex-col gap-2 p-2"
      >
        <input
          aria-label="Search columns"
          placeholder="Search columns"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-control w-full rounded-control border border-line-strong bg-surface px-3 text-body text-ink placeholder:text-muted touch-target"
        />
        <p className="px-1 text-meta text-muted">Alt+Up or Alt+Down moves the focused column.</p>
        <ul aria-label="Columns" className="flex max-h-72 flex-col overflow-y-auto">
          {shown.map((c) => (
            <li
              key={c.id}
              draggable
              onDragStart={() => setDragging(c.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging) move(dragging, order.indexOf(c.id));
                setDragging(null);
              }}
              onKeyDown={(e) => onItemKeyDown(e, c.id)}
              className={cx(
                'flex items-center gap-1 rounded-[7px] pl-1 pr-2 hover:bg-mist',
                dragging === c.id && 'opacity-50',
              )}
            >
              <GripVertical aria-hidden size={16} className="shrink-0 cursor-grab text-muted" />
              <Checkbox
                label={c.locked ? `${c.label} (always shown)` : c.label}
                checked={c.locked || visibility[c.id] !== false}
                disabled={c.locked}
                onCheckedChange={(checked) =>
                  onChange({ visibility: { ...visibility, [c.id]: checked === true }, order })
                }
                className="flex-1"
              />
            </li>
          ))}
        </ul>
        <div className="flex justify-end border-t border-line pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onReset();
              setAnnouncement('Columns reset to default');
            }}
          >
            Reset to default
          </Button>
        </div>
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </PopoverContent>
    </Popover>
  );
}
