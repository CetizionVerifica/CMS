'use client';
// The instance drawer over the register (apps/web/CLAUDE.md "Instance drawer"): status and due date in the header,
// then description, applicability, Act, forms, log sheets, evidence, comments and history. The footer offers only
// the actions the API lists in `allowedActions`, each at the version the person is looking at.
import {
  EVIDENCE_EXTENSIONS,
  Id,
  MAX_EVIDENCE_BYTES,
  type Comment,
  type EvidenceView,
  type InstanceDetail,
} from '@canopy/contracts';
import {
  Button,
  ConfirmDialog,
  CriticalityTag,
  DateInput,
  Drawer,
  DrawerSection,
  FileDrop,
  formatDate,
  formatTimestamp,
  IconButton,
  middleTruncate,
  StatusPill,
  Textarea,
  Timeline,
  toast,
} from '@canopy/ui';
import { Download, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  confirmEvidenceUpload,
  evidenceDownload,
  loadInstanceDrawer,
  loadMoreHistory,
  postComment,
  reloadEvidence,
  removeEvidenceFile,
  runInstanceAction,
  startEvidenceUpload,
} from '../instance-actions';
import { statusValue } from '../_lib/columns';
import { fileSize, openEvidence, SCAN_TEXT } from '../_lib/evidence-files';
import type { UploadCalls } from '../_lib/evidence-upload';
import type { DrawerData, Outcome, WorkflowAction } from '../_lib/instance-api';
import { commentLabel, timelineEvents } from '../_lib/timeline';
import { useEvidenceUploads } from './useEvidenceUploads';

export type InstanceDrawerProps = {
  /** The instance to show; null keeps the drawer closed. */
  instanceId: string | null;
  /** The row's title while the instance loads. */
  fallbackTitle?: string;
  /** The client's IANA time zone, for comment and history times. */
  timeZone: string;
  /** May remove evidence (FIRM_ADMIN, CONSULTANT, CLIENT_ADMIN); an owner may remove from their own instance. */
  canManage: boolean;
  personId: string;
  onClose: () => void;
  /** The phone layout's back button, named after the page under the drawer. */
  backLabel?: string;
  onPrev?: () => void;
  onNext?: () => void;
  /** The instance changed here (an action, evidence, a comment); the grid shows the new row. */
  onChanged: (detail: InstanceDetail) => void;
};

/** How often, and how many times, the drawer re-reads evidence that is still being checked for viruses. */
export const SCAN_POLL_MS = 2000;
export const SCAN_POLL_TRIES = 30;

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'unavailable' }
  | { state: 'ready'; data: DrawerData };

type Ask = 'APPROVE' | 'SEND_BACK' | 'REQUEST_NA' | 'REOPEN';

const ASK_COPY: Record<
  Ask,
  { title: string; body: string; confirm: string; reason: string; required: boolean }
> = {
  APPROVE: {
    title: 'Approve this instance?',
    body: 'It counts as complied from now on.',
    confirm: 'Approve',
    reason: 'Comment (optional)',
    required: false,
  },
  SEND_BACK: {
    title: 'Send this back to the owner?',
    body: 'The owner sees your reason and submits again.',
    confirm: 'Send back',
    reason: 'Reason',
    required: true,
  },
  REQUEST_NA: {
    title: 'Ask to mark this not applicable?',
    body: 'The approver sees your reason and decides.',
    confirm: 'Ask for not applicable',
    reason: 'Why it doesn’t apply',
    required: true,
  },
  REOPEN: {
    title: 'Reopen this instance?',
    body: 'It goes back to the owner as open work, and its result no longer counts.',
    confirm: 'Reopen',
    reason: 'Reason',
    required: true,
  },
};

const DONE: Record<WorkflowAction['kind'], string> = {
  SUBMIT: 'Submitted for approval.',
  REQUEST_NA: 'Sent to the approver as not applicable.',
  APPROVE: 'Approved.',
  SEND_BACK: 'Sent back to the owner.',
  REOPEN: 'Reopened.',
};

/** Codes after which what the person sees is out of date: the drawer reloads the instance. */
const RELOAD_CODES = new Set(['STALE_VERSION', 'INVALID_TRANSITION']);

