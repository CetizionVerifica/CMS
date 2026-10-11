import { CheckCircle2, LoaderCircle, RotateCcw, Trash2, UploadCloud, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';

import { cx } from '../lib/cx';
import { formatDate, formatPercent } from '../lib/format';
import { Button, IconButton } from '../primitives/Button';
import { ConfirmDialog } from './ConfirmDialog';
import { ProgressBar } from './ProgressBar';

export type UploadState = 'queued' | 'uploading' | 'scanning' | 'ready' | 'blocked' | 'failed';

export type UploadItem = {
  id: string;
  name: string;
  /** Bytes. */
  size: number;
  state: UploadState;
  /** Bytes sent while uploading. */
  loaded?: number;
  addedBy?: string;
  /** YYYY-MM-DD in the client's time zone. */
  addedOn?: string;
};

export type FileDropProps = {
  /** Extensions without the dot, e.g. ["pdf", "jpg"]. */
  accept: string[];
  /** Default 25 MB. */
  maxBytes?: number;
  multiple?: boolean;
  /** Controlled; the upload transport lives in the web app. */
  files: UploadItem[];
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  /** Opens a ready file. The app fetches a short-lived signed URL on click; URLs never sit in the DOM. */
  onOpen?: (id: string) => void;
  disabled?: { reason: string };
  /** Accessible name of the zone, e.g. "Evidence". */
  label?: string;
  className?: string;
};

type Rejected = { id: string; name: string; message: string };

const MB = 1024 * 1024;
const formatSize = (bytes: number) =>
  bytes >= MB
    ? `${Math.round((bytes / MB) * 10) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** "Challan_Ap…_2022.pdf": keeps the start, the end and the extension. */
export function middleTruncate(name: string, max = 28): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  const keep = max - ext.length - 1;
  const head = Math.ceil(keep * 0.6);
  return `${base.slice(0, head)}…${base.slice(base.length - (keep - head))}${ext}`;
}

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

function announcement(item: UploadItem): string | null {
  switch (item.state) {
    case 'scanning':
      return `${item.name} uploaded, checking for viruses`;
    case 'ready':
      return `${item.name} ready`;
    case 'blocked':
      return `${item.name} blocked: failed virus check`;
    case 'failed':
      return `${item.name} upload failed`;
    default:
      return null;
  }
}

/**
 * Spec 15 · FileDrop. Evidence upload with a drop zone, a real "choose files" button, paste, client-side checks and a
 * live region for each state change. File names and contents are never logged.
 */
export function FileDrop({
  accept,
  maxBytes = 25 * MB,
  multiple = true,
  files,
  onAdd,
  onRemove,
  onRetry,
  onCancel,
  onOpen,
  disabled,
  label = 'Files',
  className,
}: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const rejectSeq = useRef(0);
  const allowed = accept.map((a) => a.toLowerCase().replace(/^\./, ''));
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [message, setMessage] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<UploadItem | null>(null);
  const previous = useRef(new Map<string, UploadState>());

  // Announce each state change once.
  useEffect(() => {
    for (const f of files) {
      if (previous.current.get(f.id) !== f.state) {
        const text = announcement(f);
        if (text && previous.current.has(f.id)) setMessage(text);
      }
    }
    previous.current = new Map(files.map((f) => [f.id, f.state]));
  }, [files]);

  const take = (list: File[]) => {
    if (disabled || list.length === 0) return;
    const chosen = multiple ? list : list.slice(0, 1);
    const ok: File[] = [];
    const bad: Rejected[] = [];
    for (const file of chosen) {
      const ext = extension(file.name);
      if (!allowed.includes(ext)) {
        bad.push({
          id: `rejected-${(rejectSeq.current += 1)}`,
          name: file.name,
          message: `Wrong type (${ext ? ext.toUpperCase() : 'no extension'}). Use ${allowed.map((a) => a.toUpperCase()).join(', ')}.`,
        });
      } else if (file.size > maxBytes) {
        bad.push({
          id: `rejected-${(rejectSeq.current += 1)}`,
          name: file.name,
          message: `Too large (${formatSize(file.size)}). Max ${formatSize(maxBytes)}.`,
        });
      } else ok.push(file);
    }
    setRejected(multiple ? (r) => [...r, ...bad] : bad);
    if (bad.length) setMessage(bad.map((b) => `${b.name}: ${b.message}`).join(' '));
    if (ok.length) onAdd(ok);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    take([...e.dataTransfer.files]);
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (pasted.length) {
      e.preventDefault();
      take(pasted);
    }
  };

  const hint = `${allowed.map((a) => a.toUpperCase()).join(', ')} up to ${formatSize(maxBytes)}${multiple ? ' each' : ''}`;
  const filled = !multiple && files.length > 0;
  const remove = (f: UploadItem) => (f.state === 'ready' ? setConfirmRemove(f) : onRemove(f.id));
  // After a confirmed removal the row is gone: focus the row that took its place, else the way to add a file.
  const removedIndex = useRef(0);
  const focusAfterRemove = () => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('li') ?? [];
    const row = rows[Math.min(removedIndex.current, rows.length - 1)];
    return (
      row?.querySelector<HTMLElement>('button') ??
      chooseRef.current ??
      replaceRef.current ??
      undefined
    );
  };

  return (
    <div className={cx('flex flex-col gap-2', className)} onPaste={onPaste}>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple={multiple}
        accept={allowed.map((a) => `.${a}`).join(',')}
        onChange={(e) => {
          take([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {disabled ? (
        <p className="rounded-card border border-line bg-mist px-4 py-3 text-body text-muted">
          {disabled.reason}
        </p>
      ) : filled ? null : (
        <div
          role="group"
          aria-label={label}
          aria-describedby={hintId}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
          className={cx(
            'flex min-h-24 flex-col items-center justify-center gap-1 rounded-card border-2 px-4 py-3 text-center',
            'transition-colors duration-fast has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-forest',
            dragging
              ? 'border-solid border-forest bg-mist'
              : 'border-dashed border-line-strong bg-surface hover:border-forest',
          )}
        >
          <UploadCloud aria-hidden size={20} className="text-forest" />
          <p className="text-body text-ink">
            {dragging ? (
              'Drop to upload'
            ) : (
              <>
                Drag {multiple ? 'files' : 'a file'} here or{' '}
                <button
                  ref={chooseRef}
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="font-bold text-forest underline underline-offset-2 outline-none"
                >
                  choose {multiple ? 'files' : 'a file'}
                </button>
              </>
            )}
          </p>
          <p id={hintId} className="text-meta text-muted">
            {hint}
          </p>
        </div>
      )}

      {files.length || rejected.length ? (
        <ul ref={listRef} aria-label={`${label} list`} className="flex flex-col gap-1">
          {files.map((f, i) => (
            <FileRow
              key={f.id}
              item={f}
              editable={!disabled}
              onRemove={() => {
                removedIndex.current = i;
                remove(f);
              }}
              onRetry={() => onRetry(f.id)}
              onCancel={() => onCancel(f.id)}
              onOpen={onOpen ? () => onOpen(f.id) : undefined}
            />
          ))}
          {rejected.map((r) => (
            <li
              key={r.id}
              className="flex min-h-12 items-center gap-3 rounded-chip bg-crit-soft px-2 py-1.5"
            >
              <TypeBadge name={r.name} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body text-ink" title={r.name}>
                  {middleTruncate(r.name)}
                </span>
                <span className="text-meta text-crit-ink">{r.message}</span>
              </span>
              <IconButton
                label={`Dismiss ${r.name}`}
                icon={X}
                variant="ghost"
                onClick={() => setRejected((xs) => xs.filter((x) => x.id !== r.id))}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {filled && !disabled ? (
        <Button
          ref={replaceRef}
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => inputRef.current?.click()}
        >
          Replace file
        </Button>
      ) : null}

      <span role="status" className="sr-only">
        {message}
      </span>

      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title={`Remove ${confirmRemove?.name ?? 'this file'}?`}
        body="The file is removed from this instance and the removal is recorded in its activity."
        confirmLabel="Remove"
        tone="danger"
        returnFocusTo={focusAfterRemove}
        onConfirm={() => {
          if (confirmRemove) onRemove(confirmRemove.id);
        }}
      />
    </div>
  );
}

function TypeBadge({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-8 w-10 shrink-0 items-center justify-center rounded-tag bg-neutral-soft text-label uppercase text-ink"
    >
      {extension(name).slice(0, 4) || 'FILE'}
    </span>
  );
}

type RowProps = {
  item: UploadItem;
  editable: boolean;
  onRemove: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onOpen?: () => void;
};

function FileRow({ item, editable, onRemove, onRetry, onCancel, onOpen }: RowProps) {
  const { state } = item;
  const percent = item.loaded !== undefined && item.size ? (item.loaded / item.size) * 100 : 0;
  const meta =
    state === 'queued'
      ? 'Waiting'
      : state === 'uploading'
        ? `${formatPercent(percent)} · ${formatSize(item.loaded ?? 0).replace(' MB', '')} of ${formatSize(item.size)}`
        : state === 'scanning'
          ? 'Checking for viruses'
          : state === 'ready'
            ? [
                formatSize(item.size),
                item.addedBy ? `Added by ${item.addedBy}` : null,
                item.addedOn ? formatDate(item.addedOn) : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : state === 'blocked'
              ? 'Blocked: failed virus check'
              : 'Upload failed';
  const bad = state === 'blocked' || state === 'failed';

  return (
    <li
      className={cx(
        'flex min-h-12 items-center gap-3 rounded-chip px-2 py-1.5',
        state === 'blocked' && 'bg-crit-soft',
      )}
    >
      <TypeBadge name={item.name} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {state === 'ready' && onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            title={item.name}
            className="self-start truncate text-left text-body text-ink underline-offset-2 hover:underline"
          >
            {middleTruncate(item.name)}
          </button>
        ) : (
          <span className="truncate text-body text-ink" title={item.name}>
            {middleTruncate(item.name)}
          </span>
        )}
        <span
          className={cx('flex items-center gap-1 text-meta', bad ? 'text-crit-ink' : 'text-muted')}
        >
          {state === 'scanning' ? (
            <LoaderCircle
              aria-hidden
              size={16}
              className="animate-[canopy-spin_1s_linear_infinite] motion-reduce:animate-none"
            />
          ) : null}
          {state === 'ready' ? <CheckCircle2 aria-hidden size={16} className="text-ok" /> : null}
          {meta}
        </span>
        {state === 'uploading' ? (
          <ProgressBar label={`Uploading ${item.name}`} value={percent} max={100} />
        ) : null}
      </span>
      {editable ? (
        state === 'queued' || state === 'uploading' ? (
          <IconButton label={`Cancel ${item.name}`} icon={X} variant="ghost" onClick={onCancel} />
        ) : state === 'failed' ? (
          <span className="flex">
            <IconButton
              label={`Retry ${item.name}`}
              icon={RotateCcw}
              variant="ghost"
              onClick={onRetry}
            />
            <IconButton
              label={`Remove ${item.name}`}
              icon={Trash2}
              variant="ghost"
              onClick={onRemove}
            />
          </span>
        ) : state === 'scanning' ? null : (
          <IconButton
            label={`Remove ${item.name}`}
            icon={Trash2}
            variant="ghost"
            onClick={onRemove}
          />
        )
      ) : null}
    </li>
  );
}
