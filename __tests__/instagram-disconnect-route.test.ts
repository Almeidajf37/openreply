import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  disconnect: vi.fn(),
  getContext: vi.fn(),
  canManage: vi.fn(),
}));

vi.mock("@/lib/instagram-accounts", () => ({
  softDisconnectInstagramAccount: mocks.disconnect,
}));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.getContext,
  canManageWorkspace: mocks.canManage,
}));

import { POST } from "@/app/api/instagram/disconnect/route";

function request(body?: unknown) {
  return new NextRequest("https://reply.example.test/api/instagram/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContext.mockResolvedValue({ workspaceId: "workspace_1", role: "OWNER" });
  mocks.canManage.mockReturnValue(true);
});

describe("Instagram disconnect route", () => {
  it.each([
    ["missing", {}],
    ["null", { instagramAccountId: null }],
    ["empty", { instagramAccountId: "" }],
    ["blank", { instagramAccountId: "   " }],
  ])("rejects a %s account id without any database mutation", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("soft-disconnects exactly the requested workspace account", async () => {
    mocks.disconnect.mockResolvedValue({ count: 1 });

    const response = await POST(request({ instagramAccountId: " account_1 " }));

    expect(response.status).toBe(200);
    expect(mocks.disconnect).toHaveBeenCalledWith("workspace_1", "account_1");
  });

  it("returns not found when the exact account does not belong to the workspace", async () => {
    mocks.disconnect.mockResolvedValue({ count: 0 });

    const response = await POST(request({ instagramAccountId: "account_other" }));

    expect(response.status).toBe(404);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});
