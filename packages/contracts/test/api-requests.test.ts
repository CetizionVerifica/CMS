import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActCreateBody,
  ApiErrorResponse,
  AssignmentBulkBody,
  AssignmentCreateBody,
  AuditQuery,
  BreakdownQuery,
  bulkResults,
  CalendarQuery,
  ClientSettingsBody,
  csv,
  DashboardQuery,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_PAGE_LIMIT,
  DepartmentCreateBody,
  ERROR_DETAILS,
  ErrorCode,
  EvidenceConfirmBody,
  EvidenceUploadUrlBody,
  EvidenceVaultQuery,
  ExportCreateBody,
  ImportCreateBody,
  ImportIssueDecisionBody,
  InstanceRow,
  InstanceUpdateBody,
  LoginBody,
  InviteAcceptBody,
  InviteBody,
  Limit,
  MAX_EVIDENCE_BYTES,
  MAX_IMPORT_BYTES,
  ClientSummary,
  Me,
  MembershipGrant,
  ObligationCreateBody,
  ObligationUpdateBody,
  page,
  PersonCreateBody,
  PersonRef,
  QueryBoolean,
  RegisterQuery,
  RulePreviewBody,
  sortParam,
  SubmitBody,
  UnitUpdateBody,
} from '../src/index.js';
import { ID, instanceRow, membership, obligation, person, without } from './samples.js';

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const sha = 'a'.repeat(64);

