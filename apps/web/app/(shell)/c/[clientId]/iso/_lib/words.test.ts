import * as contracts from '@canopy/contracts';
import { describe, expect, it } from 'vitest';

import { sentence, standardTitle, standardTitleByCode, timingWords, word, WORDS } from './words';

describe('ISO words (model §4.7)', () => {
  it('has words for every value of every contracts enum it maps, never the code itself', () => {
    for (const [name, map] of Object.entries(WORDS)) {
      const schema = (contracts as unknown as Record<string, { options: readonly string[] }>)[name];
      expect(schema?.options, name).toBeDefined();
      expect(Object.keys(map).sort(), name).toEqual([...schema!.options].sort());
      for (const [code, words] of Object.entries(map)) {
        expect(words, `${name}.${code}`).not.toMatch(/_/);
        if (code.length > 3) expect(words, `${name}.${code}`).not.toBe(code);
      }
    }
  });

  it('follows the rule, and the named exceptions only in their own enum', () => {
    expect(word('NcState', 'ROOT_CAUSE_FOUND')).toBe('Root cause found');
    expect(word('RevisionState', 'IN_REVIEW')).toBe('In review');
    expect(word('ExternalAuditType', 'STAGE_1')).toBe('Stage 1');
    expect(word('ClauseNaState', 'APPROVED')).toBe('Not applicable approved');
    expect(word('ClauseNaState', 'NONE')).toBe('No request');
    expect(word('ClauseNaState', 'REJECTED')).toBe('Not applicable refused');
    expect(word('RevisionState', 'APPROVED')).toBe('Approved');
    expect(word('IncidentOutcome', 'NONE')).toBe('None');
    expect(word('FindingType', 'OFI')).toBe('Opportunity for improvement');
    expect(word('FindingType', 'MAJOR_NC')).toBe('Major nonconformity');
    expect(word('ControlHierarchy', 'PPE')).toBe('PPE');
    expect(word('IsoActionSubjectType', 'RISK_ITEM')).toBe('Treatment action');
    expect(word('IsoStandardCode', 'ISO_45001')).toBe('ISO 45001');
    expect(sentence('NOT_APPLICABLE')).toBe('Not applicable');
  });

  it('names a standard as the catalogue does', () => {
    const standards = [{ id: 's1', code: 'ISO_9001' as const, title: 'ISO 9001' }];
    expect(standardTitle(standards, 's1')).toBe('ISO 9001');
    expect(standardTitle(standards, 'x')).toBe('Unknown standard');
    expect(standardTitleByCode(standards, 'ISO_14001')).toBe('ISO 14001');
  });

  it('words a due status', () => {
    expect(timingWords({ timing: 'OVERDUE', overdueDays: 1 })).toBe('Overdue 1 day');
    expect(timingWords({ timing: 'OVERDUE', overdueDays: 4 })).toBe('Overdue 4 days');
    expect(timingWords({ timing: 'DUE_SOON', overdueDays: null })).toBe('Due soon');
    expect(timingWords({ timing: 'ON_TIME', overdueDays: null })).toBe('On time');
  });
});
