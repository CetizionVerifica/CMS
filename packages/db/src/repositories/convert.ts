/** Contract Instant strings (ISO 8601) become Date for the named timestamptz columns. */
export function instantsToDates(...keys: string[]) {
  return (input: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...input };
    for (const key of keys) {
      const value = out[key];
      if (typeof value === 'string') out[key] = new Date(value);
    }
    return out;
  };
}
