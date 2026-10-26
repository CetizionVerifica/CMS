// Mock handlers for every ISO endpoint (ISO_ENDPOINTS, docs/contracts/endpoints.md §10), one file per area.
import { systemsHandlers } from './systems.js';
import { documentsHandlers } from './documents.js';
import { risksHandlers } from './risks.js';
import { auditsHandlers } from './audits.js';
import { certificationsHandlers } from './certifications.js';
import { nonconformitiesHandlers } from './nonconformities.js';
import { reviewsHandlers } from './reviews.js';

export { storeFixtureFigures } from './reviews.js';

export const isoHandlers = {
  ...systemsHandlers,
  ...documentsHandlers,
  ...risksHandlers,
  ...auditsHandlers,
  ...certificationsHandlers,
  ...nonconformitiesHandlers,
  ...reviewsHandlers,
};
