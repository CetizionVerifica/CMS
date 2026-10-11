import type {
  Act,
  Assignment,
  AuditEvent,
  Category,
  Client,
  Comment,
  Company,
  ComplianceInstance,
  Department,
  Evidence,
  EvidenceView,
  ExportJob,
  Firm,
  ImportBatch,
  ImportIssue,
  ImportRow,
  InstanceRow,
  Location,
  MappingTemplate,
  Membership,
  Obligation,
  Person,
  Unit,
} from '@canopy/contracts';
import { describe, expectTypeOf, it } from 'vitest';
import type { TenantTx } from '../src/database.js';
import * as r from '../src/repositories/index.js';

/**
 * Repository signatures match the M0 types (MODULES.md M3 Accept). Checked by `tsc` (pnpm typecheck);
 * the runtime assertions are no-ops.
 */
type Get<T> = (tx: TenantTx, id: string) => Promise<T | null>;

describe('repository signatures', () => {
  it('return the contract entity types', () => {
    expectTypeOf(r.firms.current).returns.resolves.toEqualTypeOf<Firm>();
    expectTypeOf(r.clients.get).toEqualTypeOf<Get<Client>>();
    expectTypeOf(r.companies.get).toEqualTypeOf<Get<Company>>();
    expectTypeOf(r.locations.get).toEqualTypeOf<Get<Location>>();
    expectTypeOf(r.units.get).toEqualTypeOf<Get<Unit>>();
    expectTypeOf(r.departments.get).toEqualTypeOf<Get<Department>>();
    expectTypeOf(r.people.get).toEqualTypeOf<Get<Person>>();
    expectTypeOf(r.memberships.get).toEqualTypeOf<Get<Membership>>();
    expectTypeOf(r.acts.get).toEqualTypeOf<Get<Act>>();
    expectTypeOf(r.categories.get).toEqualTypeOf<Get<Category>>();
    expectTypeOf(r.obligations.get).toEqualTypeOf<Get<Obligation>>();
    expectTypeOf(r.assignments.get).toEqualTypeOf<Get<Assignment>>();
    expectTypeOf(r.instances.get).toEqualTypeOf<Get<ComplianceInstance>>();
    expectTypeOf(r.evidence.get).toEqualTypeOf<Get<Evidence>>();
    expectTypeOf(r.evidence.view).toEqualTypeOf<Get<EvidenceView>>();
    expectTypeOf(r.comments.get).toEqualTypeOf<Get<Comment>>();
    expectTypeOf(r.importBatches.get).toEqualTypeOf<Get<ImportBatch>>();
    expectTypeOf(r.importRows.get).toEqualTypeOf<Get<ImportRow>>();
    expectTypeOf(r.importIssues.get).toEqualTypeOf<Get<ImportIssue>>();
    expectTypeOf(r.mappingTemplates.get).toEqualTypeOf<Get<MappingTemplate>>();
    expectTypeOf(r.exportJobs.get).toEqualTypeOf<Get<ExportJob>>();
    expectTypeOf(r.auditEvents.forEntity).returns.resolves.toEqualTypeOf<AuditEvent[]>();
    expectTypeOf(r.evidence.forInstance).returns.resolves.toEqualTypeOf<EvidenceView[]>();
  });

  it('register rows are InstanceRow without the engine-derived fields', () => {
    expectTypeOf<r.RegisterRow>().toEqualTypeOf<Omit<InstanceRow, 'status' | 'overdueDays'>>();
    expectTypeOf(r.instances.register).returns.resolves.toEqualTypeOf<r.Page<r.RegisterRow>>();
  });

  it('create takes the entity without server-set fields; update takes the version', () => {
    expectTypeOf(r.clients.create).parameter(1).toEqualTypeOf<r.NewEntity<Client>>();
    expectTypeOf(r.instances.create).parameter(1).toEqualTypeOf<r.NewEntity<ComplianceInstance>>();
    expectTypeOf(r.instances.update).parameters.toEqualTypeOf<
      [TenantTx, string, number, Partial<r.NewEntity<ComplianceInstance>>]
    >();
    expectTypeOf(r.auditEvents.append)
      .parameter(1)
      .toEqualTypeOf<Omit<AuditEvent, 'id' | 'firmId' | 'at'>>();
  });
});
