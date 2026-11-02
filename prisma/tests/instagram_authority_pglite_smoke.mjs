import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const pglitePackageDir = process.env.PGLITE_PACKAGE_DIR ?? process.argv[2]

if (!pglitePackageDir) {
  throw new Error(
    'Pass a temporary @electric-sql/pglite package directory as argv[2] or PGLITE_PACKAGE_DIR',
  )
}

const { PGlite } = await import(
  pathToFileURL(join(pglitePackageDir, 'dist', 'index.js')).href
)
const db = await PGlite.create()

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION_FAILED ${message}`)
  console.log(`ASSERTION_OK ${message}`)
}

async function expectSqlState(operation, code, message) {
  try {
    await operation()
  } catch (error) {
    assert(error?.code === code, `${message} has SQLSTATE ${code}`)
    return
  }
  throw new Error(`ASSERTION_FAILED ${message}`)
}

const workspaceId = 'workspace_1'
const accountId = 'account_1'
const organizationId = '33333333-3333-4333-8333-333333333333'
const jobId = '11111111-1111-4111-8111-111111111111'

try {
  await db.exec(`
    create table "Workspace" (
      "id" text primary key
    );
    create table "InstagramAccount" (
      "id" text primary key,
      "workspaceId" text not null references "Workspace"("id"),
      "instagramId" text not null unique,
      "accessToken" text not null
    );
  `)
  const migration = await readFile(join(
    root,
    'prisma',
    'migrations',
    '20261010123000_instagram_channel_authority',
    'migration.sql',
  ), 'utf8')
  await db.exec(migration)
  console.log('MIGRATION_OK 20261010123000_instagram_channel_authority')

  await db.query('insert into "Workspace" ("id") values ($1)', [workspaceId])
  await db.query(
    `insert into "InstagramAccount"
      ("id", "workspaceId", "instagramId", "accessToken")
     values ($1, $2, '178900000000001', 'encrypted')`,
    [accountId, workspaceId],
  )

  const insertOperation = (id, receipt, key, identity) => db.query(
    `insert into "MetaPublicationOperation" (
      "id", "workspaceId", "metisOrganizationId", "instagramAccountId",
      "metisJobId", "attemptReceipt", "operationKey", "operationIdentity",
      "operation", "payloadHash", "status", "updatedAt"
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8,
      'PUBLISH', 'same-semantic-payload', 'STARTED', now()
    )`,
    [id, workspaceId, organizationId, accountId, jobId, receipt, key, identity],
  )

  await insertOperation(
    'operation_1',
    '22222222-2222-4222-8222-222222222222',
    'publish:first',
    'publish',
  )
  await expectSqlState(
    () => insertOperation(
      'operation_2',
      '55555555-5555-4555-8555-555555555555',
      'publish:second',
      'publish',
    ),
    '23505',
    'different caller receipt and key cannot claim the same mutation',
  )

  await insertOperation(
    'operation_3',
    '55555555-5555-4555-8555-555555555555',
    'media:202',
    'media:202:read',
  )
  const rows = await db.query(
    'select "operationIdentity" from "MetaPublicationOperation" order by "id"',
  )
  assert(
    rows.rows.length === 2
      && rows.rows.some((row) => row.operationIdentity === 'publish')
      && rows.rows.some((row) => row.operationIdentity === 'media:202:read'),
    'a different server-derived operation identity remains independently durable',
  )

  await expectSqlState(
    () => db.query('delete from "InstagramAccount" where "id" = $1', [accountId]),
    '23503',
    'publication evidence prevents destructive account deletion',
  )
} finally {
  await db.close()
}
