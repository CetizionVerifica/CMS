import {
  IsoStandardCode,
  REVIEW_FIGURE_KEYS,
  ReviewInputKey,
  ReviewOutputKey,
  type IsoReviewInputDef,
  type IsoReviewOutputDef,
  type LocalDate,
  type ManagementReview,
  type ManagementReviewView,
  type ManagementSystem,
  type RequestContext,
  type ReviewClauseRef,
  type ReviewFigureKeyInfo,
  type ReviewInput,
  type ReviewInputFigures,
  type ReviewInputView,
  type ReviewOutput,
  type ReviewOutputView,
} from '@canopy/contracts';
import {
  isoActions,
  isoCatalogue,
  isoVisibleIds,
  managementReviews,
  managementSystems,
  reviewFigures,
  reviewInputs,
  reviewOutputs,
  type FigureRefs,
  type ManagementReviewFilter,
  type TenantTx,
} from '@canopy/db';
import {
  ENGINE_VERSION,
  ISO_TRANSITIONS,
  isoTransition,
  localDateIn,
  reviewInputFigures,
} from '@canopy/engine';
import {
  authorize,
  canSee,
  holdsRole,
  isoResource,
  listScope,
  may,
  reviewReach,
  selfResource,
  systemReach,
  type Reach,
} from './access.js';
import { definedOf, liveIn, same, type Core } from './db-context.js';
import { checkVersion, invalid, invalidTransition, notFound, stepTo } from './errors.js';
import { pageOf } from './paging.js';
import type { IsoCall, IsoHandlers } from './types.js';

/**
 * Management reviews with their input and output rows (docs/iso/model.md §3.13, §4.5): every arrow of the
 * MANAGEMENT_REVIEW machine through the engine, the edit of attendees and minutes (`isoReview.write`: a manager, or an
 * approver or owner who chairs it), the replan of standards, date and chair (`isoReview.plan`), and each input's
 * figures from ISO-2h's `reviewFigures.gather` and the engine's `reviewInputFigures` (model §5.4): computed live while
 * PLANNED, stored once at RECORD_HELD. The mock's picks (docs/contracts/iso-mock.md "Management reviews and files")
 * hold here, except as ADR M16-0008 records.
 */

type Ids =
  | 'listIsoManagementReviews'
  | 'planIsoManagementReview'
  | 'getIsoManagementReview'
  | 'updateIsoManagementReview'
  | 'replanIsoManagementReview'
  | 'cancelIsoManagementReview'
  | 'recordIsoManagementReviewHeld'
  | 'closeIsoManagementReview'
  | 'listIsoReviewInputs'
  | 'updateIsoReviewInput'
  | 'listIsoReviewOutputs'
  | 'updateIsoReviewOutput';

type ReviewStep = ManagementReviewView['allowedActions'][number];
type Code = IsoStandardCode;
type Figures = ReviewInputFigures;
type FigureTable = FigureRefs[number]['table'];

/** Review states after which it takes no more edits, input notes, output decisions or files (model §1.8, §6). */
const FINAL: readonly string[] = ['CLOSED', 'CANCELLED'];

/** `standards` in code order (9001, 14001, 45001), so an unchanged set never reads as a change. */
const inCodeOrder = (standards: readonly Code[]): Code[] =>
  IsoStandardCode.options.filter((code) => standards.includes(code));

/** By creation: ids are UUIDv7, so id order is the order rows were added. */
const byCreation = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

/** The catalogue's standards and review definitions, as a review's rows read them. */
interface Catalogue {
  codeOf: Map<string, Code>;
  inputs: Map<string, IsoReviewInputDef>;
  outputs: Map<string, IsoReviewOutputDef>;
  /** Every definition in code order, then catalogue order (clause, item). */
  inputList: IsoReviewInputDef[];
  outputList: IsoReviewOutputDef[];
}

