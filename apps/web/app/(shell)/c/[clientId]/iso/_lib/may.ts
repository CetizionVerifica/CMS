// Which edit controls an ISO screen offers. Machine steps (submit, approve, N/A decisions, an audit's visit) come only
// from each view's `allowedActions` (model §10). Plain edits have no steps, so their controls follow the role column
// of the contracts' endpoint table (plan §3.2), the same table the API answers from: a role with `all` may call the
// route, one with `own` only on a record that names the person. The API still decides; this only hides a control the
// API would refuse anyway.
import { ENDPOINTS, type Role } from '@canopy/contracts';

type Name = keyof typeof ENDPOINTS;

/**
 * The add-on's write routes by name (the ISO routes are all named with "Iso", reads with list or get). The actions
 * check each one's `feature` and method again at run time.
 */
export type IsoWriteRoute =
  | Exclude<Extract<Name, `${string}Iso${string}`>, `list${string}` | `get${string}`>
  | 'isoFileUploadUrl';

/** Whether a person with `roles` in the client may call `route`; `named` when the record names them (owner etc.). */
export function mayCall(route: IsoWriteRoute, roles: readonly Role[], named = false): boolean {
  const grants = ENDPOINTS[route].roles;
  return roles.some((role) => {
    const access = grants[role];
    return access === 'all' || (access !== undefined && named);
  });
}
