import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import {
  canConnectInstagramAccount,
  getWorkspaceInstagramAccount,
  softDisconnectInstagramAccount,
} from "../lib/instagram-accounts";
import {
  buildInvitationUrl,
  normalizeInvitationEmail,
} from "../lib/workspace-invitations";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agency workspace helpers", () => {
  it("allows reconnecting an account already owned by the workspace", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_123",
    });

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
  });

  it("blocks accounts already connected to another workspace", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      workspaceId: "workspace_other",
    });

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "already_connected",
    });
  });

  it("allows connecting additional accounts with no plan limit", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue(null);

    await expect(
      canConnectInstagramAccount({
        workspaceId: "workspace_123",
        instagramId: "ig_123",
      })
    ).resolves.toMatchObject({ allowed: true, reason: null });
  });

  it("selects a requested workspace account or falls back to the latest account", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "account_1" });

    await getWorkspaceInstagramAccount("workspace_123", "account_1");
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: {
        id: "account_1",
        workspaceId: "workspace_123",
        connectionStatus: "CONNECTED",
        accessToken: { not: null },
      },
    });

    await getWorkspaceInstagramAccount("workspace_123", "all");
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenLastCalledWith({
      where: {
        workspaceId: "workspace_123",
        connectionStatus: "CONNECTED",
        accessToken: { not: null },
      },
      orderBy: { connectedAt: "desc" },
    });
  });

  it("soft-disconnects only the requested account and preserves its record", async () => {
    mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      softDisconnectInstagramAccount("workspace_123", "account_1")
    ).resolves.toEqual({ count: 1 });

    expect(mockPrisma.instagramAccount.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        id: "account_1",
      },
      data: expect.objectContaining({
        accessToken: null,
        tokenExpiresAt: null,
        webhookSubscribed: false,
        capabilities: [],
        connectionStatus: "DISCONNECTED",
        disconnectedAt: expect.any(Date),
      }),
    });
  });

  it("normalizes invitation emails and builds invite URLs", () => {
    expect(normalizeInvitationEmail(" Team@Agency.COM ")).toBe(
      "team@agency.com"
    );
    expect(buildInvitationUrl("token_123", "https://manychat-alternative.com/")).toBe(
      "https://manychat-alternative.com/invite/token_123"
    );
  });
});

