import { describe, expect, it, vi } from "vitest";
import { createMetisBridgeHandler } from "@/lib/integrations/metis-bridge";

const TOKEN = "t".repeat(48);

function request(method: string, token = TOKEN, body?: unknown) {
  return new Request("https://reply.metisintelligence.com.br/api/integrations/metis/automations", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function setup(overrides: Partial<Parameters<typeof createMetisBridgeHandler>[0]> = {}) {
  const dependencies = {
    token: TOKEN,
    workspaceId: "workspace-metis",
    listCampaigns: vi.fn(async () => []),
    setCampaignActive: vi.fn(async () => true),
    ...overrides,
  };
  return { dependencies, handler: createMetisBridgeHandler(dependencies) };
}

describe("Metis server-to-server bridge", () => {
  it("fails closed when configuration or bearer token is missing", async () => {
    const missingConfig = setup({ token: undefined });
    expect((await missingConfig.handler(request("GET"))).status).toBe(503);

    const invalid = setup();
    expect((await invalid.handler(request("GET", "wrong"))).status).toBe(401);
    expect(invalid.dependencies.listCampaigns).not.toHaveBeenCalled();
  });

  it("lists only through the configured workspace", async () => {
    const test = setup();
    const response = await test.handler(request("GET"));
    expect(response.status).toBe(200);
    expect(test.dependencies.listCampaigns).toHaveBeenCalledWith("workspace-metis");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("scopes status changes to the configured workspace", async () => {
    const test = setup();
    const response = await test.handler(request("PATCH", TOKEN, { id: "campaign-1", isActive: false }));
    expect(response.status).toBe(200);
    expect(test.dependencies.setCampaignActive).toHaveBeenCalledWith(
      "workspace-metis",
      "campaign-1",
      false,
    );
  });

  it("rejects malformed changes and unknown campaigns", async () => {
    const malformed = setup();
    expect((await malformed.handler(request("PATCH", TOKEN, { id: "campaign-1" }))).status).toBe(400);

    const unknown = setup({ setCampaignActive: vi.fn(async () => false) });
    expect((await unknown.handler(request("PATCH", TOKEN, { id: "other-workspace", isActive: true }))).status).toBe(404);
  });
});
