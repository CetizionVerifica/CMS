import type {
  LocalDate,
  ManagementSystem,
  Objective,
  ObjectiveReading,
  ObjectiveView,
  RequestContext,
} from '@canopy/contracts';
import {
  isoCatalogue,
  managementSystems,
  objectiveReadings,
  objectives,
  riskItems,
  type ObjectiveFilter,
  type TenantTx,
} from '@canopy/db';
import { localDateIn, objectiveProgress } from '@canopy/engine';
import { authorize, canSee, isoResource, listScope, objectiveReach, type Reach } from './access.js';
import { definedOf, liveIn, type Calendar, type Core } from './db-context.js';
import { checkVersion, invalid, invalidTransition, notFound } from './errors.js';
import { pageOf } from './paging.js';
import type { IsoHandlers } from './types.js';

/**
 * Objectives and their readings (docs/iso/model.md §3.6). Progress is the engine's `objectiveProgress`; a closed
 * objective is measured as at the day it closed and takes no edits and no readings (model §1.8). Closing writes one
 * TRANSITION whose `after.action` is `CLOSE` (model §8). The mock's picks (docs/contracts/iso-mock.md "Risks and
 * objectives") hold here.
 */

type Ids =
  | 'listIsoObjectives'
  | 'createIsoObjective'
  | 'getIsoObjective'
  | 'updateIsoObjective'
  | 'closeIsoObjective'
  | 'listIsoReadings'
  | 'createIsoReading'
  | 'updateIsoReading';

/** With a baseline, INCREASE keeps its target at or above it and DECREASE at or below it (iso-mock.md). */
function checkTarget(objective: Pick<Objective, 'baseline' | 'target' | 'direction'>): void {
  const { baseline, target, direction } = objective;
  if (baseline === null) return;
  if (direction === 'INCREASE' && target < baseline) {
    invalid('target', 'An INCREASE objective has a target at or above its baseline');
  }
  if (direction === 'DECREASE' && target > baseline) {
    invalid('target', 'A DECREASE objective has a target at or below its baseline');
  }
}

/** A closed objective takes no field edits and no new or corrected readings (model §1.8). */
function requireOpen(objective: Objective): void {
  if (objective.closedOn !== null) invalidTransition('objective', 'CLOSED', 'UPDATE');
}

const textMatches = (q: string | undefined, ...values: string[]) =>
  q === undefined || values.some((v) => v.toLowerCase().includes(q.toLowerCase()));

/** The objective with its progress, measured as at `closedOn` once it closed (iso-mock.md, "Stand-ins"). */
export function objectiveView(
  objective: Objective,
  readings: readonly ObjectiveReading[],
  today: LocalDate,
  cal: Calendar,
): ObjectiveView {
  const asOf =
    objective.closedOn !== null && objective.closedOn < today ? objective.closedOn : today;
  return {
    ...objective,
    progress: objectiveProgress(
      readings,
      { ...objective, createdOn: localDateIn(objective.createdAt, cal.timeZone) },
      asOf,
      cal,
    ),
  };
}