async function catalogueOf(tx: TenantTx): Promise<Catalogue> {
  const codeOf = new Map((await isoCatalogue.standards(tx)).map((s) => [s.id, s.code]));
  const { inputs, outputs } = await isoCatalogue.reviewDefs(tx);
  const rank = (d: { standardId: string }) =>
    IsoStandardCode.options.indexOf(codeOf.get(d.standardId)!);
  // The sort is stable: within a standard the repository's clause order stays.
  const inputList = [...inputs].sort((a, b) => rank(a) - rank(b));
  const outputList = [...outputs].sort((a, b) => rank(a) - rank(b));
  return {
    codeOf,
    inputs: new Map(inputs.map((d) => [d.id, d])),
    outputs: new Map(outputs.map((d) => [d.id, d])),
    inputList,
    outputList,
  };
}

/** Where `def`'s key sits in each standard of the review: every definition of it (the view's `clauseRefs`). */
function clauseRefsOf(
  cat: Catalogue,
  review: ManagementReview,
  defs: readonly (IsoReviewInputDef | IsoReviewOutputDef)[],
  def: IsoReviewInputDef | IsoReviewOutputDef,
): ReviewClauseRef[] {
  const of = (d: IsoReviewInputDef | IsoReviewOutputDef): ReviewClauseRef => ({
    standard: cat.codeOf.get(d.standardId)!,
    clauseNumber: d.clauseNumber,
    item: d.item,
  });
  const refs = defs.filter(
    (d) => d.key === def.key && review.standards.includes(cat.codeOf.get(d.standardId)!),
  );
  // A row always has a definition among the review's standards; fall back to its own for a hand-seeded one.
  return refs.length > 0 ? refs.map(of) : [of(def)];
}

/** The review's live rows of one kind, in key order. */
function inKeyOrder<R>(
  rows: readonly R[],
  keyOf: (row: R) => string,
  order: readonly string[],
): R[] {
  return [...rows].sort((a, b) => order.indexOf(keyOf(a)) - order.indexOf(keyOf(b)));
}

/** The engine version stays on the row, not in the view: the pack and the archive print it (model §9). */
const withoutEngineVersion = ({ figuresEngineVersion: _version, ...rest }: ReviewInput) => rest;

/** Who reads the records each figure names, cut per table (`REVIEW_FIGURE_KEYS`), and whether any id dropped. */
async function forReader(
  tx: TenantTx,
  ctx: RequestContext,
  clientId: string,
  figures: Figures,
): Promise<{ figures: Figures; cut: boolean }> {
  const keys: Record<string, ReviewFigureKeyInfo> =
    figures.source === 'MANUAL' ? {} : REVIEW_FIGURE_KEYS[figures.source];
  const refs: { at: number; table: FigureTable; ids: string[] }[] = [];
  figures.figures.forEach((fig, at) => {
    const table = keys[fig.key]?.entityType as FigureTable | undefined;
    if (table !== undefined && fig.ids.length > 0) refs.push({ at, table, ids: fig.ids });
  });
  const visible = refs.length
    ? await isoVisibleIds(
        tx,
        clientId,
        refs.map(({ table, ids }) => ({ table, ids })),
        listScope(ctx, clientId),
      )
    : [];
  const shownAt = new Map(refs.map((r, i) => [r.at, visible[i]!.ids]));
  let cut = false;
  const shown = figures.figures.map((fig, at) => {
    // A key no table names lists no ids a reader may open.
    const ids = shownAt.get(at) ?? [];
    cut ||= ids.length < fig.ids.length;
    return { ...fig, ids };
  });
  return { figures: { ...figures, figures: shown }, cut };
}

