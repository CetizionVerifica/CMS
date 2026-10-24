import { describe, expect, it } from 'vitest';
import { checkMasterLibrary, MASTER_LIBRARY } from './master.js';
import { SAMPLE_MASTER } from './testing/sample-master.js';

describe('the master library', () => {
  it('ships a library whose references hold', () => {
    expect(() => checkMasterLibrary(MASTER_LIBRARY)).not.toThrow();
    expect(() => checkMasterLibrary(SAMPLE_MASTER)).not.toThrow();
  });

  it('refuses a repeated key', () => {
    const act = SAMPLE_MASTER.acts[0]!;
    expect(() => checkMasterLibrary({ ...SAMPLE_MASTER, acts: [act, act] })).toThrow(
      'Act key "factories" is repeated',
    );
  });

  it('refuses an obligation naming an Act or category that is not there', () => {
    const [first] = SAMPLE_MASTER.obligations;
    expect(() =>
      checkMasterLibrary({ ...SAMPLE_MASTER, obligations: [{ ...first!, act: 'mines' }] }),
    ).toThrow('obligation 0 names unknown Act "mines"');
    expect(() =>
      checkMasterLibrary({ ...SAMPLE_MASTER, obligations: [{ ...first!, category: 'audits' }] }),
    ).toThrow('obligation 0 names unknown category "audits"');
  });
});
