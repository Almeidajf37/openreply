import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  resetUsage: vi.fn(),
  findAccounts: vi.fn(),
  updateAccounts: vi.fn(),
  createEvent: vi.fn(),
  refreshToken: vi.fn(),
  decryptToken: vi.fn((value: string) => `plain:${value}`),
  encryptToken: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    workspace: { updateMany: mocks.resetUsage },
    instagramAccount: {
      findMany: mocks.findAccounts,
      updateMany: mocks.updateAccounts,
    },
    operationalEvent: { create: mocks.createEvent },
  },
}));
vi.mock("@/lib/meta/client", () => ({
  refreshLongLivedToken: mocks.refreshToken,
}));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mocks.decryptToken,
  encryptToken: mocks.encryptToken,
}));

import { GET } from "@/app/api/cron/refresh-tokens/route";

type LiveAccount = {
  id: string;
  workspaceId: string;
  username: string;
  accessToken: string | null;
  connectionStatus: "CONNECTED" | "DISCONNECTED";
  connectionGeneration: number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function request() {
  return new NextRequest("https://reply.example.test/api/cron/refresh-tokens", {
    headers: { authorization: "Bearer cron-secret" },
  });
}

function installAccount(initial: LiveAccount) {
  const state = { account: { ...initial } };
  mocks.findAccounts.mockImplementation(async () => [{ ...state.account }]);
  mocks.updateAccounts.mockImplementation(async ({ where, data }) => {
    const current = state.account;
    if (
      where.id !== current.id ||
      where.connectionStatus !== current.connectionStatus ||
      where.accessToken !== current.accessToken ||
      where.connectionGeneration !== current.connectionGeneration
    ) return { count: 0 };

    state.account = {
      ...current,
      accessToken: data.accessToken,
    };
    return { count: 1 };
  });
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mocks.resetUsage.mockResolvedValue({ count: 0 });
  mocks.createEvent.mockResolvedValue({});
});

describe("token refresh compare-and-swap", () => {
  it("refreshes once when the selected authority is still current", async () => {
    const state = installAccount({
      id: "account_1",
      workspaceId: "workspace_1",
      username: "empresa",
      accessToken: "encrypted-old",
      connectionStatus: "CONNECTED",
      connectionGeneration: 5,
    });
    mocks.refreshToken.mockResolvedValue({ accessToken: "new", expiresIn: 3600 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        totalProcessed: 1,
        refreshed: 1,
        results: [{ status: "refreshed" }],
      },
    });
    expect(state.account.accessToken).toBe("encrypted:new");
    expect(mocks.updateAccounts).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "account_1",
        connectionStatus: "CONNECTED",
        accessToken: "encrypted-old",
        connectionGeneration: 5,
      },
    }));
  });

  it("does not resurrect a token when disconnect wins while Meta is pending", async () => {
    const state = installAccount({
      id: "account_1",
      workspaceId: "workspace_1",
      username: "empresa",
      accessToken: "encrypted-old",
      connectionStatus: "CONNECTED",
      connectionGeneration: 5,
    });
    const meta = deferred<{ accessToken: string; expiresIn: number }>();
    mocks.refreshToken.mockReturnValue(meta.promise);

    const pending = GET(request());
    await vi.waitFor(() => expect(mocks.refreshToken).toHaveBeenCalledTimes(1));
    state.account.connectionStatus = "DISCONNECTED";
    state.account.accessToken = null;
    meta.resolve({ accessToken: "stale-refresh", expiresIn: 3600 });
    const response = await pending;

    await expect(response.json()).resolves.toMatchObject({
      data: {
        refreshed: 0,
        results: [{ status: "skipped", error: "account_changed_during_refresh" }],
      },
    });
    expect(state.account.accessToken).toBeNull();
    expect(state.account.connectionStatus).toBe("DISCONNECTED");
  });

  it("does not overwrite a reconnect that wins while Meta is pending", async () => {
    const state = installAccount({
      id: "account_1",
      workspaceId: "workspace_1",
      username: "empresa",
      accessToken: "encrypted-old",
      connectionStatus: "CONNECTED",
      connectionGeneration: 5,
    });
    const meta = deferred<{ accessToken: string; expiresIn: number }>();
    mocks.refreshToken.mockReturnValue(meta.promise);

    const pending = GET(request());
    await vi.waitFor(() => expect(mocks.refreshToken).toHaveBeenCalledTimes(1));
    state.account.accessToken = "encrypted-reconnected";
    state.account.connectionGeneration = 6;
    meta.resolve({ accessToken: "stale-refresh", expiresIn: 3600 });
    const response = await pending;

    await expect(response.json()).resolves.toMatchObject({
      data: {
        refreshed: 0,
        results: [{ status: "skipped", error: "account_changed_during_refresh" }],
      },
    });
    expect(state.account.accessToken).toBe("encrypted-reconnected");
    expect(state.account.connectionGeneration).toBe(6);
  });
});
