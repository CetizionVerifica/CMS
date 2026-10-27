import {
  RiskItem as RiskItemRecord,
  type IsoRiskRule,
  type LocalDate,
  type RequestContext,
  type RiskControl,
  type RiskItem,
  type RiskItemView,
} from '@canopy/contracts';
import {
  acts,
  managementSystems,
  obligations,
  riskControls,
  riskItems,
  type RiskItemFilter,
  type TenantTx,
} from '@canopy/db';
import { isoTiming, isSignificant, riskRating } from '@canopy/engine';
import { authorize, canSee, isoResource, listScope, riskReach, type Reach } from './access.js';
import { definedOf, liveIn, type Calendar, type Core } from './db-context.js';
import { checkVersion, invalid, notFound } from './errors.js';
import { pageOf } from './paging.js';
import type { IsoHandlers } from './types.js';

/**
 * The risk register (docs/iso/model.md §3.5): risks, opportunities, aspects and hazards with the engine's rating and
 * significance stored at every write (model §1.7), the significance override, REVIEW, and the controls in place. A
 * completed treatment action adds its own control and asks for a re-rating (db-actions.ts). The mock's picks
 * (docs/contracts/iso-mock.md "Risks and objectives") hold here, except as ADR M16-0005 records.
 */

type Ids =
  | 'listIsoRisks'
  | 'createIsoRisk'
  | 'getIsoRisk'
  | 'updateIsoRisk'
  | 'archiveIsoRisk'
  | 'reviewIsoRisk'
  | 'setIsoRiskSignificance'
  | 'listIsoRiskControls'
  | 'createIsoRiskControl'
  | 'updateIsoRiskControl'
  | 'archiveIsoRiskControl';

type Rated = Pick<RiskItem, 'rating' | 'residualRating' | 'significant'>;

/**
 * The engine's stored results on a risk item: `rating` and `residualRating` from `riskRating`, and `significant` from
 * `isSignificant` on the rating with existing controls (model §1.7).
 */
export function rated(
  item: Pick<
    RiskItem,
    | 'likelihood'
    | 'severity'
    | 'residualLikelihood'
    | 'residualSeverity'
    | 'obligationIds'
    | 'significantOverride'
  >,
  rule: IsoRiskRule,
): Rated {
  const rating = riskRating(item.likelihood, item.severity);
  const residualRating =
    item.residualLikelihood === null || item.residualSeverity === null
      ? null
      : riskRating(item.residualLikelihood, item.residualSeverity);
  return {
    rating,
    residualRating,
    significant: isSignificant({ ...item, rating }, rule),
  };
}

/** The item with `reviewStatus` (model §5.2); an archived item is no longer reviewed. */
export function riskView(item: RiskItem, today: LocalDate, cal: Calendar): RiskItemView {
  return {
    ...item,
    reviewStatus: isoTiming(item.reviewDueOn, item.archivedAt !== null, today, cal),
  };
}

/** The kind rules of model §3.5 on the item as it will be stored (the record schema's own checks). */
function checkRiskRecord(item: RiskItem): void {
  const parsed = RiskItemRecord.safeParse(item);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    invalid(String(issue.path[0] ?? 'body'), issue.message);
  }
}

/** A HAZARD's controls name their place in the hierarchy of controls (model §3.5). */
function checkHierarchy(item: RiskItem, hierarchy: RiskControl['hierarchy'] | undefined): void {
  if (item.kind === 'HAZARD' && hierarchy === null) {
    invalid('hierarchy', 'A control on a HAZARD names its place in the hierarchy of controls');
  }
}

const textMatches = (q: string | undefined, ...values: (string | null)[]) =>
  q === undefined || values.some((v) => v?.toLowerCase().includes(q.toLowerCase()));

