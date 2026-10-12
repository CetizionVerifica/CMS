import type { EvidenceStorage, StoredObject } from '../storage.js';

/** In-memory storage for tests: `put` stands in for the client's PUT to the presigned URL. */
export function createMemoryStorage() {
  const objects = new Map<string, StoredObject>();
  const storage: EvidenceStorage = {
    async presignPut(key, file) {
      return {
        url: `https://storage.test/put/${encodeURIComponent(key)}?expires=300`,
        headers: { 'Content-Type': file.mimeType, 'Content-Length': String(file.sizeBytes) },
      };
    },
    async head(key) {
      return objects.get(key) ?? null;
    },
    async presignGet(key) {
      return `https://storage.test/get/${encodeURIComponent(key)}?expires=300`;
    },
  };
  return {
    storage,
    put(key: string, object: StoredObject) {
      objects.set(key, object);
    },
    keys: () => [...objects.keys()],
  };
}
