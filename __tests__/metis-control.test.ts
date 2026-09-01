import { describe, expect, it, vi } from "vitest";
import { createMetisControlHandler } from "@/lib/integrations/metis-control";

const TOKEN = "m".repeat(48);

function call(body: unknown, token = TOKEN, method = "POST") {
  return new Request("https://reply.metisintelligence.com.br/api/integrations/metis/control", {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function setup() {
  const execute = vi.fn(async () => ({ data: { ok: true } }));
  return {
    execute,
    handler: createMetisControlHandler({
      token: TOKEN,
      workspaceId: "workspace-metis",
      execute,
    }),
  };
}

describe("Metis full control bridge", () => {
  it("fails closed before executing commands", async () => {
    const test = setup();
    expect((await test.handler(call({ action: "dashboard" }, "wrong"))).status).toBe(401);
    expect((await test.handler(call({ action: "dashboard" }, TOKEN, "GET"))).status).toBe(405);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("rejects unknown and malformed commands", async () => {
    const test = setup();
    expect((await test.handler(call({ action: "unknown" }))).status).toBe(400);
    expect((await test.handler(call({ action: "inbox:send", text: "hello" }))).status).toBe(400);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("always injects the configured workspace", async () => {
    const test = setup();
    const response = await test.handler(call({ action: "campaigns:list" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(test.execute).toHaveBeenCalledWith("workspace-metis", {
      action: "campaigns:list",
    });
  });

  it("validates campaign invariants before the data layer", async () => {
    const test = setup();
    const response = await test.handler(call({
      action: "campaigns:create",
      campaign: {
        name: "Missing trigger",
        instagramAccountId: "account-1",
        dmMessage: "Message",
        keywords: ["guide"],
      },
    }));
    expect(response.status).toBe(400);
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("preserves explicit upstream status codes", async () => {
    const execute = vi.fn(async () => ({ status: 404, error: "Campaign not found" }));
    const handler = createMetisControlHandler({
      token: TOKEN,
      workspaceId: "workspace-metis",
      execute,
    });
    expect((await handler(call({ action: "campaigns:delete", campaignId: "missing" }))).status).toBe(404);
  });
});
