-- Keep Instagram account identity and dependent history when a connection is
-- revoked. Publishing authority is represented explicitly and tokens can be
-- erased without cascading business data.
CREATE TYPE "InstagramConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED');
CREATE TYPE "MetisOAuthIntentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
CREATE TYPE "MetaPublicationOperationType" AS ENUM (
  'DIAGNOSTIC',
  'CREATE_CONTAINER',
  'CONTAINER_STATUS',
  'PUBLISH',
  'MEDIA'
);
CREATE TYPE "MetaPublicationOperationStatus" AS ENUM (
  'STARTED',
  'SUCCEEDED',
  'AMBIGUOUS',
  'FAILED_SAFE'
);

ALTER TABLE "InstagramAccount"
  ALTER COLUMN "accessToken" DROP NOT NULL,
  ADD COLUMN "connectionStatus" "InstagramConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
  ADD COLUMN "connectionGeneration" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN "disconnectedAt" TIMESTAMP(3);

CREATE TABLE "MetisOAuthIntent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "metisOrganizationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "status" "MetisOAuthIntentStatus" NOT NULL DEFAULT 'PENDING',
  "instagramAccountId" TEXT,
  "errorCode" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetisOAuthIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetaPublicationOperation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "metisOrganizationId" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "metisJobId" TEXT NOT NULL,
  "attemptReceipt" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "operationIdentity" TEXT NOT NULL,
  "operation" "MetaPublicationOperationType" NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" "MetaPublicationOperationStatus" NOT NULL DEFAULT 'STARTED',
  "response" JSONB,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaPublicationOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InstagramAccount_workspaceId_connectionStatus_idx"
  ON "InstagramAccount"("workspaceId", "connectionStatus");
CREATE INDEX "MetisOAuthIntent_workspaceId_status_expiresAt_idx"
  ON "MetisOAuthIntent"("workspaceId", "status", "expiresAt");
CREATE INDEX "MetisOAuthIntent_metisOrganizationId_actorId_idx"
  ON "MetisOAuthIntent"("metisOrganizationId", "actorId");
CREATE INDEX "MetaPublicationOperation_instagramAccountId_status_idx"
  ON "MetaPublicationOperation"("instagramAccountId", "status");
CREATE INDEX "MetaPublicationOperation_metisOrganizationId_metisJobId_idx"
  ON "MetaPublicationOperation"("metisOrganizationId", "metisJobId");
CREATE UNIQUE INDEX "MetaPublicationOperation_workspaceId_metisJobId_operationIdentity_key"
  ON "MetaPublicationOperation"("workspaceId", "metisJobId", "operationIdentity");

ALTER TABLE "MetisOAuthIntent"
  ADD CONSTRAINT "MetisOAuthIntent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MetisOAuthIntent_instagramAccountId_fkey"
  FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MetaPublicationOperation"
  ADD CONSTRAINT "MetaPublicationOperation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaPublicationOperation_instagramAccountId_fkey"
  FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

