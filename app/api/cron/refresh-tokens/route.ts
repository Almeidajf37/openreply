import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { refreshLongLivedToken } from "@/lib/meta/client";

const DAYS_BEFORE_EXPIRY = 10;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + DAYS_BEFORE_EXPIRY);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const usageReset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });

  const accountsToRefresh = await prisma.instagramAccount.findMany({
    where: {
      connectionStatus: "CONNECTED",
      accessToken: { not: null },
      tokenExpiresAt: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      accessToken: true,
      connectionGeneration: true,
    },
  });

  const results: Array<{
    instagramAccountId: string;
    username: string;
    status: "refreshed" | "skipped" | "failed";
    error?: string;
  }> = [];

  for (const account of accountsToRefresh) {
    if (!account.accessToken) continue;
    try {
      const currentToken = decryptToken(account.accessToken);
      const { accessToken: newToken, expiresIn } =
        await refreshLongLivedToken(currentToken);
      const encryptedToken = encryptToken(newToken);
      const newExpiry = new Date(Date.now() + expiresIn * 1000);

      const updated = await prisma.instagramAccount.updateMany({
        where: {
          id: account.id,
          connectionStatus: "CONNECTED",
          accessToken: account.accessToken,
          connectionGeneration: account.connectionGeneration,
        },
        data: {
          accessToken: encryptedToken,
          tokenExpiresAt: newExpiry,
        },
      });

      results.push(updated.count === 1
        ? {
            instagramAccountId: account.id,
            username: account.username,
            status: "refreshed",
          }
        : {
            instagramAccountId: account.id,
            username: account.username,
            status: "skipped",
            error: "account_changed_during_refresh",
          });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Token refresh failed for @${account.username}: ${errorMessage}`,
          payload: {
            instagramAccountId: account.id,
            username: account.username,
          },
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      totalProcessed: accountsToRefresh.length,
      refreshed: results.filter((result) => result.status === "refreshed").length,
      workspacesReset: usageReset.count,
      results,
    },
  });
}
