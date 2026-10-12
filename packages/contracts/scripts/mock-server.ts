// Starts the mock API on http://localhost:4010/api/v1 (MOCK_PORT, MOCK_HOST and MOCK_TODAY override).
import { createMockServer } from '../src/mock/index.js';

const port = Number(process.env.MOCK_PORT ?? 4010);
const host = process.env.MOCK_HOST ?? '127.0.0.1';
const today = process.env.MOCK_TODAY;
const app = createMockServer(today === undefined ? {} : { today });

await app.listen({ port, host });
console.log(
  `Mock API on http://${host}:${port}/api/v1${today === undefined ? '' : ` (today = ${today})`}`,
);