export function reviewsHandlers(core: Core): IsoHandlers<Ids> {
  async function loadReview(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const review = liveIn(await managementReviews.get(tx, id), clientId);
    const system = await managementSystems.require(tx, review.managementSystemId);
    const reach = reviewReach(system, review);
    if (!canSee(ctx, reach)) notFound();
    return { review, system, reach };
  }

  const plansOn = (ctx: RequestContext, reach: Reach) =>
    isoResource(ctx, 'management_review', reach);
  /** The `isoReview.write` resource: the chair is "own" (plan §3.2); an attendee is not. */
  const writesOn = (ctx: RequestContext, review: ManagementReview, reach: Reach) =>
    selfResource(ctx, 'management_review', reach, [review.chairId]);

  const isClientAdmin = (ctx: RequestContext, clientId: string) =>
    holdsRole(ctx, clientId, ['CLIENT_ADMIN']);

  /** A step the chair or a client admin normally takes, taken by someone else as delegate (model §4 preamble). */
  const delegatedChairStep = (ctx: RequestContext, review: ManagementReview) =>
    ctx.personId !== review.chairId && !isClientAdmin(ctx, review.clientId);

  /**
   * A review with the steps the actor may take now (model §4.5): the arrows leaving its state, CANCEL for whoever plans
   * it, RECORD_HELD and CLOSE for whoever writes it.
   */
  function reviewView(
    ctx: RequestContext,
    system: ManagementSystem,
    review: ManagementReview,
  ): ManagementReviewView {
    const reach = reviewReach(system, review);
    const plans = may(ctx, 'isoReview.plan', plansOn(ctx, reach));
    const writes = may(ctx, 'isoReview.write', writesOn(ctx, review, reach));
    const allowedActions = ISO_TRANSITIONS.MANAGEMENT_REVIEW.filter(
      (a) => a.action !== 'PLAN' && a.from.includes(review.state),
    )
      .map((a) => a.action as ReviewStep)
      .filter((a) => (a === 'CANCEL' ? plans : writes));
    return { ...review, allowedActions };
  }

  /** The catalogue standard ids of `standards`, each one of the system's (400 on `standards` otherwise). */
  function standardIdsOf(cat: Catalogue, system: ManagementSystem, standards: readonly Code[]) {
    const ids = system.standardIds.filter((id) => standards.includes(cat.codeOf.get(id)!));
    if (ids.length !== new Set(standards).size) {
      invalid('standards', 'Not a standard of this management system');
    }
    return ids;
  }

  /** The chair and attendees work in the client (model §1.5); a review has no unit of its own. Only new names. */
  async function checkPeople(
    tx: TenantTx,
    clientId: string,
    people: { chairId?: string | undefined; attendeeIds?: readonly string[] | undefined },
    before?: ManagementReview,
  ): Promise<void> {
    if (people.chairId !== undefined && people.chairId !== before?.chairId) {
      await core.checkPerson(tx, clientId, people.chairId, 'chairId');
    }
    for (const id of people.attendeeIds ?? []) {
      if (!(before?.attendeeIds ?? []).includes(id)) {
        await core.checkPerson(tx, clientId, id, 'attendeeIds');
      }
    }
  }

  const inputsOf = async (tx: TenantTx, cat: Catalogue, review: ManagementReview) =>
    inKeyOrder(
      await reviewInputs.forReview(tx, review.id),
      (row) => cat.inputs.get(row.inputDefId)!.key,
      ReviewInputKey.options,
    );
  const outputsOf = async (tx: TenantTx, cat: Catalogue, review: ManagementReview) =>
    inKeyOrder(
      await reviewOutputs.forReview(tx, review.id),
      (row) => cat.outputs.get(row.outputDefId)!.key,
      ReviewOutputKey.options,
    );

  /**
   * `reviewInputFigures` for one non-MANUAL input over the review's whole system (plan §3.3's exception), from ISO-2h's
   * `gather` as of `asOf`: the client's today while PLANNED, its `heldOn` at RECORD_HELD (model §5.4).
   */
  async function computeFigures(
    tx: TenantTx,
    review: ManagementReview,
    def: IsoReviewInputDef,
    asOf: LocalDate,
    timeZone: string,
  ): Promise<Figures> {
    const gathered = await reviewFigures.gather(tx, review, def, asOf, (instant) =>
      localDateIn(instant, timeZone),
    );
    // `source` and `data` arrive as one pair of `GatheredFigures`.
    return reviewInputFigures(gathered.source, gathered.data as never, gathered.since, asOf);
  }

  /**
   * An input's figures and notes by its review's state (model §3.13): computed as of the client's today while PLANNED,
   * the stored copy once HELD or CLOSED (none for a row without one), none for a CANCELLED review or a MANUAL input.
   * Each figure's ids are cut to those the reader may read. An INCIDENTS row whose ids the reader may not all read is
   * withheld, figures and notes, unless the reader chairs or attends the review (item 4).
   */
  async function inputView(
    tx: TenantTx,
    ctx: RequestContext,
    cat: Catalogue,
    review: ManagementReview,
    row: ReviewInput,
  ): Promise<ReviewInputView> {
    const def = cat.inputs.get(row.inputDefId)!;
    const base = {
      ...withoutEngineVersion(row),
      key: def.key,
      title: def.title,
      source: def.source,
      clauseRefs: clauseRefsOf(cat, review, cat.inputList, def),
    };
    const none = {
      ...base,
      sourceFigures: null,
      figuresStoredAt: null,
      figuresWithheld: false,
      notes: row.notes,
    };
    if (def.source === 'MANUAL' || review.state === 'CANCELLED') return none;
    let shown: { figures: Figures; storedAt: string | null };
    if (review.state === 'PLANNED') {
      const { timeZone } = await core.calendar(tx, review.clientId);
      const today = localDateIn(core.now(), timeZone);
      shown = { figures: await computeFigures(tx, review, def, today, timeZone), storedAt: null };
    } else {
      if (row.sourceFigures === null) return none;
      shown = { figures: row.sourceFigures, storedAt: row.figuresStoredAt };
    }
    const { figures, cut } = await forReader(tx, ctx, review.clientId, shown.figures);
    const takesPart = review.chairId === ctx.personId || review.attendeeIds.includes(ctx.personId);
    if (def.source === 'INCIDENTS' && cut && !takesPart) {
      return { ...none, figuresWithheld: true, notes: null };
    }
    return { ...none, sourceFigures: figures, figuresStoredAt: shown.storedAt };
  }

  function outputView(
    cat: Catalogue,
    review: ManagementReview,
    row: ReviewOutput,
  ): ReviewOutputView {
    const def = cat.outputs.get(row.outputDefId)!;
    return {
      ...row,
      key: def.key,
      title: def.title,
      clauseRefs: clauseRefsOf(cat, review, cat.outputList, def),
    };
  }

  /** Notes, decisions and edits are taken until the review is CLOSED or CANCELLED (model §1.8). */
  function requireNotFinal(review: ManagementReview): void {
    if (FINAL.includes(review.state)) {
      invalidTransition('management_review', review.state, 'UPDATE');
    }
  }

  /**
   * Stores each live non-MANUAL input's figures as of `heldOn` (model §3.13), inside the RECORD_HELD transaction while
   * the review is still PLANNED, through `reviewInputs.storeFigures` with the engine version. A review held before its
   * system's creation day stores none, since the app held none of its records then; a row that already has figures
   * keeps them. Returns the stored figures by input key, for the event.
   */
  async function storeFigures(
    tx: TenantTx,
    cat: Catalogue,
    review: ManagementReview,
    system: ManagementSystem,
    heldOn: LocalDate,
  ): Promise<{ key: string; figures: Figures }[]> {
    const { timeZone } = await core.calendar(tx, review.clientId);
    if (heldOn < localDateIn(system.createdAt, timeZone)) return [];
    const stored: { key: string; figures: Figures }[] = [];
    for (const row of await inputsOf(tx, cat, review)) {
      const def = cat.inputs.get(row.inputDefId)!;
      if (def.source === 'MANUAL' || row.sourceFigures !== null) continue;
      const figures = await computeFigures(tx, review, def, heldOn, timeZone);
      await reviewInputs.storeFigures(tx, row.id, figures, ENGINE_VERSION);
      stored.push({ key: def.key, figures });
    }
    return stored;
  }

  /**
   * One arrow of the MANAGEMENT_REVIEW machine through the engine, audited as a TRANSITION naming the action with the
   * fields it set. CANCEL is `isoReview.plan`; RECORD_HELD and CLOSE are `isoReview.write`.
   */
  async function reviewStep<
    K extends
      'cancelIsoManagementReview' | 'recordIsoManagementReviewHeld' | 'closeIsoManagementReview',
  >(
    call: IsoCall<K>,
    action: ReviewStep,
    plan: (
      tx: TenantTx,
      cat: Catalogue,
      review: ManagementReview,
    ) => Promise<{ facts: Record<string, unknown>; change: Partial<ManagementReview> }>,
    options: {
      delegated: (review: ManagementReview) => boolean;
      /** Runs once the guards pass, before the review moves; what it returns joins the event's `after`. */
      before?: (
        tx: TenantTx,
        cat: Catalogue,
        review: ManagementReview,
        system: ManagementSystem,
        change: Partial<ManagementReview>,
      ) => Promise<Record<string, unknown>>;
    },
  ): Promise<ManagementReviewView> {
    const { ctx, params, body } = call;
    return core.keyed(ctx, call.key, async (tx) => {
      const { review, system, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
      if (action === 'CANCEL') {
        authorize(ctx, 'isoReview.plan', plansOn(ctx, reach));
      } else {
        authorize(ctx, 'isoReview.write', writesOn(ctx, review, reach));
      }
      checkVersion(review, body.version);
      if (
        !ISO_TRANSITIONS.MANAGEMENT_REVIEW.some(
          (a) => a.action === action && a.from.includes(review.state),
        )
      ) {
        invalidTransition('management_review', review.state, action);
      }
      const cat = await catalogueOf(tx);
      const { facts, change } = await plan(tx, cat, review);
      const to = stepTo(
        isoTransition('MANAGEMENT_REVIEW', review.state, action, facts),
        'management_review',
        review.state,
        action,
      );
      const extra = (await options.before?.(tx, cat, review, system, change)) ?? {};
      const patch = { ...change, state: to } as Partial<ManagementReview>;
      const keys = Object.keys(patch) as (keyof ManagementReview)[];
      const updated = await managementReviews.update(tx, review.id, review.version, patch as never);
      await core.audit(tx, ctx, review.clientId, {
        action: 'TRANSITION',
        entityType: 'management_review',
        entityId: review.id,
        before: Object.fromEntries(keys.map((k) => [k, review[k]])),
        after: { action, ...Object.fromEntries(keys.map((k) => [k, updated[k]])), ...extra },
        reason: 'reason' in body ? body.reason : null,
        delegated: options.delegated(review),
      });
      return reviewView(ctx, system, updated);
    });
  }

  /** A row of `review`, or 404 (another review's row included). */
  function rowOf<
    R extends { clientId: string; archivedAt: string | null; managementReviewId: string },
  >(row: R | null, review: ManagementReview): R {
    const live = liveIn(row, review.clientId);
    if (live.managementReviewId !== review.id) notFound();
    return live;
  }

  return {
    /** By planned date, then creation. AP and OW see reviews of systems over their units and those naming them. */
    async listIsoManagementReviews({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoReview.read', { type: 'management_review', clientId });
      return core.run(ctx, async (tx) => {
        const filter: ManagementReviewFilter = definedOf({
          managementSystemIds: query.managementSystemId,
          state: query.state,
          from: query.from,
          to: query.to,
          scope: listScope(ctx, clientId),
        });
        const reviews: ManagementReview[] = [];
        let cursor: string | null = null;
        do {
          const page = await managementReviews.list(tx, clientId, {
            ...filter,
            limit: 200,
            ...(cursor === null ? {} : { cursor }),
          });
          reviews.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        const systems = new Map<string, ManagementSystem>();
        const needle = query.q?.toLowerCase();
        const rows: { id: string; review: ManagementReview; system: ManagementSystem }[] = [];
        for (const review of reviews) {
          if (!systems.has(review.managementSystemId)) {
            systems.set(
              review.managementSystemId,
              await managementSystems.require(tx, review.managementSystemId),
            );
          }
          const system = systems.get(review.managementSystemId)!;
          if (
            needle === undefined ||
            [review.minutes, review.cancelReason, system.name].some((v) =>
              v?.toLowerCase().includes(needle),
            )
          ) {
            rows.push({ id: review.id, review, system });
          }
        }
        rows.sort(
          (a, b) => a.review.plannedOn.localeCompare(b.review.plannedOn) || byCreation(a, b),
        );
        const page = pageOf(rows, query);
        return { ...page, items: page.items.map((r) => reviewView(ctx, r.system, r.review)) };
      });
    },

    /**
     * PLAN (client admin; an account admin or consultant as delegate): a review of some of its system's standards, with
     * one input row per input key and one output row per output key of those standards.
     */
    async planIsoManagementReview({ ctx, params, body, key }) {
      const clientId = params.clientId!;
      return core.keyed(ctx, key, async (tx) => {
        const system = await core.loadSystem(tx, ctx, clientId, body.managementSystemId);
        authorize(ctx, 'isoReview.plan', plansOn(ctx, systemReach(system)));
        const cat = await catalogueOf(tx);
        const standards = inCodeOrder(body.standards);
        const standardIds = standardIdsOf(cat, system, standards);
        await checkPeople(tx, clientId, body);
        const review = await managementReviews.create(tx, {
          clientId,
          managementSystemId: system.id,
          standards,
          plannedOn: body.plannedOn,
          heldOn: null,
          chairId: body.chairId,
          attendeeIds: body.attendeeIds,
          minutes: null,
          state: 'PLANNED',
          cancelReason: null,
        });
        const inputs = await reviewInputs.addForReview(tx, review, standardIds);
        const outputs = await reviewOutputs.addForReview(tx, review, standardIds);
        const keysOf = (keys: string[], order: readonly string[]) =>
          inKeyOrder(keys, (k) => k, order);
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'management_review',
          entityId: review.id,
          after: {
            managementSystemId: system.id,
            standards: review.standards,
            plannedOn: review.plannedOn,
            chairId: review.chairId,
            attendeeIds: review.attendeeIds,
            state: review.state,
            inputKeys: keysOf(
              inputs.map((r) => cat.inputs.get(r.inputDefId)!.key),
              ReviewInputKey.options,
            ),
            outputKeys: keysOf(
              outputs.map((r) => cat.outputs.get(r.outputDefId)!.key),
              ReviewOutputKey.options,
            ),
          },
          delegated: !isClientAdmin(ctx, clientId),
        });
        return reviewView(ctx, system, review);
      });
    },

    async getIsoManagementReview({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { review, system, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoReview.read', plansOn(ctx, reach));
        return reviewView(ctx, system, review);
      });
    },

    /** Until CLOSED or CANCELLED: attendees and minutes (`isoReview.write`: a manager or the chair), as UPDATE. */
    async updateIsoManagementReview({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { review, system, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoReview.write', writesOn(ctx, review, reach));
        const { version, ...fields } = body;
        checkVersion(review, version);
        requireNotFinal(review);
        await checkPeople(tx, review.clientId, fields, review);
        if (review.state === 'HELD' && fields.attendeeIds?.length === 0) {
          invalid('attendeeIds', 'A held review keeps the people who attended it');
        }
        const updated = await core.edit<ManagementReview>(
          tx,
          ctx,
          review,
          fields,
          'management_review',
          (changes) => managementReviews.update(tx, review.id, version, changes as never),
        );
        return reviewView(ctx, system, updated);
      });
    },

    /**
     * `isoReview.plan` (FA, CO, CA) while PLANNED: standards, date and chair. New standards bring their rows and dropped
     * ones archive theirs (ISO-2h's `syncForReview`), the keys named in the UPDATE; a new date is a due-date change and
     * a new chair a reassignment, with the reason.
     */
    async replanIsoManagementReview({ ctx, params, body, key }) {
      return core.keyed(ctx, key, async (tx) => {
        const { review, system, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoReview.plan', plansOn(ctx, reach));
        const { version, reason, ...rest } = body;
        checkVersion(review, version);
        if (review.state !== 'PLANNED') {
          invalidTransition('management_review', review.state, 'UPDATE');
        }
        const fields = {
          ...rest,
          ...(rest.standards === undefined ? {} : { standards: inCodeOrder(rest.standards) }),
        };
        const cat = await catalogueOf(tx);
        let rows: Record<string, string[]> = {};
        if (fields.standards !== undefined) {
          const standardIds = standardIdsOf(cat, system, fields.standards);
          if (!same(fields.standards, review.standards)) {
            const inputs = await reviewInputs.syncForReview(tx, review, standardIds);
            const outputs = await reviewOutputs.syncForReview(tx, review, standardIds);
            rows = Object.fromEntries(
              Object.entries({
                inputKeysAdded: inputs.added,
                inputKeysRemoved: inputs.removed,
                outputKeysAdded: outputs.added,
                outputKeysRemoved: outputs.removed,
              }).filter(([, keys]) => keys.length > 0),
            );
          }
        }
        await checkPeople(tx, review.clientId, fields, review);
        const updated = await core.edit<ManagementReview>(
          tx,
          ctx,
          review,
          fields,
          'management_review',
          (changes) => managementReviews.update(tx, review.id, version, changes as never),
          {
            split: { plannedOn: 'DUE_DATE_CHANGE', chairId: 'REASSIGN' },
            reason: reason ?? null,
            updateAfter: rows,
          },
        );
        return reviewView(ctx, system, updated);
      });
    },

    /** CANCEL (client admin; an account admin or consultant as delegate): PLANNED → CANCELLED, with a reason. */
    cancelIsoManagementReview: (call) =>
      reviewStep(
        call,
        'CANCEL',
        async () => ({
          facts: { reason: call.body.reason },
          change: { cancelReason: call.body.reason },
        }),
        { delegated: (review) => !isClientAdmin(call.ctx, review.clientId) },
      ),

    /**
     * RECORD_HELD (chair or client admin; an account admin or consultant as delegate): PLANNED → HELD, on a day not after
     * the client's today, with at least one attendee and notes on every input row. Each input's figures are stored here,
     * counted up to `heldOn` over the whole system; the event carries their values without ids, and the engine version.
     */
    recordIsoManagementReviewHeld: (call) => {
      const { ctx, body } = call;
      return reviewStep(
        call,
        'RECORD_HELD',
        async (tx, cat, review) => {
          await checkPeople(tx, review.clientId, { attendeeIds: body.attendeeIds }, review);
          const attendeeIds = body.attendeeIds ?? review.attendeeIds;
          const inputs = await inputsOf(tx, cat, review);
          return {
            facts: {
              heldOn: body.heldOn,
              asOf: await core.today(tx, review.clientId),
              attendeeCount: attendeeIds.length,
              inputsWithoutNotesCount: inputs.filter((row) => row.notes === null).length,
            },
            change: {
              heldOn: body.heldOn,
              ...(body.attendeeIds === undefined ? {} : { attendeeIds }),
              ...(body.minutes === undefined ? {} : { minutes: body.minutes }),
            },
          };
        },
        {
          delegated: (review) => delegatedChairStep(ctx, review),
          // Model §3.13: stored once, here, while the review is still PLANNED; model §8: values only, ids stay on rows.
          before: async (tx, cat, review, system) => {
            const stored = await storeFigures(tx, cat, review, system, body.heldOn);
            return {
              figures: stored.map(({ key, figures }) => ({
                key,
                source: figures.source,
                since: figures.since,
                asOf: figures.asOf,
                values: Object.fromEntries(figures.figures.map((fig) => [fig.key, fig.value])),
              })),
              engineVersion: ENGINE_VERSION,
            };
          },
        },
      );
    },

    /**
     * CLOSE (chair or client admin; an account admin or consultant as delegate): HELD → CLOSED once every output row has
     * a decision and every review action is DONE or CANCELLED.
     */
    closeIsoManagementReview: (call) =>
      reviewStep(
        call,
        'CLOSE',
        async (tx, cat, review) => {
          const outputs = await outputsOf(tx, cat, review);
          const actions = await isoActions.forSubject(tx, {
            type: 'MANAGEMENT_REVIEW',
            id: review.id,
          });
          return {
            facts: {
              outputsWithoutDecisionCount: outputs.filter((row) => row.decision === null).length,
              openActionCount: actions.filter((a) => a.state === 'OPEN').length,
            },
            change: {},
          };
        },
        { delegated: (review) => delegatedChairStep(call.ctx, review) },
      ),

    /** In key order, each with its clause references and its source's figures. Whoever reads the review reads them. */
    async listIsoReviewInputs({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { review, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoReview.read', plansOn(ctx, reach));
        const cat = await catalogueOf(tx);
        const items: ReviewInputView[] = [];
        for (const row of await inputsOf(tx, cat, review)) {
          items.push(await inputView(tx, ctx, cat, review, row));
        }
        return { items };
      });
    },

    /** Notes on one input until the review is CLOSED or CANCELLED; a held review keeps notes on every input. */
    async updateIsoReviewInput({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { review, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoReview.write', writesOn(ctx, review, reach));
        const row = rowOf(await reviewInputs.get(tx, params.inputId!), review);
        checkVersion(row, body.version);
        requireNotFinal(review);
        if (review.state === 'HELD' && body.notes === null) {
          invalid('notes', 'A held review keeps notes on every input');
        }
        const cat = await catalogueOf(tx);
        let updated = row;
        if (row.notes !== body.notes) {
          const input = cat.inputs.get(row.inputDefId)!.key;
          updated = await reviewInputs.update(tx, row.id, body.version, { notes: body.notes });
          // Rows have no entity type of their own: they are audited on the review (model §8).
          await core.audit(tx, ctx, review.clientId, {
            action: 'UPDATE',
            entityType: 'management_review',
            entityId: review.id,
            before: { input, notes: row.notes },
            after: { input, notes: body.notes },
          });
        }
        return inputView(tx, ctx, cat, review, updated);
      });
    },

    /** In key order, each with its clause references. Whoever reads the review reads them. */
    async listIsoReviewOutputs({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { review, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoReview.read', plansOn(ctx, reach));
        const cat = await catalogueOf(tx);
        return {
          items: (await outputsOf(tx, cat, review)).map((row) => outputView(cat, review, row)),
        };
      });
    },

    /** The decision on one output, until the review is CLOSED or CANCELLED. */
    async updateIsoReviewOutput({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { review, reach } = await loadReview(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoReview.write', writesOn(ctx, review, reach));
        const row = rowOf(await reviewOutputs.get(tx, params.outputId!), review);
        checkVersion(row, body.version);
        requireNotFinal(review);
        const cat = await catalogueOf(tx);
        let updated = row;
        if (row.decision !== body.decision) {
          const output = cat.outputs.get(row.outputDefId)!.key;
          updated = await reviewOutputs.update(tx, row.id, body.version, {
            decision: body.decision,
          });
          await core.audit(tx, ctx, review.clientId, {
            action: 'UPDATE',
            entityType: 'management_review',
            entityId: review.id,
            before: { output, decision: row.decision },
            after: { output, decision: body.decision },
          });
        }
        return outputView(cat, review, updated);
      });
    },
  };
}
