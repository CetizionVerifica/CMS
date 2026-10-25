# Backup and restore (M14)

How PlanetPulse Compliance's data is backed up, how to restore it, and the drill that proves a restore works. The
drill runs on every build in `e2e/integrated/11-backup-restore.spec.ts`; this page is what an operator does in
production. Never put real hostnames, credentials or bucket names in the repo.

## What holds data

| Store | What | Backed up by |
| --- | --- | --- |
| Postgres 16 | Every account's records, the audit trail, sign-ins, the job queue (`pgboss` schema) and the operator tables | Point-in-time recovery plus a nightly logical dump |
| Object storage (S3) | Evidence files (`evidence/`), uploaded registers (`imports/`) and exports (`exports/`), per account prefix | Bucket versioning plus a replica bucket |
| Secrets | `AUTH_SECRET_KEY`, database logins, storage keys, SMTP | The hosting provider's secret store, outside both backups |

`AUTH_SECRET_KEY` seals MFA secrets. A database restored without the same key leaves every firm user unable to pass
the code step until their MFA is reset, so keep the key's history in the secret store for as long as the oldest
backup.

## Targets for the pilot

- **RPO 5 minutes** for the database (point-in-time recovery), 24 hours from the nightly dump alone.
- **RTO 4 hours** to a working app on restored data.
- Keep 35 days of database recovery points and 35 days of noncurrent object versions: longer than the 30-day grace
  period before a closed account is purged (ADR M15-0002), so a wrongly closed account can be recovered from backup.

## Database

1. Use a managed Postgres 16 with point-in-time recovery switched on and 35-day retention.
2. Nightly, after the 02:00 India-time purge, take a logical dump as the migration owner, from a replica if there is
   one:

   ```
   pg_dump --format=custom --file canopy-$(date -u +%F).dump "$OWNER_DATABASE_URL"
   ```

   The dump is a consistent snapshot even while the API and jobs write. Store it encrypted in a bucket in another
   region, not the evidence bucket, and keep 35 days.
3. Roles are not in the dump. The database server must already have `canopy_app`, `canopy_jobs`, `canopy_operator`,
   `canopy_purge` and the other roles the migrations create, plus the logins that are members of them (deploy
   checklist items 2 and 10 in `review.md`). Script their creation with the deploy, so a new server gets them first.

### Restore the database

1. Stop the API and the job runner, so nothing writes while you restore.
2. Restore to a new database (point-in-time recovery to just before the incident, or the latest dump):

   ```
   createdb canopy_restored
   pg_restore --exit-on-error --dbname "$RESTORED_OWNER_URL" canopy-YYYY-MM-DD.dump
   ```

3. Grant the logins `CONNECT` on the new database (database-level grants are not in the dump) and point
   `DATABASE_URL`, `JOBS_DATABASE_URL` and `OPERATOR_DATABASE_URL` at it.
4. Check before reopening, as the drill does: row counts of the main tables against the last known figures, row-level
   security on (`SELECT relname FROM pg_class WHERE relrowsecurity` lists every client table), and the app login set
   to one account sees none of another's rows.
5. Start the API and the jobs. The nightly purge runs at the next 02:00: an account that was purged after the backup
   was taken comes back as `PENDING_DELETION` past its 30 days and is purged again, files and rows, so restoring an
   older backup does not resurrect a deleted account for longer than a day. Run it at once if that day matters.
6. Record the restore in the operator audit (a note on each affected account) and tell affected customers what window
   of changes was lost, if any.

## Object storage

1. Turn on versioning on the bucket and a lifecycle rule that expires noncurrent versions after 35 days.
2. Replicate the bucket to another region.
3. A restore of a file is a copy of its earlier version back to the same key. Keys are never shown to customers and
   never logged (root CLAUDE.md rule 6), so find them from the database: `evidence.storage_key` for an instance's
   files.
4. A database restored to an earlier point can reference files deleted later: the evidence vault then reports them
   as missing, and the client archive's README counts them. Restore their versions from the bucket.

## The drill

`e2e/integrated/11-backup-restore.spec.ts` runs on every build, after every other journey has written to the
database: it dumps the database with `pg_dump` from one exported snapshot, restores it into a new database on the same
server, and checks that every table's row count, every row-level security flag and every policy came back, and that
the app's own login, set to one account, sees that account's instances and none of the other's. It prints the dump
size and times. Before the pilot, repeat it once by hand against the production setup (a restore of last night's
dump into a scratch database, steps 2 to 4 above) and write down how long it took against the 4-hour target.
