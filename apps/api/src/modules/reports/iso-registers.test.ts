import { randomUUID } from 'node:crypto';
import {
  AspectControlType,
  ControlHierarchy,
  DEFAULT_FIRM_SETTINGS,
  ExportJob,
  IncidentOutcome,
  IncidentType,
  IsoStandardCode,
  IsoTiming,
  LifeCycleStage,
  NcDisposition,
  NcSeverity,
  NcSource,
  NcState,
  OperatingCondition,
  PersonsExposed,
  RiskKind,
  RootCauseMethod,
  type RequestContext,
} from '@canopy/contracts';
import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorld } from '../dashboard/testing/world.js';
import {
  filterWords,
  NC_LOG_HEADERS,
  RISK_REGISTER_HEADERS,
  significanceCriteria,
} from './iso-registers.js';
import { codeWords, controlHierarchyWords, STANDARD_WORDS, yesNo } from './iso-words.js';
import { addIsoRecords } from './testing/iso-records.js';

/**
 * ISO-11d part 1 (docs/iso/model.md §9): the NC log and the risk register as Excel, through the export route and the
 * worker on the memory store. The list filters, the requester's unit scope (plan §3.3) and the documented
 * significance criteria; the same reads on Postgres are in iso.db.test.ts.
 */

const w = createWorld();
const iso = addIsoRecords(w);
afterAll(() => w.app.close());
beforeEach(() => {
  w.setIso(true);
  w.store.firms.delete(w.firmId);
});

const admin = () => w.as('FIRM_ADMIN').headers;
type Cell = string | number | null;

async function startExport(headers: Record<string, string>, payload: Record<string, unknown>) {
  return w.app.inject({
    method: 'POST',
    url: `/api/v1/clients/${w.clientId}/exports`,
    headers,
    payload,
  });
}

/** The finished workbook's sheet: the lines above the header row, the header and the rows under it. */
async function exported(
  kind: 'ISO_NC_LOG_XLSX' | 'ISO_RISK_REGISTER_XLSX',
  filters = '',
  headers = admin(),
): Promise<{ above: string[]; header: string[]; rows: Cell[][]; fileName: string }> {
  const res = await startExport(headers, { kind, filters });
  expect(res.statusCode).toBe(202);
  const job = ExportJob.parse(res.json());
  await w.runner.idle();
  const ctx = { firmId: w.firmId } as RequestContext;
  const done = await w.store.getExportJob(ctx, job.id);
  expect(done?.status).toBe('DONE');
  const bytes = w.files.files.get((await w.store.exportStorageKey(ctx, job.id))!)!.bytes;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const lines: Cell[][] = [];
  workbook.worksheets[0]!.eachRow({ includeEmpty: true }, (row) => {
    lines.push(Array.from((row.values as Cell[]).slice(1), (v) => v ?? null));
  });
  const first = kind === 'ISO_NC_LOG_XLSX' ? NC_LOG_HEADERS[0] : RISK_REGISTER_HEADERS[0];
  const at = lines.findIndex((line) => line[0] === first);
  return {
    above: lines.slice(0, at).map((line) => String(line[0] ?? '')),
    header: lines[at]!.map(String),
    // Pad each row to the header: the workbook leaves trailing empty cells out.
    rows: lines
      .slice(at + 1)
      .map((line) => Array.from({ length: lines[at]!.length }, (_, i) => line[i] ?? null)),
    fileName: done!.fileName!,
  };
}

const column = <H extends readonly string[]>(headers: H, name: H[number]) => headers.indexOf(name);
const nc = (name: (typeof NC_LOG_HEADERS)[number]) => column(NC_LOG_HEADERS, name);
const risk = (name: (typeof RISK_REGISTER_HEADERS)[number]) => column(RISK_REGISTER_HEADERS, name);
const numbers = (rows: Cell[][]) => rows.map((r) => r[0]);

