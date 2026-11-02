# Metis Instagram publishing authority

OpenReply is the only component that stores encrypted Meta access tokens and
calls Meta publishing endpoints. The Metis integration authenticates with the
existing private bearer token and is locked to both
`METIS_OPENREPLY_WORKSPACE_ID` and `METIS_INSTAGRAM_ORGANIZATION_ID`.
The organization UUID must equal the value configured in the Metis Edge
Functions. There is no first-organization or request-derived fallback.

The deployment requires `METIS_INTEGRATION_TOKEN`,
`METIS_OPENREPLY_WORKSPACE_ID`, `METIS_INSTAGRAM_ORGANIZATION_ID`, and
`METIS_MEDIA_ALLOWED_HOSTS`. Keep the endpoints disabled when any value is
missing; never infer one from the first database row.

## Private endpoints

- `POST /api/integrations/metis/control` creates and reads exact OAuth intents,
  validates existing accounts, and soft-disconnects accounts.
- `POST /api/integrations/metis/publish` accepts only `diagnostic`,
  `create-container`, `container-status`, `publish`, and `media` commands.

Every control and publish command supplies the configured Metis organization.
OpenReply rejects a missing or different organization before running a data
operation. Every publish command also supplies the frozen OpenReply account ID,
Instagram user ID, connection generation, Metis job ID, attempt receipt and
operation key.
OpenReply rejects disconnected accounts, identity or generation mismatch, and
accounts without `instagram_business_content_publish`.

Media URLs must use HTTPS, a host in `METIS_MEDIA_ALLOWED_HOSTS`, the signed
Supabase Storage path for `metis-content-media`, organization and item UUID
segments. Image assets require `.jpg` or `.jpeg`; Reels require `.mp4` or `.mov`,
with a 50 MB limit enforced by Metis before publication. The worker may renew only
the signed query string; the frozen bucket path remains the durable operation identity.

## Durable mutation ledger

`MetaPublicationOperation` is inserted as `STARTED` before a Meta call. The
unique key is workspace, Metis job and a server-derived semantic operation
identity. The attempt receipt and caller operation key remain evidence; changing
either cannot create a second mutation. The semantic payload hash,
organization and account ID must also match.

- `SUCCEEDED` returns the stored target-bound operation receipt without another
  Meta call.
- stale `STARTED` and every `AMBIGUOUS` mutation require reconciliation.
- read-only failures use `FAILED_SAFE` and may be retried.
- create-container and publish failures are treated as ambiguous because the
  remote side may have accepted the request.

The ledger and Instagram account use restrictive foreign keys so a disconnect
cannot erase evidence. Soft disconnect clears token authority, capability and
webhook state while preserving dependent history. The disconnect route requires
one explicit nonblank Instagram account ID and always scopes the update by both
workspace and that ID; malformed input performs no database mutation.

The versioned disposable-DDL smoke applies the exact Prisma migration and
proves the unique operation identity and restrictive account foreign key:

```powershell
$pgliteRoot = Join-Path $env:TEMP 'openreply-pglite-smoke'
npm.cmd install --prefix $pgliteRoot --no-save @electric-sql/pglite@0.4.1
node prisma/tests/instagram_authority_pglite_smoke.mjs "$pgliteRoot/node_modules/@electric-sql/pglite"
```

This temporary install does not modify the application package manifest or
lockfile.

## Publication bounds

An automatic image post accepts one JPEG. An automatic carousel accepts two to
ten JPEG assets. Metis validates the frozen snapshot before inserting a job,
and the publisher repeats the 2-to-10 validation before signing media, writing a
remote-state receipt or calling Meta. Editorial planning may keep more assets,
but it cannot enter automatic publication unchanged.

## OAuth intent

The signed state binds workspace, Metis organization, actor and intent ID. The
callback verifies the same pending, unexpired database row and completes the
account upsert and intent in one Prisma transaction. The redirect contains only
the intent ID; Metis retrieves that exact result and never selects the latest
account as a fallback.

## Migration and rollback

Apply `prisma/migrations/20261010123000_instagram_channel_authority/migration.sql`
before enabling the Metis worker. Generate Prisma Client and deploy the app
without invoking a command that also migrates an unapproved remote database.

Before any Meta mutation, rollback can keep the integration endpoint disabled
while the schema and history remain in place. Once an operation is `STARTED`,
`AMBIGUOUS`, or `SUCCEEDED`, preserve the ledger and reconcile forward. Never
delete the ledger or resend a mutation to force recovery.