export function risksHandlers(core: Core): IsoHandlers<Ids> {
  /**
   * Legal links are live statutory obligations of the account (model §3.5): not archived, and not an activity of a
   * STANDARD act from the ISO catalogue copy (an act without a kind is a STATUTE).
   */
  async function checkObligations(tx: TenantTx, obligationIds: readonly string[]): Promise<void> {
    for (const id of obligationIds) {
      const obligation = await obligations.get(tx, id);
      const act = obligation === null ? null : await acts.get(tx, obligation.actId);
      if (obligation === null || obligation.archivedAt !== null || act?.kind === 'STANDARD') {
        invalid('obligationIds', 'Not a statutory obligation of this account');
      }
    }
  }

  /** The client's live risk item `id` the actor may see, with its system and reach, or 404. */
  async function loadRisk(tx: TenantTx, ctx: RequestContext, clientId: string, id: string) {
    const item = liveIn(await riskItems.get(tx, id), clientId);
    const system = await managementSystems.require(tx, item.managementSystemId);
    const reach = riskReach(system, item);
    if (!canSee(ctx, reach)) notFound();
    return { item, system, reach };
  }

  /** A live control of `item`, or 404 (another item's control included). */
  async function loadControl(tx: TenantTx, item: RiskItem, id: string): Promise<RiskControl> {
    const control = liveIn(await riskControls.get(tx, id), item.clientId);
    if (control.riskItemId !== item.id) notFound();
    return control;
  }

  /** `isoRisk.write` on the item; OW only as its owner. */
  const authorizeWrite = (ctx: RequestContext, item: RiskItem, reach: Reach) =>
    authorize(
      ctx,
      'isoRisk.write',
      isoResource(ctx, 'risk_item', reach, { ownerId: item.ownerId }),
    );

  async function view(tx: TenantTx, item: RiskItem): Promise<RiskItemView> {
    return riskView(
      item,
      await core.today(tx, item.clientId),
      await core.calendar(tx, item.clientId),
    );
  }

  /** Archives a row (no deletes, model §1.3) and audits it with its reason. */
  async function archived<T extends { id: string; clientId: string; archivedAt: string | null }>(
    tx: TenantTx,
    ctx: RequestContext,
    row: T,
    entityType: 'risk_item' | 'risk_control',
    reason: string,
    archive: () => Promise<T>,
  ): Promise<T> {
    const out = await archive();
    await core.audit(tx, ctx, row.clientId, {
      action: 'ARCHIVE',
      entityType,
      entityId: row.id,
      before: { archivedAt: null },
      after: { archivedAt: out.archivedAt },
      reason,
    });
    return out;
  }

  return {
    /**
     * Highest rating first, then in the order added. AP and OW see their units' items and the items they own; `ids`
     * and the other filters apply in SQL with that scope, then the order and the page.
     */
    async listIsoRisks({ ctx, params, query }) {
      const clientId = params.clientId!;
      authorize(ctx, 'isoRisk.read', { type: 'risk_item', clientId });
      const filter: RiskItemFilter = definedOf({
        ids: query.ids,
        managementSystemIds: query.managementSystemId,
        unitIds: query.unitId,
        kind: query.kind,
        significant: query.significant,
        climateRelated: query.climateRelated,
        ownerId: query.ownerId === 'me' ? ctx.personId : query.ownerId,
        includeArchived: query.includeArchived,
        scope: listScope(ctx, clientId),
      });
      return core.run(ctx, async (tx) => {
        const all: RiskItem[] = [];
        let cursor: string | null = null;
        do {
          const page = await riskItems.list(tx, clientId, {
            ...filter,
            limit: 200,
            ...(cursor === null ? {} : { cursor }),
          });
          all.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        // M3 lists by creation (uuid v7 ids); the rating order is stable on top of it.
        const rows = all
          .filter((r) => textMatches(query.q, r.activity, r.description, r.impact))
          .sort((a, b) => b.rating - a.rating);
        const page = pageOf(rows, query);
        const today = await core.today(tx, clientId);
        const cal = await core.calendar(tx, clientId);
        return { ...page, items: page.items.map((r) => riskView(r, today, cal)) };
      });
    },

    async createIsoRisk({ ctx, params, body }) {
      const clientId = params.clientId!;
      return core.run(ctx, async (tx) => {
        const { managementSystemId, ...fields } = body;
        const system = await core.loadSystem(tx, ctx, clientId, managementSystemId);
        // The creator must cover the item's unit (or, without one or with a unit not of the system, the system's).
        const unitOk =
          fields.unitId !== null &&
          (system.unitIds.length === 0 || system.unitIds.includes(fields.unitId));
        authorize(
          ctx,
          'isoRisk.write',
          isoResource(
            ctx,
            'risk_item',
            { clientId, unitIds: unitOk ? [fields.unitId!] : system.unitIds, people: [] },
            { ownerId: fields.ownerId },
          ),
        );
        if (fields.unitId !== null)
          await core.checkSystemUnits(tx, system, [fields.unitId], 'unitId');
        await core.checkPerson(tx, clientId, fields.ownerId, 'ownerId', { unitId: fields.unitId });
        await checkObligations(tx, fields.obligationIds);
        const cal = await core.calendar(tx, clientId);
        const stored = {
          ...fields,
          significantOverride: null,
          significanceReason: null,
          lastReviewedOn: null,
          ...rated({ ...fields, significantOverride: null }, cal.riskRule),
        };
        const item = await riskItems.create(tx, { clientId, managementSystemId, ...stored });
        await core.audit(tx, ctx, clientId, {
          action: 'CREATE',
          entityType: 'risk_item',
          entityId: item.id,
          after: { managementSystemId, ...stored },
        });
        return view(tx, item);
      });
    },

    async getIsoRisk({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoRisk.read', isoResource(ctx, 'risk_item', reach));
        return view(tx, item);
      });
    },

    /**
     * Field edits and re-rating; `kind` never changes and the item must still meet its kind's rules. Rating, residual
     * rating and significance are recomputed and stored (model §1.7); a new owner is a REASSIGN and a moved
     * `reviewDueOn` a DUE_DATE_CHANGE, each with the reason.
     */
    async updateIsoRisk({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { item, system, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        authorizeWrite(ctx, item, reach);
        const { version, reason, ...fields } = body;
        checkVersion(item, version);
        const defined = definedOf(fields) as Partial<RiskItem>;
        const cal = await core.calendar(tx, item.clientId);
        const merged: RiskItem = { ...item, ...defined };
        Object.assign(merged, rated(merged, cal.riskRule));
        if (merged.unitId !== null && merged.unitId !== item.unitId) {
          await core.checkSystemUnits(tx, system, [merged.unitId], 'unitId');
        }
        if (merged.ownerId !== item.ownerId || merged.unitId !== item.unitId) {
          await core.checkPerson(tx, item.clientId, merged.ownerId, 'ownerId', {
            unitId: merged.unitId,
          });
        }
        if (fields.obligationIds !== undefined) await checkObligations(tx, fields.obligationIds);
        checkRiskRecord(merged);
        const { rating, residualRating, significant } = merged;
        const updated = await core.edit(
          tx,
          ctx,
          item,
          { ...defined, rating, residualRating, significant },
          'risk_item',
          (changes) => riskItems.update(tx, item.id, version, changes),
          {
            split: { ownerId: 'REASSIGN', reviewDueOn: 'DUE_DATE_CHANGE' },
            reason: reason ?? null,
          },
        );
        return riskView(updated, await core.today(tx, item.clientId), cal);
      });
    },

    /** The item leaves the register; its actions can no longer be reopened (model §3.12). */
    async archiveIsoRisk({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        authorizeWrite(ctx, item, reach);
        checkVersion(item, body.version);
        const out = await archived(tx, ctx, item, 'risk_item', body.reason, () =>
          riskItems.archive(tx, item.id, body.version),
        );
        return view(tx, out);
      });
    },

    /** REVIEW: the item stands as rated; sets `lastReviewedOn` and the next review date, nothing else. */
    async reviewIsoRisk({ ctx, params, body, key }) {
      return core.keyed(ctx, key, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        authorizeWrite(ctx, item, reach);
        checkVersion(item, body.version);
        const today = await core.today(tx, item.clientId);
        if (body.nextReviewDueOn <= today) {
          invalid('nextReviewDueOn', 'The next review date is after today');
        }
        const updated = await riskItems.update(tx, item.id, item.version, {
          lastReviewedOn: today,
          reviewDueOn: body.nextReviewDueOn,
        });
        await core.audit(tx, ctx, item.clientId, {
          action: 'TRANSITION',
          entityType: 'risk_item',
          entityId: item.id,
          before: { lastReviewedOn: item.lastReviewedOn, reviewDueOn: item.reviewDueOn },
          after: {
            action: 'REVIEW',
            lastReviewedOn: today,
            reviewDueOn: body.nextReviewDueOn,
            ...(body.note === undefined ? {} : { note: body.note }),
          },
          delegated: ctx.personId !== item.ownerId,
        });
        return riskView(updated, today, await core.calendar(tx, item.clientId));
      });
    },

    /** Sets (true or false) or clears (null) the override with its reason; `significant` is recomputed. */
    async setIsoRiskSignificance({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoRisk.override', isoResource(ctx, 'risk_item', reach));
        const { version, significantOverride, reason } = body;
        checkVersion(item, version);
        const cal = await core.calendar(tx, item.clientId);
        const patch = {
          significantOverride,
          significanceReason: significantOverride === null ? null : reason,
          significant: rated({ ...item, significantOverride }, cal.riskRule).significant,
        };
        const updated = await core.edit(
          tx,
          ctx,
          item,
          patch,
          'risk_item',
          (changes) => riskItems.update(tx, item.id, version, changes),
          { reason, reasonOnUpdate: true },
        );
        return riskView(updated, await core.today(tx, item.clientId), cal);
      });
    },

    /** Controls in place, in the order added. */
    async listIsoRiskControls({ ctx, params }) {
      return core.run(ctx, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        authorize(ctx, 'isoRisk.read', isoResource(ctx, 'risk_item', reach));
        return { items: await riskControls.forRiskItem(tx, item.id) };
      });
    },

    /** A control put in place by hand (`sourceActionId` null); a completed treatment action adds its own. */
    async createIsoRiskControl({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        authorizeWrite(ctx, item, reach);
        checkHierarchy(item, body.hierarchy);
        const fields = {
          riskItemId: item.id,
          text: body.text,
          hierarchy: body.hierarchy,
          sourceActionId: null,
        };
        const control = await riskControls.create(tx, { clientId: item.clientId, ...fields });
        await core.audit(tx, ctx, item.clientId, {
          action: 'CREATE',
          entityType: 'risk_control',
          entityId: control.id,
          after: fields,
        });
        return control;
      });
    },

    async updateIsoRiskControl({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        const control = await loadControl(tx, item, params.controlId!);
        authorizeWrite(ctx, item, reach);
        const { version, ...fields } = body;
        checkVersion(control, version);
        checkHierarchy(item, fields.hierarchy);
        return core.edit(tx, ctx, control, fields, 'risk_control', (changes) =>
          riskControls.update(tx, control.id, version, changes),
        );
      });
    },

    async archiveIsoRiskControl({ ctx, params, body }) {
      return core.run(ctx, async (tx) => {
        const { item, reach } = await loadRisk(tx, ctx, params.clientId!, params.id!);
        const control = await loadControl(tx, item, params.controlId!);
        authorizeWrite(ctx, item, reach);
        checkVersion(control, body.version);
        return archived(tx, ctx, control, 'risk_control', body.reason, () =>
          riskControls.archive(tx, control.id, body.version),
        );
      });
    },
  };
}
