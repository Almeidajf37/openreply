import { describe, expect, it, vi } from "vitest";
import { createMetisPublishHandler } from "@/lib/integrations/metis-publish";

const TOKEN = "p".repeat(48);
const ORG = "33333333-3333-4333-8333-333333333333";
const command = {
  action: "container-status",
  metisOrganizationId: ORG,
  openreplyAccountId: "account_1",
  instagramUserId: "178900000000001",
  connectionGeneration: 3,
  jobId: "11111111-1111-4111-8111-111111111111",
  attemptReceipt: "22222222-2222-4222-8222-222222222222",
  operationKey: "status:101:1",
  containerId: "101",
};

function request(body: unknown, token = TOKEN) {
  return new Request("https://reply.example.test/api/integrations/metis/publish", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Metis private publication bridge", () => {
  it("fails closed before parsing or executing commands", async () => {
    const execute = vi.fn(async () => ({ data: {} }));
    const handler = createMetisPublishHandler({
      token: TOKEN,
      workspaceId: "workspace_1",
      organizationId: ORG,
      execute,
    });
    expect((await handler(request(command, "wrong"))).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("injects the configured workspace and preserves reconciliation responses", async () => {
    const execute = vi.fn(async () => ({
      status: 409,
      error: "operation_requires_reconciliation",
      retryAfterSeconds: 5,
    }));
    const handler = createMetisPublishHandler({
      token: TOKEN,
      workspaceId: "workspace_1",
      organizationId: ORG,
      execute,
    });
    const response = await handler(request(command));
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(execute).toHaveBeenCalledWith("workspace_1", command);
  });

  it("rejects a missing or different organization before execution", async () => {
    const execute = vi.fn(async () => ({ data: {} }));
    const handler = createMetisPublishHandler({
      token: TOKEN,
      workspaceId: "workspace_1",
      organizationId: ORG,
      execute,
    });
    const unscoped: Record<string, unknown> = { ...command };
    delete unscoped.metisOrganizationId;

    expect((await handler(request(unscoped))).status).toBe(400);
    expect((await handler(request({
      ...command,
      metisOrganizationId: "44444444-4444-4444-8444-444444444444",
    }))).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an unfrozen or malformed target identity", async () => {
    const execute = vi.fn(async () => ({ data: {} }));
    const handler = createMetisPublishHandler({
      token: TOKEN,
      workspaceId: "workspace_1",
      organizationId: ORG,
      execute,
    });
    const response = await handler(request({ ...command, connectionGeneration: 0 }));
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts one video asset for REELS and rejects carousel children", async () => {
    const execute = vi.fn(async () => ({ data: { containerId: "303" } }));
    const handler = createMetisPublishHandler({
      token: TOKEN,
      workspaceId: "workspace_1",
      organizationId: ORG,
      execute,
    });
    const reel = {
      ...command,
      action: "create-container",
      operationKey: "reel",
      mode: "REELS",
      caption: "Vídeo",
      asset: {
        path: `${ORG}/44444444-4444-4444-8444-444444444444/video.mp4`,
        signedUrl: "https://project.supabase.co/storage/v1/object/sign/metis-content-media/video.mp4?token=signed",
      },
    };
    delete (reel as { containerId?: string }).containerId;
    expect((await handler(request(reel))).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await handler(request({ ...reel, children: ["101", "102"] }))).status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
