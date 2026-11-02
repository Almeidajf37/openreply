import { prisma } from "@/lib/db/client";

export async function softDisconnectInstagramAccount(
  workspaceId: string,
  instagramAccountId: string,
) {
  return prisma.instagramAccount.updateMany({
    where: {
      workspaceId,
      id: instagramAccountId,
    },
    data: {
      accessToken: null,
      tokenExpiresAt: null,
      webhookSubscribed: false,
      capabilities: [],
      connectionStatus: "DISCONNECTED",
      disconnectedAt: new Date(),
    },
  });
}

export async function canConnectInstagramAccount({
  workspaceId,
  instagramId,
}: {
  workspaceId: string;
  instagramId: string;
}) {
  const existingAccount = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { workspaceId: true },
  });

  if (existingAccount && existingAccount.workspaceId !== workspaceId) {
    return {
      allowed: false,
      reason: "already_connected" as const,
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  const connectedWhere = {
    workspaceId,
    connectionStatus: "CONNECTED" as const,
    accessToken: { not: null },
  };
  if (instagramAccountId && instagramAccountId !== "all") {
    const account = await prisma.instagramAccount.findFirst({
      where: { id: instagramAccountId, ...connectedWhere },
    });
    return account?.accessToken ? { ...account, accessToken: account.accessToken } : null;
  }

  const account = await prisma.instagramAccount.findFirst({
    where: connectedWhere,
    orderBy: { connectedAt: "desc" },
  });
  return account?.accessToken ? { ...account, accessToken: account.accessToken } : null;
}

