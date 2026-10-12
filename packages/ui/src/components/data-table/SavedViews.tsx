import { Check, ChevronDown, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '../../primitives/Button';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../../primitives/Menu';
import { ConfirmDialog } from '../ConfirmDialog';

/** A personal saved view. What it stores (filters, sort, columns, density) is the app's business, keyed by `id`. */
export type SavedView = { id: string; name: string };

export type SavedViewsProps = {
  /** The user's personal views. "Default" is built in and is not part of the list. */
  list: SavedView[];
  /** Id of the view in use; `undefined` is Default. */
  current?: string;
  /** Id of the view the register opens on for this user; `undefined` is Default. */
  defaultId?: string;
  /** The table state differs from the current view: shows "• Edited" with Save and Discard. */
  edited?: boolean;
  onSelect: (id: string | undefined) => void;
  /** Save the current table state as a new view. */
  onSave: (name: string) => Promise<void> | void;
  /** Save the edits into the current personal view. Without it, Save asks for a new name. */
  onUpdate?: (id: string) => Promise<void> | void;
  onDiscard?: () => void;
  onRename: (id: string, name: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onSetDefault: (id: string | undefined) => Promise<void> | void;
};

const DEFAULT_VALUE = '__default__';
const NAME = { label: 'View name', required: true, maxLength: 60, multiline: false } as const;

/**
 * Spec 09 · Saved views. The DataTable toolbar's view menu: Default and personal views, then save, rename, delete and
 * "Set as my default". Controlled: the app stores views and applies them to the table.
 */
export function SavedViews({
  list,
  current,
  defaultId,
  edited = false,
  onSelect,
  onSave,
  onUpdate,
  onDiscard,
  onRename,
  onDelete,
  onSetDefault,
}: SavedViewsProps) {
  const [dialog, setDialog] = useState<'save' | 'rename' | 'delete' | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const view = list.find((v) => v.id === current);
  const name = view?.name ?? 'Default';
  const isMyDefault = (view?.id ?? undefined) === (defaultId ?? undefined);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const toTrigger = () => triggerRef.current;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Menu>
        <MenuTrigger asChild>
          <Button ref={triggerRef} size="sm" variant="ghost" className="min-w-0">
            <span className="truncate">View: {name}</span>
            <ChevronDown aria-hidden size={16} className="shrink-0" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="max-w-80">
          <MenuRadioGroup
            value={view?.id ?? DEFAULT_VALUE}
            onValueChange={(v) => onSelect(v === DEFAULT_VALUE ? undefined : v)}
          >
            {[{ id: DEFAULT_VALUE, name: 'Default' }, ...list].map((v) => {
              const mine = (v.id === DEFAULT_VALUE ? undefined : v.id) === (defaultId ?? undefined);
              return (
                <MenuRadioItem key={v.id} value={v.id}>
                  <span className="truncate">{v.name}</span>
                  {mine ? (
                    <span className="ml-auto pl-2 text-meta text-muted">My default</span>
                  ) : null}
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem icon={Plus} onSelect={() => setDialog('save')}>
            Save current view…
          </MenuItem>
          {view ? (
            <>
              <MenuItem icon={Pencil} onSelect={() => setDialog('rename')}>
                Rename…
              </MenuItem>
              <MenuItem icon={Trash2} destructive onSelect={() => setDialog('delete')}>
                Delete…
              </MenuItem>
            </>
          ) : null}
          {isMyDefault ? null : (
            <MenuItem icon={Star} onSelect={() => void onSetDefault(view?.id)}>
              Set as my default
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {edited ? (
        <>
          <span className="text-meta text-muted">• Edited</span>
          <Button
            size="sm"
            variant="ghost"
            icon={Check}
            onClick={() => (view && onUpdate ? void onUpdate(view.id) : setDialog('save'))}
          >
            Save
          </Button>
          {onDiscard ? (
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              Discard
            </Button>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={dialog === 'save'}
        onOpenChange={close}
        title="Save current view?"
        body="Saves the filters, sort, columns and density. Only you see it."
        confirmLabel="Save view"
        reason={NAME}
        returnFocusTo={toTrigger}
        onConfirm={(n) => onSave(n ?? '')}
      />
      <ConfirmDialog
        open={dialog === 'rename' && !!view}
        onOpenChange={close}
        title={`Rename "${name}"?`}
        confirmLabel="Rename"
        reason={{ ...NAME, initialValue: view?.name }}
        returnFocusTo={toTrigger}
        onConfirm={(n) => (view ? onRename(view.id, n ?? '') : undefined)}
      />
      <ConfirmDialog
        open={dialog === 'delete' && !!view}
        onOpenChange={close}
        title={`Delete "${name}"?`}
        body="The view is removed for you. No data changes."
        confirmLabel="Delete view"
        tone="danger"
        returnFocusTo={toTrigger}
        onConfirm={() => (view ? onDelete(view.id) : undefined)}
      />
    </div>
  );
}
