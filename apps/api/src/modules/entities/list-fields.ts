/**
 * The only fields a list may sort or search on, per table (M3's #30 audit). M3's repositories accept any contract
 * field, so both stores check every list against this table before it reaches the database: a route asking for
 * another field is a programming error, not a client error, and fails loudly.
 */
export const LIST_FIELDS = {
  clients: { sort: ['name'], search: ['name'] },
  companies: { sort: ['name'], search: ['name'] },
  units: { sort: ['name'], search: ['name'] },
  locations: { sort: ['country'], search: ['country', 'state', 'city'] },
  departments: { sort: ['name'], search: ['name'] },
  people: { sort: ['nameNormalized'], search: ['displayName', 'email'] },
  memberships: { sort: [], search: [] },
  acts: { sort: ['name'], search: ['name', 'shortName'] },
  categories: { sort: ['name'], search: ['name'] },
  obligations: { sort: ['title'], search: ['title', 'externalRef'] },
  assignments: { sort: ['id'], search: [] },
} as const satisfies Record<string, { sort: readonly string[]; search: readonly string[] }>;

export type ListTable = keyof typeof LIST_FIELDS;

/** Throws when `query` sorts or searches on a field outside the table's allow-list. */
export function checkListFields(
  table: ListTable,
  query: { orderBy: string; search?: { fields: readonly string[] } | undefined },
): void {
  const allowed = LIST_FIELDS[table];
  const sort: readonly string[] = allowed.sort;
  const search: readonly string[] = allowed.search;
  if (!sort.includes(query.orderBy)) {
    throw new Error(`${table} cannot be sorted by ${query.orderBy}`);
  }
  for (const field of query.search?.fields ?? []) {
    if (!search.includes(field)) throw new Error(`${table} cannot be searched on ${field}`);
  }
}
