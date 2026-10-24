// `/c/<client>/register/<instance>`: the register with that instance's drawer open (apps/web/CLAUDE.md "Routes"), so a
// drawer can be linked to, bookmarked and reloaded. The page is the register's own; RegisterView reads the instance id
// from the path, which is also how a row opens the drawer in place without a server round trip.
export { default, generateMetadata } from '../page';
