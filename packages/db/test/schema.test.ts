import * as contracts from '@canopy/contracts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import { PLATFORM_TABLES, TABLES } from './support/tables.js';

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
        'certification',
        'certification_unit',
        'clause_assessment',
        'client',
        'comment',
        'company',
        'compliance_instance',
        'context_item',
        'controlled_document',
        'department',
        'document_revision',
        'domain_event',
        'evidence',
        'export_job',
        'external_audit',
        'firm',
        'idempotency_key',
        'import_batch',
        'import_issue',
        'import_row',
        'iso_clause',
        'iso_file',
        'iso_review_input_def',
        'iso_review_output_def',
        'iso_standard',
        'location',
        'management_system',
        'management_system_unit',
        'mapping_template',
        'membership',
        'notification_send',
        'obligation',
        'person',
        'support_grant',
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

  it('keeps the operator tables in schema platform (ADR M15-0001)', () => {
    expect(PLATFORM_TABLES.map((t) => t.name)).toEqual(
      [
        'account_override',
        'operator',
        'operator_audit_event',
        'operator_credential',
        'operator_session',
        'plan',
        'subscription',
        'usage_snapshot',
      ].sort(),
    );
    for (const { name, columns } of PLATFORM_TABLES) expect(columns, name).not.toContain('firm_id');
  });

  it.each([
    [schema.roleEnum, contracts.Role],
    [schema.personStatusEnum, contracts.PersonStatus],
    [schema.criticalityEnum, contracts.Criticality],
    [schema.workflowStateEnum, contracts.WorkflowState],
    [schema.submissionKindEnum, contracts.SubmissionKind],
    [schema.auditActionEnum, contracts.AuditAction],
    [schema.importIssueTypeEnum, contracts.ImportIssueType],
    [schema.canopyFieldEnum, contracts.CanopyField],
    [schema.isoStandardCodeEnum, contracts.IsoStandardCode],
    [schema.reviewInputKeyEnum, contracts.ReviewInputKey],
    [schema.reviewOutputKeyEnum, contracts.ReviewOutputKey],
    [schema.reviewInputSourceEnum, contracts.ReviewInputSource],
    [schema.managementSystemStatusEnum, contracts.ManagementSystemStatus],
    [schema.contextItemKindEnum, contracts.ContextItemKind],
    [schema.clauseStatusEnum, contracts.ClauseStatus],
    [schema.clauseNaStateEnum, contracts.ClauseNaState],
    [schema.documentTypeEnum, contracts.DocumentType],
    [schema.documentStatusEnum, contracts.DocumentStatus],
    [schema.revisionStateEnum, contracts.RevisionState],
    [schema.externalAuditTypeEnum, contracts.ExternalAuditType],
    [schema.auditRecommendationEnum, contracts.AuditRecommendation],
    [schema.externalAuditStateEnum, contracts.ExternalAuditState],
  ])('enum %# matches the contract', (pgEnum, zodEnum) => {
    expect(pgEnum.enumValues).toEqual(zodEnum.options);
  });

  // Values the database stores ahead of the contracts bump that lists them (contracts 1.5.1, then the account
  // export's bump, then the trial-ending email's, then the renewal and MFA notices', then the ISO add-on's ISO-1b).
  it.each([
    [schema.entityTypeEnum, contracts.EntityType, ['account', ...contracts.ISO_ENTITY_TYPES]],
    [schema.auditActorKindEnum, contracts.AuditActorKind, ['OPERATOR']],
    [
      schema.exportKindEnum,
      contracts.ExportKind,
      ['CLIENT_ARCHIVE_ZIP', ...contracts.ISO_EXPORT_KINDS],
    ],
    [
      schema.notificationKindEnum,
      contracts.NotificationKind,
      ['TRIAL_ENDING', 'RENEWAL_DUE', 'MFA_ENROLLED', ...contracts.ISO_NOTIFICATION_KINDS],
    ],
  ] as const)('enum %# matches the contract plus its staged values', (pgEnum, zodEnum, ahead) => {
    expect(pgEnum.enumValues).toEqual([...new Set([...zodEnum.options, ...ahead])]);
  });

  it.each([
    [schema.accountKindEnum, contracts.AccountKind],
    [schema.accountStatusEnum, contracts.AccountStatus],
    [schema.supportAccessLevelEnum, contracts.SupportAccessLevel],
    [schema.operatorAuditActionEnum, contracts.OperatorAuditAction],
  ])('account enum %# matches the contract', (pgEnum, zodEnum) => {
    expect(pgEnum.enumValues).toEqual(zodEnum.options);
  });

  it('the send-log client check names every account notification kind', () => {
    const [chk] = getTableConfig(schema.notificationSend).checks;
    const text = chk!.value.queryChunks
      .map((c) => (c as { value?: string[] }).value?.join('') ?? '')
      .join('');
    // RENEWAL_DUE is named ahead of the contracts bump that lists it as an account kind.
    const named = [...text.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(named).toEqual([...new Set([...contracts.ACCOUNT_NOTIFICATION_KINDS, 'RENEWAL_DUE'])]);
  });

  it('does not store the derived status', () => {
    for (const { name, columns } of TABLES) {
      expect(columns, name).not.toContain('status_cache');
      expect(columns, name).not.toContain('derived_status');
    }
  });
});
