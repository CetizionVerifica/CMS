// The demo client's ISO records for component tests (see iso-data.ts for where they come from).
import json from './iso-data.json';
import type { IsoData } from './iso-data';

export const ISO = json as unknown as IsoData;
