import "server-only";

import { prisma } from "@/lib/db/client";
import type { MetisCampaign } from "@/lib/integrations/metis-bridge";

export async function listMetisCampaigns(workspaceId: string): Promise<MetisCampaign[]> {
  const [campaigns, statusCounts] = await Promise.all([
    prisma.automation.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        isActive: true,
        keywords: true,
        matchAnyWord: true,
        dmTriggerEnabled: true,
        postUrl: true,
        matchAnyPost: true,
        pendingNextReel: true,
        updatedAt: true,
        instagramAccount: { select: { username: true } },
        _count: { select: { dmLogs: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.dmLog.groupBy({
      by: ["automationId", "status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
  ]);

  const analytics = new Map<string, { sent: number; failed: number; skipped: number }>();
  for (const row of statusCounts) {
    const item = analytics.get(row.automationId) ?? { sent: 0, failed: 0, skipped: 0 };
    if (row.status === "SENT") item.sent += row._count._all;
    else if (row.status === "FAILED") item.failed += row._count._all;
    else if (row.status.startsWith("SKIPPED_")) item.skipped += row._count._all;
    analytics.set(row.automationId, item);
  }

  return campaigns.map((campaign) => {
    const counts = analytics.get(campaign.id) ?? { sent: 0, failed: 0, skipped: 0 };
    return {
      id: campaign.id,
      name: campaign.name,
      isActive: campaign.isActive,
      accountUsername: campaign.instagramAccount.username,
      keywords: campaign.keywords,
      matchAnyWord: campaign.matchAnyWord,
      dmTriggerEnabled: campaign.dmTriggerEnabled,
      postUrl: campaign.postUrl,
      matchAnyPost: campaign.matchAnyPost,
      pendingNextReel: campaign.pendingNextReel,
      sent: counts.sent,
      failed: counts.failed,
      skipped: counts.skipped,
      total: campaign._count.dmLogs,
      updatedAt: campaign.updatedAt.toISOString(),
    };
  });
}

export async function setMetisCampaignActive(
  workspaceId: string,
  campaignId: string,
  isActive: boolean,
) {
  const result = await prisma.automation.updateMany({
    where: { id: campaignId, workspaceId },
    data: { isActive },
  });
  return result.count === 1;
}