describe('query-string values', () => {
  it('splits comma lists and checks each item', () => {
    const Statuses = csv(z.enum(['OVERDUE', 'DUE_SOON']));
    expect(Statuses.parse('OVERDUE,DUE_SOON')).toEqual(['OVERDUE', 'DUE_SOON']);
    expect(ok(Statuses, 'OVERDUE,LATE')).toBe(false);
    expect(ok(Statuses, '')).toBe(false);
  });

  it('defaults limit to 50 and caps it at 200', () => {
    expect(Limit.parse(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(Limit.parse('200')).toBe(200);
    expect(ok(Limit, '201')).toBe(false);
    expect(ok(Limit, '0')).toBe(false);
    expect(ok(Limit, '1.5')).toBe(false);
  });

  it('reads booleans and `me`', () => {
    expect(QueryBoolean.parse('true')).toBe(true);
    expect(QueryBoolean.parse('false')).toBe(false);
    expect(ok(QueryBoolean, 'yes')).toBe(false);
    expect(PersonRef.parse('me')).toBe('me');
    expect(PersonRef.parse(ID.owner)).toBe(ID.owner);
    expect(ok(PersonRef, 'you')).toBe(false);
  });

  it('parses sort lists and rejects unknown fields with 400 VALIDATION', () => {
    const Sort = sortParam(['dueDate', 'criticality']);
    expect(Sort.parse('dueDate,-criticality')).toEqual([
      { field: 'dueDate', direction: 'asc' },
      { field: 'criticality', direction: 'desc' },
    ]);
    const result = Sort.safeParse('dueDate,-owner');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Cannot sort by "owner"');
  });
});

describe('register query', () => {
  it('parses the filter language used by views, links and exports', () => {
    const query = RegisterQuery.parse({
      status: 'OVERDUE,DUE_SOON',
      ownerId: 'me',
      fy: '2022-23',
      hasEvidence: 'false',
      sort: '-dueDate',
      q: 'tds',
    });
    expect(query).toMatchObject({
      limit: 50,
      status: ['OVERDUE', 'DUE_SOON'],
      ownerId: 'me',
      hasEvidence: false,
      sort: [{ field: 'dueDate', direction: 'desc' }],
    });
  });

  it('rejects fy with dueFrom/dueTo, backwards ranges, unknown params and short searches', () => {
    expect(ok(RegisterQuery, { fy: '2022-23', dueFrom: '2022-04-01' })).toBe(false);
    expect(ok(RegisterQuery, { fy: '2022-23', dueTo: '2022-04-01' })).toBe(false);
    expect(ok(RegisterQuery, { dueFrom: '2022-05-01', dueTo: '2022-04-01' })).toBe(false);
    expect(ok(RegisterQuery, { completedFrom: '2022-05-01', completedTo: '2022-04-01' })).toBe(
      false,
    );
    expect(ok(RegisterQuery, { dueFrom: '2022-04-01', dueTo: '2022-04-01' })).toBe(true);
    expect(ok(RegisterQuery, { firmId: ID.firm })).toBe(false);
    expect(ok(RegisterQuery, { q: 'a' })).toBe(false);
    expect(ok(RegisterQuery, { sort: 'priority' })).toBe(false);
  });
});

describe('dashboard, calendar, audit and vault queries', () => {
  it('takes fy or from/to, not both, and forward ranges only', () => {
    expect(ok(DashboardQuery, { fy: '2022-23', unitId: ID.unit })).toBe(true);
    expect(ok(DashboardQuery, { fy: '2022-23', from: '2022-04-01' })).toBe(false);
    expect(ok(DashboardQuery, { from: '2022-05-01', to: '2022-04-01' })).toBe(false);
    expect(ok(BreakdownQuery, { by: 'department' })).toBe(true);
    expect(ok(BreakdownQuery, {})).toBe(false);
    expect(ok(CalendarQuery, { from: '2022-04-01', to: '2022-04-30' })).toBe(true);
    expect(ok(CalendarQuery, { from: '2022-04-30', to: '2022-04-01' })).toBe(false);
    expect(ok(AuditQuery, { from: '2026-10-11T00:00:00Z', to: '2026-10-10T00:00:00Z' })).toBe(
      false,
    );
    expect(ok(AuditQuery, { action: 'TRANSITION,REASSIGN', entityType: 'instance' })).toBe(true);
    // Instants compare by time, not as strings.
    expect(ok(AuditQuery, { from: '2026-10-11T09:17:43Z', to: '2026-10-11T09:17:43.500Z' })).toBe(
      true,
    );
    expect(ok(AuditQuery, { from: '2026-10-11T09:17:43.500Z', to: '2026-10-11T09:17:43Z' })).toBe(
      false,
    );
    expect(ok(EvidenceVaultQuery, { uploadedFrom: '2022-05-01', uploadedTo: '2022-04-01' })).toBe(
      false,
    );
    expect(ok(EvidenceVaultQuery, { scanStatus: 'CLEAN,PENDING' })).toBe(true);
  });
});

describe('workflow bodies', () => {
  it('needs version on every transition', () => {
    const submit = { version: 3, completedOn: '2022-05-06', comment: 'Filed on the portal.' };
    expect(ok(SubmitBody, submit)).toBe(true);
    expect(ok(SubmitBody, { ...submit, version: undefined })).toBe(false);
  });

  it('needs a comment to submit', () => {
    expect(ok(SubmitBody, { version: 3, completedOn: '2022-05-06' })).toBe(false);
    expect(ok(SubmitBody, { version: 3, completedOn: '2022-05-06', comment: '' })).toBe(false);
  });

  it('requires a reason for every instance change, and some change', () => {
    expect(ok(InstanceUpdateBody, { version: 1, ownerId: ID.owner, reason: 'Owner left' })).toBe(
      true,
    );
    expect(ok(InstanceUpdateBody, { version: 1, ownerId: ID.owner })).toBe(false);
    expect(ok(InstanceUpdateBody, { version: 1, dueDate: '2022-06-01' })).toBe(false);
    expect(ok(InstanceUpdateBody, { version: 1, dueDate: '2022-06-01', reason: 'Extension' })).toBe(
      true,
    );
    expect(ok(InstanceUpdateBody, { version: 1, reason: 'Nothing' })).toBe(false);
  });

  it('accepts only allowed evidence files up to 25 MB', () => {
    const upload = { fileName: 'challan.PDF', mimeType: 'application/pdf', sizeBytes: 1000 };
    expect(ok(EvidenceUploadUrlBody, upload)).toBe(true);
    expect(ok(EvidenceUploadUrlBody, { ...upload, fileName: 'run.exe' })).toBe(false);
    expect(ok(EvidenceUploadUrlBody, { ...upload, fileName: 'noextension' })).toBe(false);
    expect(ok(EvidenceUploadUrlBody, { ...upload, sizeBytes: MAX_EVIDENCE_BYTES + 1 })).toBe(false);
    expect(ok(EvidenceConfirmBody, { uploadId: ID.v5, fileName: 'a.zip', sha256: sha })).toBe(true);
  });
});

describe('entity bodies', () => {
  it('rejects updates that change nothing', () => {
    expect(ok(UnitUpdateBody, { version: 2 })).toBe(false);
    expect(ok(UnitUpdateBody, { version: 2, name: 'Plant 2' })).toBe(true);
    expect(ok(ObligationUpdateBody, { version: 2, criticality: 'LOW' })).toBe(true);
    expect(ok(ObligationUpdateBody, { version: 2 })).toBe(false);
  });

  it('fills create defaults', () => {
    expect(DepartmentCreateBody.parse({ name: 'Finance' })).toEqual({
      name: 'Finance',
      aliases: [],
    });
    expect(PersonCreateBody.parse({ displayName: 'Ravi Kumar' })).toEqual({
      displayName: 'Ravi Kumar',
      email: null,
      role: 'OWNER',
    });
    expect(ok(PersonCreateBody, { displayName: 'Ravi Kumar', role: 'APPROVER' })).toBe(true);
    expect(ok(PersonCreateBody, { displayName: 'Ravi Kumar', role: 'VIEWER' })).toBe(false);
    expect(ok(PersonCreateBody, { displayName: 'Ravi Kumar', role: 'CONSULTANT' })).toBe(false);
    expect(ActCreateBody.parse({ name: 'Income Tax Act, 1961', jurisdiction: 'CENTRAL' })).toEqual({
      name: 'Income Tax Act, 1961',
      shortName: null,
      jurisdiction: 'CENTRAL',
      stateCode: null,
      aliases: [],
    });
  });

  it('checks jurisdiction on Act and obligation create', () => {
    expect(ok(ActCreateBody, { name: 'Shops Act', jurisdiction: 'STATE' })).toBe(false);
    const body = Object.fromEntries(
      Object.entries(obligation).filter(([key]) => key in ObligationCreateBody.shape),
    );
    expect(ok(ObligationCreateBody, body)).toBe(true);
    expect(ok(ObligationCreateBody, { ...body, stateCode: 'WB' })).toBe(false);
  });

  it('takes settings or reminders on PUT settings, not both', () => {
    const { reminders } = DEFAULT_CLIENT_SETTINGS;
    expect(ok(ClientSettingsBody, { version: 1, reminders })).toBe(true);
    expect(ok(ClientSettingsBody, { version: 1, settings: DEFAULT_CLIENT_SETTINGS })).toBe(true);
    expect(
      ok(ClientSettingsBody, { version: 1, settings: DEFAULT_CLIENT_SETTINGS, reminders }),
    ).toBe(false);
    expect(ok(ClientSettingsBody, { version: 1 })).toBe(false);
  });

  it('checks assignment dates and bulk size', () => {
    const assignment = {
      unitId: ID.unit,
      obligationId: ID.obligation,
      departmentId: ID.department,
      defaultOwnerId: ID.owner,
      defaultApproverId: ID.approver,
      activeFrom: '2022-04-01',
    };
    expect(AssignmentCreateBody.parse(assignment).activeTo).toBeNull();
    expect(ok(AssignmentCreateBody, { ...assignment, activeTo: '2022-03-31' })).toBe(false);
    expect(ok(AssignmentBulkBody, { items: [] })).toBe(false);
    expect(ok(AssignmentBulkBody, { items: Array.from({ length: 201 }, () => assignment) })).toBe(
      false,
    );
  });

  it('previews rules over a forward range', () => {
    const rule = { kind: 'MONTHLY', day: 7, offsetMonths: 1 };
    const body = { rule, from: '2022-04-01', to: '2023-03-31', fyStartMonth: 4 };
    expect(ok(RulePreviewBody, body)).toBe(true);
    expect(ok(RulePreviewBody, { ...body, to: '2022-03-31' })).toBe(false);
  });
});

describe('auth bodies', () => {
  const owner = {
    role: 'OWNER',
    clientId: ID.client,
    consultantClientIds: null,
    unitIds: [ID.unit],
    expiresAt: null,
  };

  it('applies the membership shape rules to grants and invites', () => {
    expect(ok(MembershipGrant, owner)).toBe(true);
    expect(ok(MembershipGrant, { ...owner, role: 'VIEWER', unitIds: null })).toBe(false);
    const invite = { ...owner, email: 'ravi@example.com', personId: ID.owner };
    expect(ok(InviteBody, invite)).toBe(true);
    expect(ok(InviteBody, { ...invite, role: 'FIRM_ADMIN' })).toBe(false);
    expect(ok(InviteBody, { ...invite, displayName: 'Ravi Kumar' })).toBe(false);
    expect(ok(InviteBody, without(invite, 'personId'))).toBe(false);
  });

  const client = {
    id: ID.client,
    name: 'Kestrel Metals Group',
    fyStartMonth: 4,
    timeZone: 'Asia/Kolkata',
    unitCount: 1,
    period: {
      current: { fy: '2026-27', quarter: 3 },
      availableFys: ['2025-26', '2026-27'],
      availableUntil: '2027-03',
    },
  };

  it('gives each client its periods so the web app does no FY maths', () => {
    expect(ok(ClientSummary, client)).toBe(true);
    const period = (p: object) => ({ ...client, period: { ...client.period, ...p } });
    expect(ok(ClientSummary, period({ availableUntil: null }))).toBe(true);
    // A new client: nothing generated, only the current FY.
    expect(ok(ClientSummary, period({ availableFys: ['2026-27'], availableUntil: null }))).toBe(
      true,
    );
    expect(ok(ClientSummary, period({ availableFys: ['2025-26'] }))).toBe(false);
    expect(ok(ClientSummary, period({ availableFys: [] }))).toBe(false);
    expect(ok(ClientSummary, period({ availableUntil: '2027-13' }))).toBe(false);
    expect(ok(ClientSummary, period({ current: { fy: '2026-27', quarter: 5 } }))).toBe(false);
    expect(ok(ClientSummary, { ...client, unitCount: -1 })).toBe(false);
    expect(ok(ClientSummary, without(client, 'timeZone'))).toBe(false);
  });

  it('describes the signed-in person for GET /me', () => {
    const me = {
      person: { ...person, email: 'ravi@example.com', status: 'ACTIVE' },
      memberships: [membership],
      clients: [client],
      csrfToken: 'c'.repeat(32),
      mfa: { required: false, enrolled: false, satisfied: false },
    };
    expect(ok(Me, me)).toBe(true);
    expect(ok(Me, without(me, 'csrfToken'))).toBe(false);
    expect(ok(Me, { ...me, session: { expiresAt: '2024-11-15T18:30:00Z' } })).toBe(true);
    expect(ok(Me, { ...me, session: {} })).toBe(false);
  });

  it('applies the password policy when a password is set, not at login', () => {
    const login = { email: 'ravi@example.com', password: 'x' };
    expect(ok(LoginBody, login)).toBe(true);
    expect(ok(LoginBody, { ...login, firmId: person.id })).toBe(true);
    expect(ok(LoginBody, { ...login, password: '' })).toBe(false);
    expect(ok(LoginBody, { ...login, password: 'x'.repeat(1025) })).toBe(false);
    expect(ok(LoginBody, { ...login, firmId: 'acme' })).toBe(false);
    expect(ok(InviteAcceptBody, { password: 'x' })).toBe(false);
  });
});

describe('import bodies', () => {
  it('accepts Excel workbooks up to 20 MB', () => {
    expect(ok(ImportCreateBody, { fileName: 'register.xlsx', sizeBytes: 1000 })).toBe(true);
    expect(ok(ImportCreateBody, { fileName: 'register.csv', sizeBytes: 1000 })).toBe(false);
    expect(ok(ImportCreateBody, { fileName: 'r.xls', sizeBytes: MAX_IMPORT_BYTES + 1 })).toBe(
      false,
    );
  });

  it('sends editedValue exactly with EDITED, and never decides PENDING', () => {
    expect(ok(ImportIssueDecisionBody, { decision: 'ACCEPTED' })).toBe(true);
    expect(ok(ImportIssueDecisionBody, { decision: 'EDITED', editedValue: 'HR' })).toBe(true);
    expect(ok(ImportIssueDecisionBody, { decision: 'EDITED' })).toBe(false);
    expect(ok(ImportIssueDecisionBody, { decision: 'ACCEPTED', editedValue: 'HR' })).toBe(false);
    expect(ok(ImportIssueDecisionBody, { decision: 'PENDING' })).toBe(false);
  });

  it('defaults export filters to the whole register', () => {
    expect(ExportCreateBody.parse({ kind: 'REGISTER_XLSX' }).filters).toBe('');
  });

  it('validates export filters as a register query without paging', () => {
    const body = { kind: 'REGISTER_XLSX' };
    expect(
      ok(ExportCreateBody, { ...body, filters: 'status=OVERDUE,DUE_SOON&sort=-dueDate' }),
    ).toBe(true);
    expect(ok(ExportCreateBody, { ...body, filters: 'status=LATE_ISH' })).toBe(false);
    expect(ok(ExportCreateBody, { ...body, filters: 'sort=colour' })).toBe(false);
    expect(ok(ExportCreateBody, { ...body, filters: 'limit=10' })).toBe(false);
    const result = ExportCreateBody.safeParse({ ...body, filters: 'status=LATE_ISH' });
    expect(result.error?.issues[0]?.path).toEqual(['filters', 'status', 0]);
  });
});

describe('responses', () => {
  it('pages carry nextCursor and an optional total', () => {
    const Page = page(InstanceRow);
    expect(ok(Page, { items: [instanceRow], nextCursor: null })).toBe(true);
    expect(ok(Page, { items: [instanceRow], nextCursor: 'abc', total: 1 })).toBe(true);
    expect(ok(Page, { items: [instanceRow] })).toBe(false);
  });

  it('bulk results report each item', () => {
    const Results = bulkResults(InstanceRow);
    expect(
      ok(Results, {
        results: [
          { id: ID.instance, ok: true, item: instanceRow },
          { id: ID.v5, ok: false, error: { code: 'STALE_VERSION', message: 'Changed' } },
        ],
      }),
    ).toBe(true);
  });

  it('has a details shape (or none) for every error code', () => {
    expect(Object.keys(ERROR_DETAILS).sort()).toEqual([...ErrorCode.options].sort());
    const stale = {
      error: { code: 'STALE_VERSION', message: 'Changed', details: { currentVersion: 4 } },
      requestId: 'req-1',
    };
    expect(ok(ApiErrorResponse, stale)).toBe(true);
    expect(
      ok(ApiErrorResponse, { ...stale, error: { ...stale.error, details: { version: 4 } } }),
    ).toBe(false);
    expect(
      ok(ApiErrorResponse, {
        error: { code: 'NOT_FOUND', message: 'Not found', details: { id: ID.client } },
        requestId: 'req-2',
      }),
    ).toBe(false);
  });
});