export function InstanceDrawer({
  instanceId,
  fallbackTitle,
  timeZone,
  canManage,
  personId,
  onClose,
  backLabel = 'Back to the register',
  onPrev,
  onNext,
  onChanged,
}: InstanceDrawerProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const seq = useRef(0);

  // Typed input. It belongs to one instance: a new instance starts empty.
  const [completedOn, setCompletedOn] = useState<string | null>(null);
  const [submitComment, setSubmitComment] = useState('');
  const [submitErrors, setSubmitErrors] = useState<{ date?: string; comment?: string }>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'action' | 'comment' | 'history' | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [removing, setRemoving] = useState<EvidenceView | null>(null);

  // An action often removes the button that started it (Submit, Approve, a file's Remove). Focus then goes to the
  // drawer's title, so a keyboard user stays in the drawer with its new state announced.
  const anchor = useRef<HTMLSpanElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drawerTitle = useCallback(() => {
    const dialog = anchor.current?.closest<HTMLElement>('[role="dialog"]');
    const id = dialog?.getAttribute('aria-labelledby');
    return (id ? document.getElementById(id) : null) ?? dialog ?? undefined;
  }, []);
  const returnFocus = useCallback(
    () => (opener.current?.isConnected ? opener.current : drawerTitle()),
    [drawerTitle],
  );
  const openAsk = useCallback((next: Ask) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAsk(next);
  }, []);
  const openRemove = useCallback((evidence: EvidenceView) => {
    opener.current = null;
    setRemoving(evidence);
  }, []);

  const fetchDrawer = useCallback(async (id: string, quiet: boolean) => {
    const mine = ++seq.current;
    // A path that isn't an instance id names nothing the person can see.
    if (!Id.safeParse(id).success) return setLoad({ state: 'unavailable' });
    if (!quiet) setLoad({ state: 'loading' });
    let result: Outcome<DrawerData>;
    try {
      result = await loadInstanceDrawer(id);
    } catch {
      result = { ok: false, code: 'UNKNOWN', message: 'The instance didn’t load. Try again.' };
    }
    if (mine !== seq.current) return;
    if (result.ok) setLoad({ state: 'ready', data: result.data });
    else if (['NOT_FOUND', 'FORBIDDEN', 'ACCESS_EXPIRED'].includes(result.code))
      setLoad({ state: 'unavailable' });
    else if (!quiet) setLoad({ state: 'error', message: 'The instance didn’t load. Try again.' });
  }, []);

  useEffect(() => {
    setCompletedOn(null);
    setSubmitComment('');
    setSubmitErrors({});
    setDraft('');
    setAsk(null);
    setRemoving(null);
    if (instanceId) void fetchDrawer(instanceId, false);
    else seq.current++;
  }, [instanceId, fetchDrawer]);

  const data = load.state === 'ready' ? load.data : null;
  const detail = data?.detail ?? null;
  const allowed = useMemo(() => new Set(detail?.allowedActions ?? []), [detail]);

  const setData = useCallback((change: (data: DrawerData) => DrawerData) => {
    setLoad((current) =>
      current.state === 'ready' ? { state: 'ready', data: change(current.data) } : current,
    );
  }, []);

  // Evidence still being checked for viruses: read it again until every file has a result.
  const pending = data?.evidence.some((e) => e.scanStatus === 'PENDING') ?? false;
  useEffect(() => {
    if (!pending || !instanceId) return;
    let tries = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      tries += 1;
      const result = await reloadEvidence(instanceId).catch(() => null);
      if (stopped) return;
      if (result?.ok) setData((d) => ({ ...d, evidence: result.data }));
      const still = result?.ok ? result.data.some((e) => e.scanStatus === 'PENDING') : true;
      if (still && tries < SCAN_POLL_TRIES) timer = setTimeout(() => void poll(), SCAN_POLL_MS);
    };
    timer = setTimeout(() => void poll(), SCAN_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending, instanceId, setData]);

  /** After a change: show it in the grid now, and refresh comments and history behind it. */
  const changed = useCallback(
    (next: InstanceDetail) => {
      setData((d) => ({ ...d, detail: next }));
      onChanged(next);
      if (instanceId) void fetchDrawer(instanceId, true);
    },
    [fetchDrawer, instanceId, onChanged, setData],
  );

  const uploadCalls = useMemo<UploadCalls | null>(
    () =>
      instanceId
        ? {
            start: (file) => startEvidenceUpload(instanceId, file),
            confirm: (upload) => confirmEvidenceUpload(instanceId, upload),
          }
        : null,
    [instanceId],
  );
  const onConfirmed = useCallback(
    (evidence: EvidenceView) => {
      setData((d) => ({ ...d, evidence: [...d.evidence, evidence] }));
      if (instanceId) void fetchDrawer(instanceId, true);
    },
    [fetchDrawer, instanceId, setData],
  );
  const uploads = useEvidenceUploads(instanceId, uploadCalls, onConfirmed);

  /** Runs a workflow action. Resolves when it is done or out of date; rejects when the person can fix and retry. */
  const act = useCallback(
    async (action: WorkflowAction): Promise<boolean> => {
      if (!instanceId) return false;
      setBusy('action');
      try {
        const result = await runInstanceAction(instanceId, action).catch(
          (): Outcome<InstanceDetail> => ({
            ok: false,
            code: 'UNKNOWN',
            message: 'That didn’t go through. Try again.',
          }),
        );
        if (result.ok) {
          toast({ tone: 'success', message: DONE[action.kind] });
          changed(result.data);
          return true;
        }
        toast({ tone: 'error', message: result.message });
        if (RELOAD_CODES.has(result.code)) {
          void fetchDrawer(instanceId, true);
          return true;
        }
        if (action.kind === 'SUBMIT' && result.code === 'DATE_IN_FUTURE') {
          setSubmitErrors({ date: result.message });
        }
        return false;
      } finally {
        setBusy(null);
      }
    },
    [changed, fetchDrawer, instanceId],
  );

  const submit = useCallback(async () => {
    if (!detail || busy) return;
    const errors: { date?: string; comment?: string } = {};
    if (!completedOn) errors.date = 'Enter the date the work was done.';
    if (!submitComment.trim()) errors.comment = 'Say what was done.';
    setSubmitErrors(errors);
    if (errors.date || errors.comment || !completedOn) return;
    const done = await act({
      kind: 'SUBMIT',
      version: detail.version,
      completedOn,
      comment: submitComment.trim(),
    });
    if (done) {
      setCompletedOn(null);
      setSubmitComment('');
      // The form and its Submit button are gone once the instance is submitted.
      requestAnimationFrame(() => drawerTitle()?.focus());
    }
  }, [act, busy, completedOn, detail, drawerTitle, submitComment]);

  const confirmAsk = useCallback(
    async (text?: string) => {
      if (!detail || !ask) return;
      const version = detail.version;
      const action: WorkflowAction =
        ask === 'APPROVE'
          ? { kind: 'APPROVE', version, ...(text ? { comment: text } : {}) }
          : { kind: ask, version, reason: text ?? '' };
      if (!(await act(action))) throw new Error('not done');
    },
    [act, ask, detail],
  );

  const comment = useCallback(async () => {
    const body = draft.trim();
    if (!instanceId || !body || busy) return;
    setBusy('comment');
    try {
      const result = await postComment(instanceId, body).catch((): Outcome<Comment> => ({
        ok: false,
        code: 'UNKNOWN',
        message: 'The comment didn’t post. Try again.',
      }));
      if (!result.ok) {
        toast({ tone: 'error', message: result.message });
        return;
      }
      setDraft('');
      setData((d) => ({ ...d, comments: [...d.comments, result.data] }));
      void fetchDrawer(instanceId, true);
    } finally {
      setBusy(null);
    }
  }, [busy, draft, fetchDrawer, instanceId, setData]);

  const moreHistory = useCallback(async () => {
    const cursor = data?.audit.nextCursor;
    if (!instanceId || !cursor || busy) return;
    setBusy('history');
    try {
      const result = await loadMoreHistory(instanceId, cursor).catch(() => null);
      if (!result?.ok) {
        toast({ tone: 'error', message: 'More history didn’t load. Try again.' });
        return;
      }
      setData((d) => ({
        ...d,
        audit: {
          events: [...d.audit.events, ...result.data.events],
          nextCursor: result.data.nextCursor,
        },
      }));
    } finally {
      setBusy(null);
    }
  }, [busy, data?.audit.nextCursor, instanceId, setData]);

  const download = useCallback(async (evidence: EvidenceView) => {
    const failure = await openEvidence(evidence.id, evidenceDownload);
    if (failure) toast({ tone: 'error', message: failure });
  }, []);

  const remove = useCallback(
    async (reason?: string) => {
      if (!removing || !instanceId) return;
      const result = await removeEvidenceFile(removing.id, reason ?? '').catch(() => null);
      if (!result?.ok) {
        toast({ tone: 'error', message: result?.message ?? 'The file wasn’t removed. Try again.' });
        throw new Error('not removed');
      }
      setData((d) => ({ ...d, evidence: d.evidence.filter((e) => e.id !== removing.id) }));
      void fetchDrawer(instanceId, true);
    },
    [fetchDrawer, instanceId, removing, setData],
  );

  const dirty = completedOn !== null || submitComment.trim() !== '' || draft.trim() !== '';
  const canRemove =
    !!detail && allowed.has('UPLOAD_EVIDENCE') && (canManage || detail.ownerId === personId);
  const events = useMemo(() => (data ? timelineEvents(data.audit.events, data.names) : []), [data]);

  const footer = detail ? (
    <Footer
      detail={detail}
      allowed={allowed}
      busy={busy === 'action'}
      onSubmit={() => void submit()}
      onAsk={openAsk}
    />
  ) : null;

  const copy = ask ? ASK_COPY[ask] : null;
  const approveNa = ask === 'APPROVE' && detail?.pendingKind === 'NA';

  return (
    <>
      <Drawer
        open={instanceId !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={detail?.title ?? fallbackTitle ?? 'Instance'}
        eyebrow={detail?.externalRef ?? undefined}
        meta={detail ? <Meta detail={detail} /> : undefined}
        itemNoun="instance"
        // Moving to another instance would drop what's typed, so the arrows wait until it is sent or cleared.
        onPrev={dirty ? undefined : onPrev}
        onNext={dirty ? undefined : onNext}
        footer={footer}
        onSubmitShortcut={allowed.has('SUBMIT') ? () => void submit() : undefined}
        dirty={dirty}
        dirtyPrompt={{
          title: 'Discard what you’ve typed?',
          body: 'Your comment and completion details for this instance will be lost.',
        }}
        loading={load.state === 'loading'}
        error={
          load.state === 'error'
            ? {
                message: load.message,
                retry: () => instanceId && void fetchDrawer(instanceId, false),
              }
            : undefined
        }
        unavailable={load.state === 'unavailable'}
        backLabel={backLabel}
      >
        {data && detail ? (
          <>
            <span ref={anchor} hidden />
            {allowed.has('SUBMIT') ? (
              <DrawerSection title="Mark as done">
                <div className="flex flex-col gap-3">
                  <DateInput
                    label="Completed on"
                    required
                    value={completedOn}
                    onValueChange={(value) => {
                      setCompletedOn(value);
                      setSubmitErrors((e) => ({ ...e, date: undefined }));
                    }}
                    error={submitErrors.date}
                  />
                  <Textarea
                    label="What was done"
                    helper="Where the proof is, too. The approver reads this."
                    required
                    rows={3}
                    maxLength={5000}
                    value={submitComment}
                    onChange={(e) => {
                      setSubmitComment(e.target.value);
                      setSubmitErrors((er) => ({ ...er, comment: undefined }));
                    }}
                    error={submitErrors.comment}
                  />
                  {detail.evidenceRequired ? (
                    <p className="text-meta text-muted">
                      This obligation needs evidence: attach it below before you submit.
                    </p>
                  ) : null}
                </div>
              </DrawerSection>
            ) : null}

            <DrawerSection title="Description">
              <p className="whitespace-pre-line text-body text-ink">{detail.description}</p>
            </DrawerSection>

            {detail.applicabilityText ? (
              <DrawerSection title="Applicability">
                <p className="whitespace-pre-line text-body text-ink">{detail.applicabilityText}</p>
              </DrawerSection>
            ) : null}

            {detail.naReason ? (
              <DrawerSection title="Why it doesn’t apply">
                <p className="whitespace-pre-line text-body text-ink">{detail.naReason}</p>
              </DrawerSection>
            ) : null}

            <DrawerSection title="Details">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-body">
                <Fact label="Act">{detail.actName}</Fact>
                <Fact label="Category">{detail.categoryName}</Fact>
                <Fact label="Unit">
                  {detail.unitName}
                  <span className="block text-meta text-muted">{detail.locationLabel}</span>
                </Fact>
                <Fact label="Department">{detail.departmentName}</Fact>
                <Fact label="Owner">{detail.ownerName}</Fact>
                <Fact label="Approver">{detail.approverName}</Fact>
                <Fact label="Period">
                  {formatDate(detail.periodStart)} to {formatDate(detail.periodEnd)}
                </Fact>
                {detail.completedOn ? (
                  <Fact label="Completed on">{formatDate(detail.completedOn)}</Fact>
                ) : null}
              </dl>
            </DrawerSection>

            <Templates title="Forms" items={detail.forms} empty="No forms for this obligation." />
            <Templates
              title="Log sheets"
              items={detail.logSheets}
              empty="No log sheets for this obligation."
            />

            <DrawerSection title="Evidence">
              <div className="flex flex-col gap-2">
                {data.evidence.length > 0 ? (
                  <ul aria-label="Evidence files" className="flex flex-col gap-1">
                    {data.evidence.map((e) => (
                      <EvidenceRow
                        key={e.id}
                        evidence={e}
                        addedBy={data.names[e.uploadedById]}
                        timeZone={timeZone}
                        onOpen={() => void download(e)}
                        onRemove={canRemove ? () => openRemove(e) : undefined}
                      />
                    ))}
                  </ul>
                ) : !allowed.has('UPLOAD_EVIDENCE') ? (
                  <p className="text-body text-muted">No evidence attached.</p>
                ) : null}
                {allowed.has('UPLOAD_EVIDENCE') ? (
                  <FileDrop
                    label="Add evidence"
                    accept={[...EVIDENCE_EXTENSIONS]}
                    maxBytes={MAX_EVIDENCE_BYTES}
                    files={uploads.items}
                    onAdd={uploads.add}
                    onRemove={uploads.remove}
                    onRetry={uploads.retry}
                    onCancel={uploads.cancel}
                  />
                ) : null}
              </div>
            </DrawerSection>

            <DrawerSection title="Comments">
              <div className="flex flex-col gap-3">
                {data.comments.length > 0 ? (
                  <ol aria-label="Comments" className="flex flex-col gap-3">
                    {data.comments.map((c) => (
                      <CommentItem
                        key={c.id}
                        comment={c}
                        author={c.authorId ? (data.names[c.authorId] ?? 'Someone') : 'Imported'}
                        timeZone={timeZone}
                      />
                    ))}
                  </ol>
                ) : (
                  <p className="text-body text-muted">No comments yet.</p>
                )}
                {data.moreComments ? (
                  <p className="text-meta text-muted">
                    Showing the first {data.comments.length} comments.
                  </p>
                ) : null}
                {allowed.has('COMMENT') ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      label="Add a comment"
                      rows={2}
                      maxLength={5000}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        // Ctrl/Cmd+Enter posts the comment here, rather than submitting the instance.
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          e.stopPropagation();
                          void comment();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      className="self-end"
                      loading={busy === 'comment'}
                      disabled={!draft.trim()}
                      onClick={() => void comment()}
                    >
                      Comment
                    </Button>
                  </div>
                ) : null}
              </div>
            </DrawerSection>

            <DrawerSection title="History">
              {events.length > 0 ? (
                <Timeline
                  events={events}
                  timeZone={timeZone}
                  hasMore={data.audit.nextCursor !== null}
                  loading={busy === 'history'}
                  onLoadMore={() => void moreHistory()}
                />
              ) : (
                <p className="text-body text-muted">No history yet.</p>
              )}
            </DrawerSection>
          </>
        ) : null}
      </Drawer>
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(open) => {
          if (!open) setAsk(null);
        }}
        title={approveNa ? 'Approve as not applicable?' : (copy?.title ?? '')}
        body={
          approveNa
            ? 'The owner asked for this to be marked not applicable. It stops counting as open work.'
            : copy?.body
        }
        confirmLabel={approveNa ? 'Approve as not applicable' : (copy?.confirm ?? '')}
        tone={ask === 'SEND_BACK' || ask === 'REOPEN' ? 'danger' : 'primary'}
        reason={copy ? { label: copy.reason, required: copy.required, maxLength: 2000 } : undefined}
        onConfirm={confirmAsk}
        returnFocusTo={returnFocus}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing ? middleTruncate(removing.fileName, 40) : 'this file'}?`}
        body="The file is removed from this instance and kept in the archive. The removal and your reason are recorded in its history."
        confirmLabel="Remove"
        tone="danger"
        reason={{ label: 'Reason', required: true, maxLength: 2000 }}
        returnFocusTo={returnFocus}
        onConfirm={remove}
      />
    </>
  );
}

function Meta({ detail }: { detail: InstanceDetail }) {
  return (
    <>
      <StatusPill {...statusValue(detail)} size="sm" />
      <CriticalityTag level={detail.criticality} size="sm" announcePrefix />
      <span>Due {formatDate(detail.dueDate)}</span>
    </>
  );
}

function Footer({
  detail,
  allowed,
  busy,
  onSubmit,
  onAsk,
}: {
  detail: InstanceDetail;
  allowed: ReadonlySet<string>;
  busy: boolean;
  onSubmit: () => void;
  onAsk: (ask: Ask) => void;
}) {
  const primary = allowed.has('SUBMIT') ? (
    <Button variant="primary" loading={busy} onClick={onSubmit}>
      Submit
    </Button>
  ) : allowed.has('APPROVE') ? (
    <Button variant="primary" loading={busy} onClick={() => onAsk('APPROVE')}>
      {detail.pendingKind === 'NA' ? 'Approve as not applicable' : 'Approve'}
    </Button>
  ) : null;
  const secondary = [
    allowed.has('REQUEST_NA') ? (
      <Button key="na" variant="ghost" disabled={busy} onClick={() => onAsk('REQUEST_NA')}>
        Not applicable…
      </Button>
    ) : null,
    allowed.has('SEND_BACK') ? (
      <Button key="back" disabled={busy} onClick={() => onAsk('SEND_BACK')}>
        Send back…
      </Button>
    ) : null,
    allowed.has('REOPEN') ? (
      <Button key="reopen" disabled={busy} onClick={() => onAsk('REOPEN')}>
        Reopen…
      </Button>
    ) : null,
  ].filter(Boolean);
  if (!primary && secondary.length === 0) return null;
  return (
    <>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">{secondary}</div>
      {primary}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}

function Templates({
  title,
  items,
  empty,
}: {
  title: string;
  items: InstanceDetail['forms'];
  empty: string;
}) {
  return (
    <DrawerSection title={title}>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-1 text-body text-ink">
          {items.map((t, i) => (
            <li key={`${t.label}-${i}`}>
              {t.label}
              {t.fileName ? <span className="text-meta text-muted"> ({t.fileName})</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-muted">{empty}</p>
      )}
    </DrawerSection>
  );
}

function EvidenceRow({
  evidence,
  addedBy,
  timeZone,
  onOpen,
  onRemove,
}: {
  evidence: EvidenceView;
  addedBy: string | undefined;
  timeZone: string;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const clean = evidence.scanStatus === 'CLEAN';
  const bad = evidence.scanStatus === 'INFECTED' || evidence.scanStatus === 'FAILED';
  const meta = [
    fileSize(evidence.sizeBytes),
    clean ? null : SCAN_TEXT[evidence.scanStatus],
    addedBy ? `Added by ${addedBy}` : null,
    formatTimestamp(evidence.createdAt, timeZone),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex min-h-12 items-center gap-2 rounded-chip px-2 py-1.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-ink" title={evidence.fileName}>
          {middleTruncate(evidence.fileName, 40)}
        </span>
        <span className={bad ? 'text-meta text-crit-ink' : 'text-meta text-muted'}>{meta}</span>
      </span>
      {clean ? (
        <IconButton
          label={`Open ${evidence.fileName}`}
          icon={Download}
          variant="ghost"
          onClick={onOpen}
        />
      ) : null}
      {onRemove ? (
        <IconButton
          label={`Remove ${evidence.fileName}`}
          icon={Trash2}
          variant="ghost"
          onClick={onRemove}
        />
      ) : null}
    </li>
  );
}

function CommentItem({
  comment,
  author,
  timeZone,
}: {
  comment: Comment;
  author: string;
  timeZone: string;
}) {
  const tag = commentLabel(comment.kind);
  return (
    <li className="flex flex-col gap-1">
      <p className="text-meta text-muted">
        <span className="font-semibold text-ink">{author}</span>
        {tag ? ` · ${tag}` : null} · {formatTimestamp(comment.createdAt, timeZone)}
      </p>
      <p className="whitespace-pre-line text-body text-ink">{comment.body}</p>
    </li>
  );
}