describe('the NC log', () => {
  it('lists the live NCs newest first, with their words, timing and incident fields', async () => {
    const { above, header, rows, fileName } = await exported('ISO_NC_LOG_XLSX');
    expect(header).toEqual([...NC_LOG_HEADERS]);
    expect(fileName).toBe('nc-log-2026-10-12.xlsx');
    expect(above).toEqual([
      'PlanetPulse Compliance · Nonconformity log',
      'Beta Group',
      'Status as at 2026-10-12',
      'Filters: none',
      '',
    ]);
    // Reported 2026-10-01, 2026-09-15 and 2026-08-01; number 4 is archived.
    expect(numbers(rows)).toEqual([3, 1, 2]);
    const [incident, gauge, complaint] = rows;
    expect(gauge![nc('Management system')]).toBe('Plant system');
    expect(gauge![nc('Standards')]).toBe('ISO 9001');
    expect(gauge![nc('Clauses')]).toBe('ISO 9001 8.7');
    expect(gauge![nc('Unit')]).toBe('Plant');
    expect(gauge![nc('State')]).toBe('Root cause found');
    // Due 2026-10-01 with its only action done: overdue 11 days on 2026-10-12.
    expect(gauge![nc('Timing')]).toBe('Overdue');
    expect(gauge![nc('Days overdue')]).toBe(11);
    expect(gauge![nc('Open actions')]).toBe(0);
    expect(gauge![nc('Root cause method')]).toBe('Five whys');
    expect(gauge![nc('Reported by')]).toBe('Person Approver');
    expect(gauge![nc('Owner')]).toBe('Person Owner');
    expect(gauge![nc('Incident type')]).toBeNull();
    // Its own due date is 2026-11-30, but its open action was due 2026-10-05.
    expect(incident![nc('Timing')]).toBe('Overdue');
    expect(incident![nc('Days overdue')]).toBe(7);
    expect(incident![nc('Open actions')]).toBe(1);
    expect(incident![nc('Owner')]).toBe('Office Owner');
    expect(incident!.slice(nc('Incident type'))).toEqual([
      'Injury',
      // 20:00 UTC on 30 September is 1 October in Kolkata.
      '2026-10-01',
      'Casthouse bay 2',
      'Lost time',
      4,
      'Yes',
    ]);
    expect(complaint![nc('Severity')]).toBe('Major');
    expect(complaint![nc('Timing')]).toBe('Closed');
    expect(complaint![nc('Days overdue')]).toBeNull();
    expect(complaint![nc('Disposition')]).toBe('Return or suspension');
    expect(complaint![nc('Disposition authorised by')]).toBe('Person Approver');
    expect(complaint![nc('Effective')]).toBe('Yes');
    expect(complaint![nc('Closed on')]).toBe('2026-08-20');
  });

  it('never prints the injured person category', async () => {
    const { header, rows } = await exported('ISO_NC_LOG_XLSX');
    expect(header.join(' ')).not.toMatch(/person|category/i);
    expect(JSON.stringify(rows)).not.toMatch(/contract worker|CONTRACT_WORKER/i);
  });

  it('applies each list filter, in the store and after the read', async () => {
    const plant = iso.plantSystem;
    const cases: [string, number[]][] = [
      ['incident=true', [3]],
      ['incident=false', [1, 2]],
      ['overdue=true', [3, 1]],
      ['overdue=false', [2]],
      ['q=roller', [3]],
      ['q=WRONG grade', [2]],
      ['q=calibration schedule', [1]],
      ['q=nothing like it', []],
      ['state=CLOSED', [2]],
      ['severity=MAJOR', [2]],
      ['source=INCIDENT,COMPLAINT', [3, 2]],
      ['standard=ISO_45001', [3]],
      [`managementSystemId=${plant}`, [1]],
      [`unitId=${w.unit2}`, [3, 2]],
      [`ownerId=${iso.otherOwnerId}`, [3, 2]],
      [`approverId=${w.approverId}`, [3, 1, 2]],
    ];
    for (const [filters, expected] of cases) {
      const { rows } = await exported('ISO_NC_LOG_XLSX', filters);
      expect(numbers(rows), filters).toEqual(expected);
    }
  });

  it('reads ownerId=me as the requester and says so in the heading', async () => {
    const headers = w.as('CLIENT_ADMIN', {}, w.ownerId).headers;
    const { above, rows } = await exported('ISO_NC_LOG_XLSX', 'ownerId=me&incident=false', headers);
    expect(numbers(rows)).toEqual([1]);
    expect(above).toContain('Filters: Owner: you; Incidents: No');
  });

  it("keeps an approver limited to Plant to Plant's NCs, and those naming them", async () => {
    const limited = await exported(
      'ISO_NC_LOG_XLSX',
      '',
      w.as('APPROVER', { unitIds: [w.unit1] }).headers,
    );
    expect(numbers(limited.rows)).toEqual([1]);
    expect(limited.above).toContain('Only the records of your units and those naming you');
    const investigator = await exported(
      'ISO_NC_LOG_XLSX',
      '',
      w.as('APPROVER', { unitIds: [w.unit1] }, iso.investigatorId).headers,
    );
    expect(numbers(investigator.rows)).toEqual([3, 1]);
    const wide = await exported('ISO_NC_LOG_XLSX', '', w.as('APPROVER').headers);
    expect(numbers(wide.rows)).toEqual([3, 1, 2]);
    expect(wide.above).not.toContain('Only the records of your units and those naming you');
  });
});

