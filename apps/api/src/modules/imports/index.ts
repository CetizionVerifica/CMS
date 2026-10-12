import type { FastifyInstance } from 'fastify';
import { importRoutes } from './routes.js';
import { ImportSteps, type ImportStepsOptions } from './steps.js';

// M8 · imports (docs/contracts/endpoints.md §5). `buildServer` mounts these under /api/v1 when given options.
export type ImportOptions = ImportStepsOptions;
export { repositoryStore } from './service.js';
export {
  MemoryImportFiles,
  s3ImportFiles,
  s3ImportFilesFromEnv,
  type ImportFiles,
} from './files.js';
export { ImportSteps } from './steps.js';

export function imports(app: FastifyInstance, options: ImportOptions): void {
  importRoutes(app, new ImportSteps(options));
}
