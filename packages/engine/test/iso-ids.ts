// Readable names for the UUIDs ISO results must carry: u('cert') is always the same id.
const known = new Map<string, string>();

export function u(name: string): string {
  let id = known.get(name);
  if (id === undefined) {
    id = `01900000-0000-7000-8000-${String(known.size + 1).padStart(12, '0')}`;
    known.set(name, id);
  }
  return id;
}
