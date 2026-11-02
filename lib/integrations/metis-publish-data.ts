import "server-only";

import { createHash } from "crypto";
import { prisma } from "@/lib/db/client";
import type { MetisPublishRequest } from "@/lib/integrations/metis-publish-contract";
import type { MetisPublishResult } from "@/lib/integrations/metis-publish";
import { createContentPublisher } from "@/lib/meta/content-publisher";
import { decryptToken } from "@/lib/meta/oauth";

const PUBLISH_CAPABILITY = "instagram_business_content_publish";
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function payloadHash(command: MetisPublishRequest) {
  // Receipts and caller operation keys are transport evidence. They must not
  // change the identity of the remote mutation, otherwise a caller could
  // bypass the durable ledger merely by minting new values after a timeout.
  const semanticCommand: Record<string, unknown> = { ...command };
  delete semanticCommand.attemptReceipt;
  delete semanticCommand.operationKey;
  const normalized = command.action === "create-container" && command.asset
    ? {
        ...semanticCommand,
        asset: {
          path: command.asset.path,
          // Signed query parameters expire and are renewed by the worker. The
          // durable operation identifies the frozen Storage object path; host
          // and path still remain part of the hash and are allowlisted first.
          signedUrl: (() => {
            const url = new URL(command.asset.signedUrl);
            return `${url.origin}${url.pathname}`;
          })(),
        },
      }
    : semanticCommand;
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function operationType(command: MetisPublishRequest) {
  switch (command.action) {
    case "diagnostic": return "DIAGNOSTIC" as const;
    case "create-container": return "CREATE_CONTAINER" as const;
    case "container-status": return "CONTAINER_STATUS" as const;
    case "publish": return "PUBLISH" as const;
    case "media": return "MEDIA" as const;
  }
}

function operationIdentity(command: MetisPublishRequest) {
  switch (command.action) {
    case "diagnostic":
      return `diagnostic:${command.operationKey}`;
    case "create-container":
      if (command.mode === "IMAGE") return "create:image";
      if (command.mode === "REELS") return "create:reels";
      if (command.mode === "CAROUSEL_CHILD") {
        return `create:carousel-child:${createHash("sha256")
          .update(command.asset!.path)
          .digest("hex")}`;
      }
      return `create:carousel-parent:${createHash("sha256")
        .update(command.children!.join(","))
        .digest("hex")}`;
    case "container-status":
      return `container-status:${command.containerId}:${command.operationKey}`;
    case "publish":
      // One final mutation per Metis job, regardless of caller receipt/key.
      return "publish";
    case "media":
      return `media:${command.mediaId}:${command.operationKey}`;
  }
}

function isMutation(command: MetisPublishRequest) {
  return command.action === "create-container" || command.action === "publish";
}

function validateAsset(path: string, rawUrl: string, mode: "IMAGE" | "CAROUSEL_CHILD" | "CAROUSEL_PARENT" | "REELS"): string | null {
  const allowedHosts = new Set(
    (process.env.METIS_MEDIA_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedHosts.size === 0) return "media_allowlist_not_configured";
  if (path.length > 1024 || path.includes("\\") || path.split("/").includes("..")) {
    return "media_path_invalid";
  }
  const segments = path.split("/");
  if (
    segments.length < 3 ||
    !UUID_SEGMENT.test(segments[0]) ||
    !UUID_SEGMENT.test(segments[1]) ||
    segments.some((segment) => !segment || segment === ".")
  ) {
    return "media_path_invalid";
  }
  if (mode === "REELS") {
    if (!/\.(mp4|mov)$/i.test(segments.at(-1) ?? "")) return "media_video_required";
  } else if (!/\.jpe?g$/i.test(segments.at(-1) ?? "")) {
    return "media_jpeg_required";
  }
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) {
      return "media_url_not_allowed";
    }
    const decodedPath = decodeURIComponent(url.pathname);
    const expectedSuffix = `/storage/v1/object/sign/metis-content-media/${path}`;
    if (!decodedPath.endsWith(expectedSuffix)) return "media_url_path_mismatch";
  } catch {
    return "media_url_invalid";
  }
  return null;
}

function accountIdentity(account: {
  id: string;
  instagramId: string;
  connectionGeneration: number;
}) {
  return {
    openreplyAccountId: account.id,
    instagramUserId: account.instagramId,
    connectionGeneration: account.connectionGeneration,
  };
}