export function objectivesHandlers(core: Core): IsoHandlers<Ids> {
  /** Each standard is one of the system's (model §3.6): its catalogue standards' codes. */
  async function checkStandards(
    tx: TenantTx,
    system: ManagementSystem,
    standards: readonly string[],
  ): Promise<void> {
    const codes = new Set<string>();
    for (const id of system.standardIds) {
      const standard = await isoCatalogue.standard(tx, id);
      if (standard !== null) codes.add(standard.code);
    }
    if (standards.some((code) => !codes.has(code))) {
      invalid('standards', "Not a standard of the objective's management system");
    }
  }

  /** The risk items an objective addresses are live items of its own management system. */
  async function checkRiskItems(
    tx: TenantTx,
    system: ManagementSystem,
    riskItemIds: readonly string[],
  ): Promise<void> {
    for (const id of riskItemIds) {
      const item = await riskItems.get(tx, id);
      if (
        item === null ||
        item.clientId !== system.clientId ||
        item.archivedAt !== null ||
        item.managementSystemId !== system.id
      ) {
        invalid('riskItemIds', 'Not a risk item of this management system');
      }
    }
  }

  /** The client's live objective `id` the actor may see, with its system and reach, or 404. */
  async function loadObjective(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const objective = liveIn(await objectives.get(tx, id), clientId);
    const system = await managementSystems.require(tx, objective.managementSystemId);
    const reach = objectiveReach(system, objective);
    if (!canSee(ctx, reach)) notFound();
    return { objective, system, reach };
  }

  /** A live reading of `objective`, or 404 (another objective's reading included). */
  async function loadReading(
    tx: TenantTx,
    objective: Objective,
    id: string,
  ): Promise<ObjectiveReading> {
    const reading = liveIn(await objectiveReadings.get(tx, id), objective.clientId);
    if (reading.objectiveId !== objective.id) notFound();
    return reading;
  }

  /** `isoObjective.write` on the objective; OW only as its owner. */
  const authorizeWrite = (ctx: RequestContext, objective: Objective, reach: Reach) =>
    authorize(
      ctx,
      'isoObjective.write',
      isoResource(ctx, 'objective', reach, { ownerId: objective.ownerId }),
    );

  async function view(tx: TenantTx, objective: Objective): Promise<ObjectiveView> {
    return objectiveView(
      objective,
      await objectiveReadings.forObjective(tx, objective.id),
      await core.today(tx, objective.clientId),
      await core.calendar(tx, objective.clientId),
    );
  }

  return {
    /**
     * Earliest `dueOn` first, then in the order added. AP and OW see their system's objectives and the ones they own;
     * `ids` and the other filters apply in SQL with that scope, then the text and standards filters and the page.
     */
    async listIsoObjectives({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoObjective.read', { type: 'objective', clientId });
      const filter: ObjectiveFilter = definedOf({
        ids: query.ids,
        managementSystemIds: query.managementSystemId,
        ownerId: query.ownerId === 'me' ? ctx.personId : query.ownerId,
        open: query.open,
        scope: listScope(ctx, clientId),
      });
      return core.run(ctx, async (tx) => {
        const all: Objective[] = [];
        let cursor: string | null = null;
        do {
          const page = await objectives.list(tx, clientId, {
            ...filter,
            limit: 200,
            ...(cursor === null ? {} : { cursor }),
          });
          all.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        const rows = all.filter(
          (o) =>
            (query.standard === undefined ||
              o.standards.some((s) => query.standard!.includes(s))) &&
            textMatches(query.q, o.text, o.unitOfMeasure),
        );
        const page = pageOf(rows, query);
        const items: ObjectiveView[] = [];
        for (const objective of page.items) items.push(await view(tx, objective));
        return { ...page, items };
      });
    },

    async createIsoObjective({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const system = await core.loadSystem(tx, ctx, clientId, body.managementSystemId);
        // The creator must see the system; an owner adds objectives only as their owner.
        authorize(
          ctx,
          'isoObjective.write',
          isoResource(ctx, 'objective', objectiveReach(system, { ownerId: body.ownerId }), {
            ownerId: body.ownerId,
          }),
        );
        await checkStandards(tx, system, body.standards);
        await checkRiskItems(tx, system, body.riskItemIds);
        await core.checkPerson(tx, clientId, body.ownerId, 'ownerId');
        const fields = { ...body, closedOn: null, outcome: null };
        const objective = await objectives.create(tx, { clientId, ...fields });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'objective',
          entityId: objective.id,
          after: fields,
        });
        return view(tx, objective);
      });
    },

    async getIsoObjective({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { objective, reach } = await loadObjective(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoObjective.read', isoResource(ctx, 'objective', reach));
        return view(tx, objective);
      });
    },

    /** Field edits on an open objective; a new owner or `dueOn` carries its reason on the REASSIGN or DUE_DATE_CHANGE. */
    async updateIsoObjective({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { objective, system, reach } = await loadObjective(
          tx,
          ctx,
          params.clientId!,
          params.id!,
        );
        authorizeWrite(ctx, objective, reach);
        const { version, reason, ...fields } = body;
        checkVersion(objective, version);
        requireOpen(objective);
        if (fields.standards !== undefined) await checkStandards(tx, system, fields.standards);
        if (fields.riskItemIds !== undefined) await checkRiskItems(tx, system, fields.riskItemIds);
        if (fields.ownerId !== undefined && fields.ownerId !== objective.ownerId) {
          await core.checkPerson(tx, objective.clientId, fields.ownerId, 'ownerId');
        }
        checkTarget({ ...objective, ...definedOf(fields) });
        const updated = await core.edit(
          tx,
          ctx,
          objective,
          fields,
          'objective',
          (changes) => objectives.update(tx, objective.id, version, changes),
          { split: { ownerId: 'REASSIGN', dueOn: 'DUE_DATE_CHANGE' }, reason: reason ?? null },
        );
        return view(tx, updated);
      });
    },

    /** CLOSE: ends the objective with its outcome, on a day between its creation day and today. */
    async closeIsoObjective({ ctx, params, body, key }) {
      return core.keyed(ctx, key, async (tx) => {
        const { objective, reach } = await loadObjective(tx, ctx, params.clientId!, params.id!);
        authorizeWrite(ctx, objective, reach);
        const { version, closedOn, outcome } = body;
        checkVersion(objective, version);
        if (objective.closedOn !== null) invalidTransition('objective', 'CLOSED', 'CLOSE');
        const today = await core.today(tx, objective.clientId);
        if (closedOn > today) invalid('closedOn', 'An objective cannot close after today');
        const { timeZone } = await core.calendar(tx, objective.clientId);
        if (closedOn < localDateIn(objective.createdAt, timeZone)) {
          invalid('closedOn', 'An objective cannot close before it was set');
        }
        const updated = await objectives.update(tx, objective.id, version, { closedOn, outcome });
        await core.audit(tx, ctx, objective.clientId, {
          action: 'TRANSITION',
          entityType: 'objective',
          entityId: objective.id,
          before: { closedOn: null, outcome: null },
          after: { action: 'CLOSE', closedOn, outcome },
          delegated: ctx.personId !== objective.ownerId,
        });
        return view(tx, updated);
      });
    },

    /** By period: earliest `periodStart` first. */
    async listIsoReadings({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { objective, reach } = await loadObjective(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoObjective.read', isoResource(ctx, 'objective', reach));
        return { items: await objectiveReadings.forObjective(tx, objective.id) };
      });
    },

    /** A reading of a period that has started, overlapping no other reading of the objective. */
    async createIsoReading({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { objective, reach } = await loadObjective(tx, ctx, params.clientId!, params.id!);
        authorizeWrite(ctx, objective, reach);
        requireOpen(objective);
        if (body.periodStart > (await core.today(tx, objective.clientId))) {
          invalid('periodStart', 'A reading is for a period that has started');
        }
        const clash = (await objectiveReadings.forObjective(tx, objective.id)).find(
          (r) => r.periodStart <= body.periodEnd && r.periodEnd >= body.periodStart,
        );
        if (clash !== undefined) {
          invalid(
            'periodStart',
            `Overlaps the reading for ${clash.periodStart} to ${clash.periodEnd}; correct that reading instead`,
          );
        }
        const fields = { objectiveId: objective.id, ...body, recordedById: ctx.personId };
        const reading = await objectiveReadings.create(tx, {
          clientId: objective.clientId,
          ...fields,
        });
        await core.audit(tx, ctx, objective.clientId, {
          action: 'CREATE',
          entityType: 'objective_reading',
          entityId: reading.id,
          after: fields,
        });
        return reading;
      });
    },

    /** Corrects a reading's value or note on an open objective; its period never changes. */
    async updateIsoReading({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { objective, reach } = await loadObjective(tx, ctx, params.clientId!, params.id!);
        const reading = await loadReading(tx, objective, params.readingId!);
        authorizeWrite(ctx, objective, reach);
        const { version, ...fields } = body;
        checkVersion(reading, version);
        requireOpen(objective);
        return core.edit(tx, ctx, reading, fields, 'objective_reading', (changes) =>
          objectiveReadings.update(tx, reading.id, version, changes),
        );
      });
    },
  };
}
