'use client';
// Files on their way to an instance, as FileDrop shows them. Once the API confirms a file it leaves this list and
// joins the instance's evidence (`onConfirmed`).
import type { EvidenceView } from '@canopy/contracts';
import { toast, type UploadItem } from '@canopy/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { UploadAborted, uploadEvidence, type UploadCalls } from '../_lib/evidence-upload';

type Entry = UploadItem & { file: File };

export function useEvidenceUploads(
  instanceId: string | null,
  calls: UploadCalls | null,
  onConfirmed: (evidence: EvidenceView) => void,
) {
  const [items, setItems] = useState<Entry[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const patch = useCallback((id: string, change: Partial<Entry>) => {
    setItems((all) => all.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);
  const drop = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setItems((all) => all.filter((item) => item.id !== id));
  }, []);

  // Another instance, or the drawer closed: stop what is in flight and start empty.
  useEffect(() => {
    const inFlight = controllers.current;
    return () => {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      setItems([]);
    };
  }, [instanceId]);

  const run = useCallback(
    async (id: string, file: File) => {
      if (!calls) return;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      patch(id, { state: 'uploading', loaded: 0 });
      try {
        const result = await uploadEvidence(
          file,
          calls,
          (loaded) => patch(id, { loaded }),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.ok) {
          drop(id);
          onConfirmed(result.data);
        } else {
          patch(id, { state: 'failed' });
          toast({ tone: 'error', message: result.message });
        }
      } catch (error) {
        if (error instanceof UploadAborted || controller.signal.aborted) return;
        patch(id, { state: 'failed' });
        toast({ tone: 'error', message: 'The file didn’t upload. Try again.' });
      } finally {
        if (controllers.current.get(id) === controller) controllers.current.delete(id);
      }
    },
    [calls, drop, onConfirmed, patch],
  );

  const add = useCallback(
    (files: File[]) => {
      const added = files.map((file): Entry => ({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        state: 'queued',
        file,
      }));
      setItems((all) => [...all, ...added]);
      for (const entry of added) void run(entry.id, entry.file);
    },
    [run],
  );

  const retry = useCallback(
    (id: string) => {
      const entry = items.find((item) => item.id === id);
      if (entry) void run(id, entry.file);
    },
    [items, run],
  );

  return {
    items: items.map(({ id, name, size, state, loaded }): UploadItem => ({
      id,
      name,
      size,
      state,
      loaded,
    })),
    add,
    retry,
    cancel: drop,
    remove: drop,
  };
}
