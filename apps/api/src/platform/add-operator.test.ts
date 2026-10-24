import { afterEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('./db-operators.js', () => ({ runAddOperator: run }));

afterEach(() => {
  vi.resetModules();
  process.exitCode = undefined;
});

describe('the add-operator command', () => {
  it('passes the arguments and environment on, and prints what it is told', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    run.mockImplementation(
      async (argv: string[], env: NodeJS.ProcessEnv, io: { out: (line: string) => void }) => {
        expect(Array.isArray(argv)).toBe(true);
        expect(env).toBe(process.env);
        io.out('Operator created');
      },
    );
    await import('./add-operator.js');
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('Operator created\n'));
    expect(process.exitCode).toBeUndefined();
    write.mockRestore();
  });

  it('prints the error and exits non-zero when it fails', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    run.mockRejectedValueOnce(new Error('OPERATOR_DATABASE_URL is required'));
    await import('./add-operator.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(write).toHaveBeenCalledWith('OPERATOR_DATABASE_URL is required\n');
    run.mockRejectedValueOnce('plain failure');
    vi.resetModules();
    process.exitCode = undefined;
    await import('./add-operator.js');
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('plain failure\n'));
    write.mockRestore();
  });
});
