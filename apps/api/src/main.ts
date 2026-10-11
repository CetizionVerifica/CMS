import { buildServer } from './server.js';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '0.0.0.0';

const app = buildServer();
await app.listen({ port, host });