export async function executeMetisPublish(
  workspaceId: string,
  command: MetisPublishRequest,
): Promise<MetisPublishResult> {
  if (command.action === "create-container" && command.asset) {
    if (!command.asset.path.startsWith(`${command.metisOrganizationId}/`)) {
      return { status: 400, error: "media_organization_mismatch" };
    }
    const error = validateAsset(command.asset.path, command.asset.signedUrl, command.mode);
    if (error) return { status: 400, error };
  }

  const account = await prisma.instagramAccount.findFirst({
    where: {
      id: command.openreplyAccountId,
      workspaceId,
      instagramId: command.instagramUserId,
      connectionGeneration: command.connectionGeneration,
      connectionStatus: "CONNECTED",
    },
    select: {
      id: true,
      instagramId: true,
      connectionGeneration: true,
      accessToken: true,
      capabilities: true,
    },
  });
  if (!account || !account.accessToken) {
    return { status: 409, error: "channel_reconnect_required" };
  }
  if (!account.capabilities.includes(PUBLISH_CAPABILITY)) {
    return { status: 403, error: "content_publish_permission_missing" };
  }

  // Readiness checks must reach Meta without creating publication ledger rows.
  if (command.action === "diagnostic") {
    try {
      const publisher = createContentPublisher({
        accessToken: decryptToken(account.accessToken),
        instagramUserId: account.instagramId,
      });
      const diagnostic = await publisher.diagnose();
      return { data: { ...diagnostic, account: accountIdentity(account) } };
    } catch {
      return { status: 502, error: "remote_read_failed", retryAfterSeconds: 2 };
    }
  }

  const hash = payloadHash(command);
  const identity = operationIdentity(command);
  const unique = {
    workspaceId_metisJobId_operationIdentity: {
      workspaceId,
      metisJobId: command.jobId,
      operationIdentity: identity,
    },
  } as const;
  let operation = await prisma.metaPublicationOperation.findUnique({
    where: unique,
  });
  let shouldExecute = false;

  if (!operation) {
    try {
      operation = await prisma.metaPublicationOperation.create({
        data: {
          workspaceId,
          metisOrganizationId: command.metisOrganizationId,
          instagramAccountId: account.id,
          metisJobId: command.jobId,
          attemptReceipt: command.attemptReceipt,
          operationKey: command.operationKey,
          operationIdentity: identity,
          operation: operationType(command),
          payloadHash: hash,
          status: "STARTED",
        },
      });
      shouldExecute = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      operation = await prisma.metaPublicationOperation.findUnique({ where: unique });
    }
  }
  if (!operation) return { status: 409, error: "operation_claim_failed" };
  if (
    operation.instagramAccountId !== account.id ||
    operation.metisOrganizationId !== command.metisOrganizationId ||
    operation.operation !== operationType(command) ||
    operation.operationIdentity !== identity ||
    operation.payloadHash !== hash
  ) {
    return { status: 409, error: "operation_payload_conflict" };
  }
  if (operation.status === "SUCCEEDED") {
    return { data: operation.response };
  }
  if (!shouldExecute && (operation.status === "STARTED" || operation.status === "AMBIGUOUS")) {
    if (operation.startedAt.getTime() < Date.now() - 60_000 && operation.status === "STARTED") {
      await prisma.metaPublicationOperation.updateMany({
        where: { id: operation.id, status: "STARTED" },
        data: { status: "AMBIGUOUS", errorCode: "stale_started" },
      });
    }
    return {
      status: 409,
      error: "operation_requires_reconciliation",
      retryAfterSeconds: 5,
    };
  }

  if (!shouldExecute) {
    const restarted = await prisma.metaPublicationOperation.updateMany({
      where: { id: operation.id, status: "FAILED_SAFE" },
      data: {
        status: "STARTED",
        attemptReceipt: command.attemptReceipt,
        operationKey: command.operationKey,
        errorCode: null,
        startedAt: new Date(),
        completedAt: null,
      },
    });
    if (restarted.count !== 1) {
      return { status: 409, error: "operation_requires_reconciliation" };
    }
  }

  const publisher = createContentPublisher({
    accessToken: decryptToken(account.accessToken),
    instagramUserId: account.instagramId,
  });
  try {
    let remote: Record<string, unknown>;
    switch (command.action) {
      case "create-container":
        remote = await publisher.createContainer(
          command.mode === "CAROUSEL_PARENT"
            ? { caption: command.caption, childIds: command.children }
            : command.mode === "REELS"
              ? { videoUrl: command.asset!.signedUrl, caption: command.caption }
              : {
                imageUrl: command.asset!.signedUrl,
                caption: command.mode === "IMAGE" ? command.caption : undefined,
                carouselItem: command.mode === "CAROUSEL_CHILD",
              },
        );
        break;
      case "container-status":
        remote = await publisher.getContainerStatus(command.containerId);
        break;
      case "publish":
        remote = await publisher.publish(command.containerId);
        break;
      case "media":
        remote = await publisher.getPublishedMedia(command.mediaId);
        break;
    }
    const response = {
      ...remote,
      account: accountIdentity(account),
      operationReceipt: {
        metisOrganizationId: operation.metisOrganizationId,
        jobId: operation.metisJobId,
        attemptReceipt: operation.attemptReceipt,
        operationIdentity: operation.operationIdentity,
        ...accountIdentity(account),
      },
    };
    const completed = await prisma.metaPublicationOperation.updateMany({
      where: { id: operation.id, status: "STARTED" },
      data: {
        status: "SUCCEEDED",
        response,
        errorCode: null,
        completedAt: new Date(),
      },
    });
    if (completed.count !== 1) {
      return { status: 409, error: "operation_requires_reconciliation" };
    }
    return { data: response };
  } catch (error) {
    const ambiguous = isMutation(command);
    await prisma.metaPublicationOperation.updateMany({
      where: { id: operation.id, status: "STARTED" },
      data: {
        status: ambiguous ? "AMBIGUOUS" : "FAILED_SAFE",
        errorCode: error instanceof Error ? error.message.slice(0, 120) : "remote_error",
        completedAt: new Date(),
      },
    });
    return ambiguous
      ? { status: 409, error: "operation_requires_reconciliation" }
      : { status: 502, error: "remote_read_failed", retryAfterSeconds: 2 };
  }
}
