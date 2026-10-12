import * as contracts from '@canopy/contracts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { TABLES } from './support/tables.js';

describe('schema', () => {
  it('declares the v1 tables from packages/db/CLAUDE.md', () => {
    expect(TABLES.map((t) => t.name)).toEqual(
      [
        'act',
        'auth_credential',
        'auth_invite',
        'auth_session',
        'auth_token',
        'assignment',
        'audit_event',
        'category',
        'client',
        'comment',
        'company',
        'compliance_instance',
        'department',
        'domain_event',
        'evidence',
        'export_job',
        'firm',
        'idempotency_key',
        'import_batch',
        'import_issue',
        'import_row',
        'location',
        'mapping_template',
        'membership',
        'notification_send',
        'obligation',
        'person',
        'unit',
      ].sort(),
    );
  });

  it('gives every table an RLS policy and a firm_id (firm: its id)', () => {
    for (const { name, table, columns } of TABLES) {
      const config = getTableConfig(table);
      expect(config.policies.length, name).toBeGreaterThan(0);
      expect(columns, name).toContain(name === 'firm' ? 'id' : 'firm_id');
    }
  });

  it.each([
    [schema.roleEnum, contracts.Role],
    [schema.personStatusEnum, contracts.PersonStatus],
    [schema.criticalityEnum, contracts.Criticality],
    [schema.workflowStateEnum, contracts.WorkflowState],
    [schema.submissionKindEnum, contracts.SubmissionKind],
    [schema.auditActionEnum, contracts.AuditAction],
    [schema.entityTypeEnum, contracts.EntityType],
    [schema.importIssueTypeEnum, contracts.ImportIssueType],
    [schema.canopyFieldEnum, contracts.CanopyField],
  ])('enum %# matches the contract', (pgEnum, zodEnum) => {
    expect(pgEnum.enumValues).toEqual(zodEnum.options);
  });

  it('does not store the derived status', () => {
    for (const { name, columns } of TABLES) {
      expect(columns, name).not.toContain('status_cache');
      expect(columns, name).not.toContain('derived_status');
    }
  });
});
