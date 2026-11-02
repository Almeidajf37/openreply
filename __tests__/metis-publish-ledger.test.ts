import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(),
  findOperation: vi.fn(),
  createOperation: vi.fn(),
  updateOperation: vi.fn(),
  createContainer: vi.fn(),
  getContainerStatus: vi.fn(),
  publish: vi.fn(),
  getPublishedMedia: vi.fn(),
  diagnose: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: { findFirst: mocks.findAccount },
    metaPublicationOperation: {
      findUnique: mocks.findOperation,
      create: mocks.createOperation,
      updateMany: mocks.updateOperation,
    },
  },
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "plain-token" }));
vi.mock("@/lib/meta/content-publisher", () => ({
  createContentPublisher: () => ({
    createContainer: mocks.createContainer,
    getContainerStatus: mocks.getContainerStatus,
    publish: mocks.publish,
    getPublishedMedia: mocks.getPublishedMedia,
    diagnose: mocks.diagnose,
  }),
}));

import { executeMetisPublish } from "@/lib/integrations/metis-publish-data";

const JOB = "11111111-1111-4111-8111-111111111111";
const RECEIPT = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const account = {
  id: "account_1",
  instagramId: "178900000000001",
  connectionGeneration: 3,
  accessToken: "encrypted",
  capabilities: ["instagram_business_content_publish"],
};
const base = {
  metisOrganizationId: ORG,
  openreplyAccountId: account.id,
  instagramUserId: account.instagramId,
  connectionGeneration: 3,
  jobId: JOB,
  attemptReceipt: RECEIPT,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("METIS_MEDIA_ALLOWED_HOSTS", "project.supabase.co");
  mocks.findAccount.mockResolvedValue(account);
  mocks.updateOperation.mockResolvedValue({ count: 1 });
});