describe('the risk register', () => {
  const firstColumn = (rows: Cell[][]) => rows.map((r) => r[risk('Activity')]);

  it('prints the documented significance criteria and the items, highest rating first', async () => {
    const { above, header, rows, fileName } = await exported('ISO_RISK_REGISTER_XLSX');
    expect(header).toEqual([...RISK_REGISTER_HEADERS]);
    expect(fileName).toBe('risk-register-2026-10-12.xlsx');
    expect(above[0]).toBe('PlanetPulse Compliance · Risk register');
    expect(above).toContain(significanceCriteria(DEFAULT_FIRM_SETTINGS.isoRisk));
    expect(above.join('\n')).toContain(
      'is 12 or more, or when it is linked to a statutory obligation',
    );
    // Ratings 16, 9 and 6; the archived opportunity (20) is left out.
    expect(firstColumn(rows)).toEqual(['Degreasing', 'Casting', 'Roller line']);
    const [aspect, plain, hazard] = rows;
    expect(aspect!.slice(risk('Kind'), risk('Condition') + 1)).toEqual([
      'Aspect',
      'Plant',
      'Degreasing',
      'Solvent vapour',
      'Air emissions',
      'Production, End of life',
      'Control',
      '',
      '',
      'Normal',
    ]);
    expect(aspect![risk('Significant')]).toBe('Yes');
    expect(aspect![risk('Climate related')]).toBe('Yes');
    // Review due 2026-10-10, before 2026-10-12.
    expect(aspect![risk('Review timing')]).toBe('Overdue');
    expect(aspect![risk('Controls in place')]).toBe('Extraction hood');
    expect(plain![risk('Unit')]).toBe('The whole system');
    expect(plain![risk('Significance override')]).toBe('Set not significant');
    expect(plain![risk('Override reason')]).toBe('Second supplier qualified');
    expect(plain![risk('Review timing')]).toBe('On time');
    expect(plain![risk('Last reviewed on')]).toBe('2026-09-01');
    expect(hazard![risk('Persons exposed')]).toBe('Worker, Contractor');
    expect(hazard![risk('Routine')]).toBe('Yes');
    expect(hazard![risk('Assessed with')]).toBe('Line crew');
    expect(hazard!.slice(risk('Likelihood'), risk('Residual rating') + 1)).toEqual([
      2, 3, 6, 1, 3, 3,
    ]);
    expect(hazard![risk('Statutory obligations')]).toBe('Report an accident');
    expect(hazard![risk('Controls in place')]).toBe('Two-hand start (Engineering); Gloves (PPE)');
    expect(hazard![risk('Open treatment actions')]).toBe(1);
    expect(hazard![risk('Owner')]).toBe('Office Owner');
    expect(hazard![risk('Archived on')]).toBeNull();
  });

  it("prints the account's own rule", async () => {
    w.store.firms.set(w.firmId, {
      ...DEFAULT_FIRM_SETTINGS,
      isoRisk: { significantAt: 16, legalLinkMakesSignificant: false },
    });
    const { above } = await exported('ISO_RISK_REGISTER_XLSX');
    const criteria = above.find((line) => line.startsWith('Significance criteria'))!;
    expect(criteria).toContain('is 16 or more.');
    expect(criteria).not.toContain('statutory obligation');
  });

  it('applies each list filter', async () => {
    const cases: [string, string[]][] = [
      ['kind=HAZARD', ['Roller line']],
      ['kind=ASPECT,RISK', ['Degreasing', 'Casting']],
      ['significant=true', ['Degreasing', 'Roller line']],
      ['climateRelated=true', ['Degreasing']],
      ['q=crush', ['Roller line']],
      ['q=solvent', ['Degreasing']],
      [`managementSystemId=${iso.officeSystem}`, ['Roller line']],
      [`unitId=${w.unit1}`, ['Degreasing']],
      [`ownerId=${iso.otherOwnerId}`, ['Roller line']],
      ['includeArchived=true', ['Casting', 'Degreasing', 'Casting', 'Roller line']],
    ];
    for (const [filters, expected] of cases) {
      const { rows } = await exported('ISO_RISK_REGISTER_XLSX', filters);
      expect(firstColumn(rows), filters).toEqual(expected);
    }
  });

  it('gives an archived item its archive day and no review timing', async () => {
    const { rows } = await exported('ISO_RISK_REGISTER_XLSX', 'includeArchived=true');
    expect(rows[0]![risk('Kind')]).toBe('Opportunity');
    // 20:00 UTC on 30 September is 1 October in Kolkata.
    expect(rows[0]![risk('Archived on')]).toBe('2026-10-01');
    expect(rows[0]![risk('Review timing')]).toBe('');
  });

  it("keeps an approver limited to Plant to Plant's items and the system-wide ones", async () => {
    const { rows } = await exported(
      'ISO_RISK_REGISTER_XLSX',
      '',
      w.as('APPROVER', { unitIds: [w.unit1] }).headers,
    );
    expect(firstColumn(rows)).toEqual(['Degreasing', 'Casting']);
    const owner = await exported(
      'ISO_RISK_REGISTER_XLSX',
      '',
      w.as('APPROVER', { unitIds: [w.unit1] }, iso.otherOwnerId).headers,
    );
    expect(firstColumn(owner.rows)).toEqual(['Degreasing', 'Casting', 'Roller line']);
  });
});

