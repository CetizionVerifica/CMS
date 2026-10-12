import type { ClientSummary } from '../src';

// Demo data only. Names are invented sample organisations.
export const demoClients: ClientSummary[] = [
  { id: 'hb', name: 'Kestrel Aluminium Riverbend', meta: 'Metals · 3 units', overdueCount: 12 },
  { id: 'tp', name: 'Taloja Plastics', meta: 'Chemicals · 1 unit', overdueCount: 0 },
  { id: 'ak', name: 'Aarav Knitwear', meta: 'Textiles · 2 units', overdueCount: 3 },
  { id: 'mb', name: 'Mahim Bakers', meta: 'Food · 1 unit', overdueCount: 1 },
  { id: 'sc', name: 'Sahyadri Cements', meta: 'Cement · 4 units', overdueCount: 140 },
  { id: 'nl', name: 'Nashik Logistics', meta: 'Warehousing · 6 units', overdueCount: 0 },
  {
    id: 'long',
    name: 'Kestrel Aluminium Limited, Riverbend Aluminium Rolling Plant',
    meta: 'Metals · 1 unit',
    overdueCount: 7,
  },
];

export const demoFys = ['2021-22', '2022-23', '2023-24'];
