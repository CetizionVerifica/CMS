// Placeholder while an area's handlers are written (removed before ISO-1 is marked ready).
import type { EndpointId, Handler } from '../../handler.js';

export function notYet<K extends EndpointId>(id: K): Handler<K> {
  return () => {
    throw new Error(`${id} is not implemented in the mock yet`);
  };
}