describe('creating an ISO export', () => {
  it('refuses unitId and fy: the list filters carry the units', async () => {
    for (const extra of [{ unitId: w.unit1 }, { fy: '2026-27' }]) {
      const res = await startExport(admin(), { kind: 'ISO_NC_LOG_XLSX', filters: '', ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });

  it("refuses the register's filters, which are not the list's", async () => {
    const res = await startExport(admin(), {
      kind: 'ISO_RISK_REGISTER_XLSX',
      filters: 'workflowState=OPEN',
    });
    expect(res.statusCode).toBe(400);
  });

  it('answers the same job for a repeated Idempotency-Key', async () => {
    const headers = { ...admin(), 'idempotency-key': randomUUID() };
    const first = await startExport(headers, { kind: 'ISO_NC_LOG_XLSX', filters: 'overdue=true' });
    const again = await startExport(headers, { kind: 'ISO_NC_LOG_XLSX', filters: 'overdue=true' });
    expect(again.json().id).toBe(first.json().id);
    await w.runner.idle();
  });

  it('lets a viewer export the NC log, as the list', async () => {
    const { rows } = await exported('ISO_NC_LOG_XLSX', '', w.as('VIEWER').headers);
    expect(numbers(rows)).toEqual([3, 1, 2]);
  });
});

describe('words', () => {
  const printed = [
    NcSource,
    NcSeverity,
    NcState,
    NcDisposition,
    RootCauseMethod,
    IncidentType,
    IncidentOutcome,
    IsoTiming,
    RiskKind,
    LifeCycleStage,
    AspectControlType,
    PersonsExposed,
    OperatingCondition,
  ];

  it('gives every printed code words, never the code', () => {
    for (const values of printed) {
      for (const value of values.options) {
        const words = codeWords(value);
        expect(words).not.toBe(value);
        expect(words).toMatch(/^[A-Z][a-z0-9 ]*$/);
      }
    }
    expect(codeWords('ROOT_CAUSE_FOUND')).toBe('Root cause found');
    expect(codeWords('END_OF_LIFE')).toBe('End of life');
  });

  it('keeps the exceptions of model §4.7', () => {
    for (const value of ControlHierarchy.options) {
      expect(controlHierarchyWords(value)).toBe(value === 'PPE' ? 'PPE' : codeWords(value));
    }
    for (const code of IsoStandardCode.options) {
      expect(STANDARD_WORDS[code]).toMatch(/^ISO \d+$/);
    }
  });

  it('prints yes, no and nothing', () => {
    expect([yesNo(true), yesNo(false), yesNo(null)]).toEqual(['Yes', 'No', '']);
  });

  it('words the filters, falling back to the id for a name it does not hold', () => {
    const unknown = randomUUID();
    const names = w.store.iso.names;
    expect(
      filterWords(
        {
          managementSystemId: [iso.plantSystem, unknown],
          unitId: [w.unit2],
          state: ['ROOT_CAUSE_FOUND'],
          standard: ['ISO_14001'],
          ownerId: w.approverId,
          approverId: 'me',
          significant: false,
          q: 'roller',
          limit: 5,
        },
        names,
      ),
    ).toEqual([
      `System: Plant system, ${unknown}`,
      'Unit: Head Office',
      'State: Root cause found',
      'Standard: ISO 14001',
      'Owner: Person Approver',
      'Approver: you',
      'Significant: No',
      'Search: "roller"',
    ]);
  });
});