describe("durable Meta publication ledger", () => {
  it("checks Meta readiness without writing a publication operation", async () => {
    mocks.diagnose.mockResolvedValue({ publishingAvailable: true });
    const result = await executeMetisPublish("workspace_1", {
      action: "diagnostic",
      ...base,
      operationKey: "readiness",
    });

    expect(result).toMatchObject({
      data: {
        publishingAvailable: true,
        account: { openreplyAccountId: account.id, instagramUserId: account.instagramId },
      },
    });
    expect(mocks.diagnose).toHaveBeenCalledOnce();
    expect(mocks.findOperation).not.toHaveBeenCalled();
    expect(mocks.createOperation).not.toHaveBeenCalled();
    expect(mocks.updateOperation).not.toHaveBeenCalled();
  });

  it("reports unavailable when Meta readiness check fails, without ledger writes", async () => {
    mocks.diagnose.mockRejectedValue(new Error("Meta unavailable"));
    const result = await executeMetisPublish("workspace_1", {
      action: "diagnostic",
      ...base,
      operationKey: "readiness",
    });
    expect(result).toMatchObject({ status: 502, error: "remote_read_failed" });
    expect(mocks.createOperation).not.toHaveBeenCalled();
    expect(mocks.updateOperation).not.toHaveBeenCalled();
  });

  it("declares the server-derived operation identity as the Prisma and SQL unique key", () => {
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const migration = readFileSync(join(
      process.cwd(),
      "prisma",
      "migrations",
      "20261010123000_instagram_channel_authority",
      "migration.sql",
    ), "utf8");

    expect(schema).toContain(
      "@@unique([workspaceId, metisJobId, operationIdentity])",
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "MetaPublicationOperation_workspaceId_metisJobId_operationIdentity_key"',
    );
    expect(migration).toContain(
      'ON "MetaPublicationOperation"("workspaceId", "metisJobId", "operationIdentity")',
    );
  });

  it("stores STARTED before a mutation and returns the account-bound receipt", async () => {
    mocks.findOperation.mockResolvedValue(null);
    mocks.createOperation.mockImplementation(async ({ data }) => ({
      id: "operation_1",
      ...data,
      startedAt: new Date(),
    }));
    mocks.createContainer.mockResolvedValue({ containerId: "101" });

    const result = await executeMetisPublish("workspace_1", {
      action: "create-container",
      ...base,
      operationKey: "image",
      mode: "IMAGE",
      caption: "Legenda",
      asset: {
        path: `${ORG}/${ITEM}/image.jpg`,
        signedUrl:
          `https://project.supabase.co/storage/v1/object/sign/metis-content-media/${ORG}/${ITEM}/image.jpg?token=signed`,
      },
    });

    expect(result).toMatchObject({
      data: {
        containerId: "101",
        account: {
          openreplyAccountId: account.id,
          instagramUserId: account.instagramId,
          connectionGeneration: 3,
        },
      },
    });
    expect(mocks.createOperation.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createContainer.mock.invocationCallOrder[0]);
  });

  it("creates a Reel container from a tenant-bound video and keeps one mutation identity", async () => {
    mocks.findOperation.mockResolvedValue(null);
    mocks.createOperation.mockImplementation(async ({ data }) => ({
      id: "operation_1", ...data, startedAt: new Date(),
    }));
    mocks.createContainer.mockResolvedValue({ containerId: "303" });
    const result = await executeMetisPublish("workspace_1", {
      action: "create-container",
      ...base,
      operationKey: "reel:first",
      mode: "REELS",
      caption: "Vídeo de teste",
      asset: {
        path: `${ORG}/${ITEM}/clip.mp4`,
        signedUrl: `https://project.supabase.co/storage/v1/object/sign/metis-content-media/${ORG}/${ITEM}/clip.mp4?token=signed`,
      },
    });
    expect(result).toMatchObject({ data: { containerId: "303" } });
    expect(mocks.createOperation.mock.calls[0][0].data.operationIdentity).toBe("create:reels");
    expect(mocks.createContainer).toHaveBeenCalledWith({ videoUrl: expect.stringContaining("clip.mp4"), caption: "Vídeo de teste" });
  });

  it("rejects wrong tenant or image file for a Reel before Meta access", async () => {
    const baseCommand = {
      action: "create-container" as const,
      ...base,
      operationKey: "reel",
      mode: "REELS" as const,
      asset: {
        path: `${ORG}/${ITEM}/clip.jpg`,
        signedUrl: `https://project.supabase.co/storage/v1/object/sign/metis-content-media/${ORG}/${ITEM}/clip.jpg?token=signed`,
      },
    };
    await expect(executeMetisPublish("workspace_1", baseCommand))
      .resolves.toEqual({ status: 400, error: "media_video_required" });
    await expect(executeMetisPublish("workspace_1", {
      ...baseCommand,
      asset: { ...baseCommand.asset, path: `${ITEM}/${ITEM}/clip.mp4` },
    })).resolves.toEqual({ status: 400, error: "media_organization_mismatch" });
    expect(mocks.findAccount).not.toHaveBeenCalled();
  });

  it("replays a successful mutation across new receipt/key evidence without repeating Meta", async () => {
    mocks.findOperation.mockResolvedValueOnce(null);
    mocks.createOperation.mockImplementation(async ({ data }) => ({
      id: "operation_1",
      ...data,
      startedAt: new Date(),
    }));
    mocks.publish.mockResolvedValue({ mediaId: "202" });
    const command = {
      action: "publish" as const,
      ...base,
      operationKey: "publish:first-evidence",
      containerId: "101",
    };
    const first = await executeMetisPublish("workspace_1", command);
    const created = mocks.createOperation.mock.calls[0][0].data;
    mocks.findOperation.mockResolvedValue({
      id: "operation_1",
      ...created,
      status: "SUCCEEDED",
      response: first.data,
      startedAt: new Date(),
    });

    const replay = await executeMetisPublish("workspace_1", {
      ...command,
      attemptReceipt: "55555555-5555-4555-8555-555555555555",
      operationKey: "publish:second-evidence",
    });
    expect(replay).toEqual(first);
    expect(replay).toMatchObject({
      data: {
        operationReceipt: {
          attemptReceipt: RECEIPT,
          operationIdentity: "publish",
          metisOrganizationId: ORG,
        },
      },
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("does not let a new operation key publish a different container for the same job", async () => {
    mocks.findOperation.mockResolvedValueOnce(null);
    mocks.createOperation.mockImplementation(async ({ data }) => ({
      id: "operation_1",
      ...data,
      startedAt: new Date(),
    }));
    mocks.publish.mockResolvedValue({ mediaId: "202" });
    const command = {
      action: "publish" as const,
      ...base,
      operationKey: "publish:first",
      containerId: "101",
    };
    const first = await executeMetisPublish("workspace_1", command);
    const created = mocks.createOperation.mock.calls[0][0].data;
    mocks.findOperation.mockResolvedValue({
      id: "operation_1",
      ...created,
      status: "SUCCEEDED",
      response: first.data,
      startedAt: new Date(),
    });
    mocks.publish.mockClear();

    await expect(executeMetisPublish("workspace_1", {
      ...command,
      containerId: "102",
      attemptReceipt: "55555555-5555-4555-8555-555555555555",
      operationKey: "publish:second",
    })).resolves.toEqual({ status: 409, error: "operation_payload_conflict" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects a saved result when the target account or generation diverges", async () => {
    mocks.findOperation.mockResolvedValueOnce(null);
    mocks.createOperation.mockImplementation(async ({ data }) => ({
      id: "operation_1",
      ...data,
      startedAt: new Date(),
    }));
    mocks.publish.mockResolvedValue({ mediaId: "202" });
    const command = {
      action: "publish" as const,
      ...base,
      operationKey: "publish",
      containerId: "101",
    };
    const first = await executeMetisPublish("workspace_1", command);
    const created = mocks.createOperation.mock.calls[0][0].data;
    mocks.findOperation.mockResolvedValue({
      id: "operation_1",
      ...created,
      status: "SUCCEEDED",
      response: first.data,
      startedAt: new Date(),
    });
    mocks.publish.mockClear();

    const otherAccount = {
      ...account,
      id: "account_2",
      instagramId: "178900000000002",
    };
    mocks.findAccount.mockResolvedValueOnce(otherAccount);
    await expect(executeMetisPublish("workspace_1", {
      ...command,
      openreplyAccountId: otherAccount.id,
      instagramUserId: otherAccount.instagramId,
    })).resolves.toEqual({ status: 409, error: "operation_payload_conflict" });

    mocks.findAccount.mockResolvedValueOnce({ ...account, connectionGeneration: 4 });
    await expect(executeMetisPublish("workspace_1", {
      ...command,
      connectionGeneration: 4,
    })).resolves.toEqual({ status: 409, error: "operation_payload_conflict" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("replays a known container result after only the signed URL expires", async () => {
    mocks.findOperation.mockResolvedValueOnce(null);
    mocks.createOperation.mockImplementation(async ({ data }) => ({
      id: "operation_1",
      ...data,
      startedAt: new Date(),
    }));
    mocks.createContainer.mockResolvedValue({ containerId: "101" });
    const command = {
      action: "create-container" as const,
      ...base,
      operationKey: "image",
      mode: "IMAGE" as const,
      asset: {
        path: `${ORG}/${ITEM}/image.jpg`,
        signedUrl: `https://project.supabase.co/storage/v1/object/sign/metis-content-media/${ORG}/${ITEM}/image.jpg?token=first`,
      },
    };
    await executeMetisPublish("workspace_1", command);
    const created = mocks.createOperation.mock.calls[0][0].data;
    const cached = {
      containerId: "101",
      account: {
        openreplyAccountId: account.id,
        instagramUserId: account.instagramId,
        connectionGeneration: 3,
      },
    };
    mocks.findOperation.mockResolvedValue({
      id: "operation_1",
      ...created,
      status: "SUCCEEDED",
      response: cached,
      startedAt: new Date(),
    });
    mocks.createContainer.mockClear();

    await expect(executeMetisPublish("workspace_1", {
      ...command,
      asset: { ...command.asset, signedUrl: command.asset.signedUrl.replace("first", "renewed") },
    })).resolves.toEqual({ data: cached });
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it("marks an uncertain publish ambiguous and never sends it again", async () => {
    let stored: Record<string, unknown> | null = null;
    mocks.findOperation.mockImplementation(async () => stored);
    mocks.createOperation.mockImplementation(async ({ data }) => {
      stored = { id: "operation_1", ...data, startedAt: new Date() };
      return stored;
    });
    mocks.publish.mockRejectedValue(new Error("network response lost"));
    mocks.updateOperation.mockImplementation(async ({ data }) => {
      stored = { ...stored, ...data };
      return { count: 1 };
    });
    const command = {
      action: "publish" as const,
      ...base,
      operationKey: "publish",
      containerId: "101",
    };

    await expect(executeMetisPublish("workspace_1", command)).resolves.toMatchObject({
      status: 409,
      error: "operation_requires_reconciliation",
    });
    await expect(executeMetisPublish("workspace_1", {
      ...command,
      attemptReceipt: "55555555-5555-4555-8555-555555555555",
      operationKey: "publish:new-evidence",
    })).resolves.toMatchObject({
      status: 409,
      error: "operation_requires_reconciliation",
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent publish evidence and dispatches Meta only once on timeout", async () => {
    let stored: Record<string, unknown> | null = null;
    mocks.findOperation.mockImplementation(async () => stored);
    mocks.createOperation.mockImplementation(async ({ data }) => {
      if (stored) throw Object.assign(new Error("unique race"), { code: "P2002" });
      stored = { id: "operation_1", ...data, startedAt: new Date() };
      return stored;
    });
    mocks.updateOperation.mockImplementation(async ({ data }) => {
      stored = { ...stored, ...data };
      return { count: 1 };
    });
    mocks.publish.mockRejectedValue(new Error("timeout after remote dispatch"));
    const first = {
      action: "publish" as const,
      ...base,
      operationKey: "publish:first",
      containerId: "101",
    };
    const second = {
      ...first,
      attemptReceipt: "55555555-5555-4555-8555-555555555555",
      operationKey: "publish:second",
    };

    const [firstResult, secondResult] = await Promise.all([
      executeMetisPublish("workspace_1", first),
      executeMetisPublish("workspace_1", second),
    ]);

    expect(firstResult).toMatchObject({
      status: 409,
      error: "operation_requires_reconciliation",
    });
    expect(secondResult).toMatchObject({
      status: 409,
      error: "operation_requires_reconciliation",
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.createOperation).toHaveBeenCalledTimes(2);
  });

  it("rejects signed media outside the configured host before ledger or Meta", async () => {
    const result = await executeMetisPublish("workspace_1", {
      action: "create-container",
      ...base,
      operationKey: "image",
      mode: "IMAGE",
      asset: {
        path: `${ORG}/${ITEM}/image.jpg`,
        signedUrl:
          `https://evil.example/storage/v1/object/sign/metis-content-media/${ORG}/${ITEM}/image.jpg?token=signed`,
      },
    });
    expect(result).toEqual({ status: 400, error: "media_url_not_allowed" });
    expect(mocks.findAccount).not.toHaveBeenCalled();
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });
});
