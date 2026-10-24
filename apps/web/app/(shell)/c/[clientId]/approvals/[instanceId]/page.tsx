// `/c/<client>/approvals/<instance>`: the approvals inbox with that instance's drawer open, so a drawer opened from the
// inbox can be linked to and reloaded. The page is the inbox's own; ApprovalsView reads the instance id from the path,
// which is also how a row opens the drawer in place without a server round trip.
export { default, generateMetadata } from '../page';
