// Firm B's ISO add-on data (docs/contracts/fixtures.md §8): Northwind Foods Group's integrated management system.
// The catalogue rows, STANDARD acts and obligations come from `isoCatalogueRows`; this file holds the client's records.
import type { z } from 'zod';
import type { IsoFixtureSet } from '../../src/fixtures/schema.js';
import { fixtureId } from '../../src/fixtures/index.js';

type Fixture = z.input<typeof IsoFixtureSet>;

/** Firm B (Second Ledger Consulting). */
export const FIRM_B_ID = fixtureId('firm-b');

export function buildFirmBIso(): Fixture {
  return {
    source: 'synthetic: Northwind Foods Group ISO 9001, 14001 and 45001 (fictional)',
    firmId: FIRM_B_ID,
    catalogueCopiedAt: '2024-04-02T04:30:00Z',
    assignments: [],
    instances: [],
    evidence: [],
    managementSystems: [],
    contextItems: [],
    clauseAssessments: [],
    documents: [],
    revisions: [],
    riskItems: [],
    riskControls: [],
    objectives: [],
    readings: [],
    auditProgrammes: [],
    internalAudits: [],
    auditChecklistItems: [],
    certifications: [],
    externalAudits: [],
    findings: [],
    nonconformities: [],
    actions: [],
    managementReviews: [],
    reviewInputs: [],
    reviewOutputs: [],
    files: [],
  };
}
