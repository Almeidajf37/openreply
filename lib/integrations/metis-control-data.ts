import "server-only";

import { DmStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  getAllUserMedia,
  getConversationMessages,
  getConversations,
  MetaApiError,
  sendDirectMessage,
} from "@/lib/meta/client";
import {
  createMetisOAuthState,
  decryptToken,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";
import { getBaseUrl, getMissingInstagramOAuthEnv } from "@/lib/env";
import { getDMQueue } from "@/lib/queue/client";
import { getWorkerAlerts, getWorkerHealth } from "@/lib/ops/worker-health";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { buildReportUrl, generateReportShareSlug } from "@/lib/reports/share";
import { CAMPAIGN_TEMPLATES } from "@/lib/templates/campaign-templates";
import type {
  CampaignPatch,
  CampaignPayload,
  MetisControlRequest,
} from "@/lib/integrations/metis-control-contract";
import type { MetisControlResult } from "@/lib/integrations/metis-control";

async function ensureAccount(workspaceId: string, accountId: string) {
  return prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId },
  });
}

async function campaignAnalytics(workspaceId: string) {
  const [statuses, clicks] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["automationId", "status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.linkClick.groupBy({
      by: ["automationId"],
      where: { workspaceId },
      _count: { _all: true },
    }),
  ]);

  const result = new Map<string, { sent: number; failed: number; skipped: number; clicks: number }>();
  for (const row of statuses) {
    const current = result.get(row.automationId) ?? { sent: 0, failed: 0, skipped: 0, clicks: 0 };
    if (row.status === "SENT") current.sent += row._count._all;
    else if (row.status === "FAILED") current.failed += row._count._all;
    else if (row.status.startsWith("SKIPPED_")) current.skipped += row._count._all;
    result.set(row.automationId, current);
  }
  for (const row of clicks) {
    const current = result.get(row.automationId) ?? { sent: 0, failed: 0, skipped: 0, clicks: 0 };
    current.clicks = row._count._all;
    result.set(row.automationId, current);
  }
  return result;
}

async function listCampaigns(workspaceId: string, instagramAccountId?: string) {
  const [campaigns, analytics] = await Promise.all([
    prisma.automation.findMany({
      where: {
        workspaceId,
        ...(instagramAccountId ? { instagramAccountId } : {}),
      },
      include: {
        instagramAccount: { select: { username: true } },
        trackedLinks: { orderBy: { createdAt: "asc" } },
        _count: { select: { dmLogs: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    campaignAnalytics(workspaceId),
  ]);

  return campaigns.map((campaign) => {
    const counts = analytics.get(campaign.id) ?? { sent: 0, failed: 0, skipped: 0, clicks: 0 };
    return {
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      instagramAccountId: campaign.instagramAccountId,
      accountUsername: campaign.instagramAccount.username,
      postId: campaign.postId,
      postUrl: campaign.postUrl,
      pendingNextReel: campaign.pendingNextReel,
      matchAnyPost: campaign.matchAnyPost,
      keywords: campaign.keywords,
      matchAnyWord: campaign.matchAnyWord,
      dmTriggerEnabled: campaign.dmTriggerEnabled,
      dmMessage: campaign.dmMessage,
      openingDmEnabled: campaign.openingDmEnabled,
      openingDmMessage: campaign.openingDmMessage,
      openingDmButtonLabel: campaign.openingDmButtonLabel,
      linkButtonLabel: campaign.linkButtonLabel,
      requireFollow: campaign.requireFollow,
      followPromptMessage: campaign.followPromptMessage,
      followPromptButtonLabel: campaign.followPromptButtonLabel,
      followUpEnabled: campaign.followUpEnabled,
      followUpMessage: campaign.followUpMessage,
      followUpDelayMinutes: campaign.followUpDelayMinutes,
      publicReplyEnabled: campaign.publicReplyEnabled,
      publicReplyMessages:
        campaign.publicReplyMessages.length > 0
          ? campaign.publicReplyMessages
          : campaign.publicReplyMessage
            ? [campaign.publicReplyMessage]
            : [],
      isActive: campaign.isActive,
      wholeWordMatch: campaign.wholeWordMatch,
      reportShareEnabled: campaign.reportShareEnabled,
      reportShareSlug: campaign.reportShareSlug,
      reportUrl:
        campaign.reportShareEnabled && campaign.reportShareSlug
          ? buildReportUrl(campaign.reportShareSlug)
          : null,
      trackedLinks: campaign.trackedLinks.map((link) => ({
        id: link.id,
        label: link.label,
        destinationUrl: link.destinationUrl,
      })),
      ...counts,
      ctr: counts.sent > 0 ? Math.round((counts.clicks / counts.sent) * 10000) / 100 : 0,
      total: campaign._count.dmLogs,
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
    };
  });
}

function normalizedCampaignData(payload: CampaignPayload | Omit<CampaignPatch, "id">) {
  const data = { ...payload };
  if (data.matchAnyWord) data.keywords = [];
  if (data.matchAnyPost || data.pendingNextReel) {
    data.postId = null;
    data.postUrl = null;
  }
  if (data.openingDmEnabled === false) {
    data.openingDmMessage = null;
    data.openingDmButtonLabel = null;
  }
  if (data.requireFollow === false) {
    data.followPromptMessage = null;
    data.followPromptButtonLabel = null;
  }
  if (data.followUpEnabled === false) {
    data.followUpMessage = null;
    data.followUpDelayMinutes = 0;
  }
  if (data.publicReplyEnabled === false) data.publicReplyMessages = [];
  return data;
}

async function createCampaign(workspaceId: string, payload: CampaignPayload): Promise<MetisControlResult> {
  if (!(await ensureAccount(workspaceId, payload.instagramAccountId))) {
    return { status: 404, error: "Instagram account not found" };
  }
  const normalized = normalizedCampaignData(payload) as CampaignPayload;
  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    publicReplyMessages,
    ...automationData
  } = normalized;

  const created = await prisma.$transaction(async (tx) => {
    const campaign = await tx.automation.create({
      data: {
        ...automationData,
        publicReplyMessages,
        publicReplyMessage: publicReplyMessages[0] ?? null,
        reportShareSlug: generateReportShareSlug(),
        workspaceId,
      },
    });
    if (trackedDestinationUrl) {
      await tx.trackedLink.create({
        data: {
          workspaceId,
          automationId: campaign.id,
          slug: generateTrackedLinkSlug(),
          label: "Primary campaign link",
          destinationUrl: trackedDestinationUrl,
        },
      });
    }
    if (secondaryDestinationUrl) {
      await tx.trackedLink.create({
        data: {
          workspaceId,
          automationId: campaign.id,
          slug: generateTrackedLinkSlug(),
          label: secondaryButtonLabel || "Open link",
          destinationUrl: secondaryDestinationUrl,
        },
      });
    }
    return campaign;
  });
  return { status: 201, data: { id: created.id } };
}

async function syncLinks(
  workspaceId: string,
  automationId: string,
  primary: string | undefined | null,
  secondary: string | undefined | null,
  secondaryLabel: string | undefined | null,
) {
  if (primary === undefined && secondary === undefined && secondaryLabel === undefined) return;
  await prisma.$transaction(async (tx) => {
    const links = await tx.trackedLink.findMany({
      where: { workspaceId, automationId },
      orderBy: { createdAt: "asc" },
    });
    const nextPrimary = primary === undefined || primary === null
      ? links[0]?.destinationUrl ?? ""
      : primary;
    const nextSecondary = secondary === undefined || secondary === null
      ? links[1]?.destinationUrl ?? ""
      : secondary;
    const nextSecondaryLabel = secondaryLabel === undefined || secondaryLabel === null
      ? links[1]?.label ?? "Open link"
      : secondaryLabel || "Open link";

    await tx.trackedLink.deleteMany({ where: { workspaceId, automationId } });
    if (nextPrimary) {
      await tx.trackedLink.create({
        data: { workspaceId, automationId, slug: generateTrackedLinkSlug(), label: "Primary campaign link", destinationUrl: nextPrimary },
      });
    }
    if (nextPrimary && nextSecondary) {
      await tx.trackedLink.create({
        data: { workspaceId, automationId, slug: generateTrackedLinkSlug(), label: nextSecondaryLabel, destinationUrl: nextSecondary },
      });
    }
  });
}

async function updateCampaign(workspaceId: string, patch: CampaignPatch): Promise<MetisControlResult> {
  const existing = await prisma.automation.findFirst({ where: { id: patch.id, workspaceId } });
  if (!existing) return { status: 404, error: "Campaign not found" };
  if (patch.instagramAccountId && !(await ensureAccount(workspaceId, patch.instagramAccountId))) {
    return { status: 404, error: "Instagram account not found" };
  }
  const {
    id,
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    publicReplyMessages,
    ...rawData
  } = patch;
  const data = normalizedCampaignData(rawData);
  await prisma.automation.updateMany({
    where: { id, workspaceId },
    data: {
      ...data,
      ...(publicReplyMessages
        ? {
            publicReplyMessages,
            publicReplyMessage: publicReplyMessages[0] ?? null,
          }
        : {}),
    },
  });
  await syncLinks(
    workspaceId,
    id,
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
  );
  return { data: { id } };
}

async function dashboard(workspaceId: string, instagramAccountId?: string) {
  const accountFilter = instagramAccountId ? { instagramAccountId } : {};
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart);
  weekStart.setDate(weekStart.getDate() - 6);
  const [accounts, totalCampaigns, activeCampaigns, sentToday, sentWeek, sentMonth, statuses, clicksMonth, topKeywords, recentLogs] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId }, orderBy: { connectedAt: "desc" }, select: { id: true, username: true, name: true, instagramId: true, tokenExpiresAt: true, webhookSubscribed: true, connectedAt: true } }),
    prisma.automation.count({ where: { workspaceId, ...accountFilter } }),
    prisma.automation.count({ where: { workspaceId, isActive: true, ...accountFilter } }),
    prisma.dmLog.count({ where: { workspaceId, status: "SENT", createdAt: { gte: dayStart }, ...accountFilter } }),
    prisma.dmLog.count({ where: { workspaceId, status: "SENT", createdAt: { gte: weekStart }, ...accountFilter } }),
    prisma.dmLog.count({ where: { workspaceId, status: "SENT", createdAt: { gte: monthStart }, ...accountFilter } }),
    prisma.dmLog.groupBy({ by: ["status"], where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter }, _count: { _all: true } }),
    prisma.linkClick.count({ where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter } }),
    prisma.dmLog.groupBy({ by: ["matchedKeyword"], where: { workspaceId, matchedKeyword: { not: null }, ...accountFilter }, _count: { _all: true } }),
    prisma.dmLog.findMany({ where: { workspaceId, ...accountFilter }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, commenterName: true, commentText: true, status: true, createdAt: true, automation: { select: { name: true } }, instagramAccount: { select: { username: true } } } }),
  ]);
  const statusSummary = statuses.reduce((acc, row) => {
    if (row.status === "FAILED") acc.failed += row._count._all;
    else if (row.status.startsWith("SKIPPED_")) acc.skipped += row._count._all;
    return acc;
  }, { failed: 0, skipped: 0 });
  const dailyDMs = [];
  for (let offset = 6; offset >= 0; offset--) {
    const start = new Date(dayStart);
    start.setDate(start.getDate() - offset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    dailyDMs.push({
      date: start.toISOString().slice(0, 10),
      count: await prisma.dmLog.count({ where: { workspaceId, status: "SENT", createdAt: { gte: start, lt: end }, ...accountFilter } }),
    });
  }
  return {
    accounts: accounts.map((account) => ({ ...account, tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null, connectedAt: account.connectedAt.toISOString() })),
    totalCampaigns,
    activeCampaigns,
    sentToday,
    sentWeek,
    sentMonth,
    failedMonth: statusSummary.failed,
    skippedMonth: statusSummary.skipped,
    clicksMonth,
    ctrMonth: sentMonth > 0 ? Math.round((clicksMonth / sentMonth) * 10000) / 100 : 0,
    dailyDMs,
    topKeywords: topKeywords.filter((row) => row.matchedKeyword).sort((a, b) => b._count._all - a._count._all).slice(0, 8).map((row) => ({ keyword: row.matchedKeyword, count: row._count._all })),
    recentLogs: recentLogs.map((log) => ({ ...log, createdAt: log.createdAt.toISOString() })),
  };
}

async function listPosts(workspaceId: string, instagramAccountId: string, limit: number): Promise<MetisControlResult> {
  const account = await getWorkspaceInstagramAccount(workspaceId, instagramAccountId);
  if (!account) return { status: 404, error: "Instagram account not found" };
  const posts = await getAllUserMedia(decryptToken(account.accessToken), limit);
  return {
    data: posts.map((post) => ({
      id: post.id,
      caption: post.caption ?? null,
      mediaType: post.media_product_type ?? post.media_type,
      mediaUrl: post.thumbnail_url ?? post.media_url ?? null,
      permalink: post.permalink ?? null,
      timestamp: post.timestamp,
    })),
  };
}

async function listLogs(workspaceId: string, command: Extract<MetisControlRequest, { action: "logs:list" }>) {
  const status = command.status && Object.values(DmStatus).includes(command.status as DmStatus) ? command.status as DmStatus : undefined;
  const where = { workspaceId, ...(command.instagramAccountId ? { instagramAccountId: command.instagramAccountId } : {}), ...(status ? { status } : {}) };
  const skip = (command.page - 1) * command.limit;
  const [logs, total] = await Promise.all([
    prisma.dmLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: command.limit, select: { id: true, commenterName: true, commentText: true, matchedKeyword: true, status: true, errorMessage: true, createdAt: true, dmSentAt: true, publicReplySentAt: true, publicReplyError: true, automation: { select: { id: true, name: true } }, instagramAccount: { select: { id: true, username: true } } } }),
    prisma.dmLog.count({ where }),
  ]);
  return { logs: logs.map((log) => ({ ...log, createdAt: log.createdAt.toISOString(), dmSentAt: log.dmSentAt?.toISOString() ?? null, publicReplySentAt: log.publicReplySentAt?.toISOString() ?? null })), pagination: { page: command.page, limit: command.limit, total, totalPages: Math.ceil(total / command.limit) } };
}

async function listInbox(workspaceId: string, instagramAccountId: string): Promise<MetisControlResult> {
  const account = await getWorkspaceInstagramAccount(workspaceId, instagramAccountId);
  if (!account) return { status: 404, error: "Instagram account not found" };
  const raw = await getConversations(decryptToken(account.accessToken), account.instagramId);
  return { data: raw.map((conversation) => {
    const participants = conversation.participants?.data ?? [];
    const contact = participants.find((item) => item.id !== account.instagramId) ?? participants[0] ?? null;
    const last = conversation.messages?.data?.[0] ?? null;
    return { id: conversation.id, contact: { id: contact?.id ?? "", username: contact?.username ?? null }, updatedTime: conversation.updated_time ?? null, lastMessage: last ? { text: last.message ?? "", fromMe: last.from?.id === account.instagramId, createdTime: last.created_time ?? null } : null };
  }) };
}

async function inboxThread(workspaceId: string, instagramAccountId: string, conversationId: string): Promise<MetisControlResult> {
  const account = await getWorkspaceInstagramAccount(workspaceId, instagramAccountId);
  if (!account) return { status: 404, error: "Instagram account not found" };
  const raw = await getConversationMessages(decryptToken(account.accessToken), conversationId);
  return { data: raw.map((message) => ({ id: message.id, text: message.message ?? "", fromMe: message.from?.id === account.instagramId, fromUsername: message.from?.username ?? null, createdTime: message.created_time ?? null })).reverse() };
}

async function sendInbox(workspaceId: string, instagramAccountId: string, recipientId: string, text: string): Promise<MetisControlResult> {
  const account = await getWorkspaceInstagramAccount(workspaceId, instagramAccountId);
  if (!account) return { status: 404, error: "Instagram account not found" };
  try {
    return { data: await sendDirectMessage(decryptToken(account.accessToken), account.instagramId, recipientId, text) };
  } catch (error) {
    return { status: 502, error: error instanceof MetaApiError ? error.message : "Failed to send message" };
  }
}

async function diagnostics(workspaceId: string) {
  const [queueCounts, workerHealth, workerAlerts, webhookFailures, dmFailures, operationalEvents] = await Promise.all([
    getDMQueue().getJobCounts("waiting", "active", "delayed", "failed"),
    getWorkerHealth(),
    getWorkerAlerts(10),
    prisma.webhookEvent.findMany({ where: { workspaceId, status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, object: true, errorMessage: true, createdAt: true } }),
    prisma.dmLog.findMany({ where: { workspaceId, status: { in: ["FAILED", "SKIPPED_RATE_LIMIT", "SKIPPED_PLAN_LIMIT", "SKIPPED_NO_MATCH"] } }, orderBy: { updatedAt: "desc" }, take: 10, select: { id: true, status: true, commentText: true, errorMessage: true, updatedAt: true, automation: { select: { name: true } } } }),
    prisma.operationalEvent.findMany({ where: { OR: [{ workspaceId }, { workspaceId: null }] }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, source: true, level: true, message: true, createdAt: true, resolvedAt: true } }),
  ]);
  return { queueCounts, workerHealth, workerAlerts, webhookFailures, dmFailures, operationalEvents };
}

export async function executeMetisControl(workspaceId: string, command: MetisControlRequest): Promise<MetisControlResult> {
  switch (command.action) {
    case "dashboard": return { data: await dashboard(workspaceId, command.instagramAccountId) };
    case "campaigns:list": return { data: await listCampaigns(workspaceId, command.instagramAccountId) };
    case "campaigns:create": return createCampaign(workspaceId, command.campaign);
    case "campaigns:update": return updateCampaign(workspaceId, command.campaign);
    case "campaigns:delete": {
      const deleted = await prisma.automation.deleteMany({ where: { id: command.campaignId, workspaceId } });
      return deleted.count === 1 ? { data: { id: command.campaignId } } : { status: 404, error: "Campaign not found" };
    }
    case "templates:list": return { data: CAMPAIGN_TEMPLATES };
    case "accounts:list": {
      const accounts = await prisma.instagramAccount.findMany({ where: { workspaceId }, orderBy: { connectedAt: "desc" }, select: { id: true, username: true, name: true, instagramId: true, tokenExpiresAt: true, webhookSubscribed: true, connectedAt: true } });
      return { data: accounts.map((account) => ({ ...account, tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null, connectedAt: account.connectedAt.toISOString() })) };
    }
    case "accounts:disconnect": {
      const deleted = await prisma.instagramAccount.deleteMany({ where: { id: command.instagramAccountId, workspaceId } });
      return deleted.count === 1 ? { data: { id: command.instagramAccountId } } : { status: 404, error: "Instagram account not found" };
    }
    case "accounts:connect-url": {
      const missing = getMissingInstagramOAuthEnv();
      if (missing.length > 0) return { status: 503, error: "Instagram connection is not configured" };
      const redirectUri = `${getBaseUrl()}/api/instagram/callback`;
      return {
        data: {
          url: getAuthorizationUrl(
            redirectUri,
            createMetisOAuthState(workspaceId),
          ),
        },
      };
    }
    case "posts:list": return listPosts(workspaceId, command.instagramAccountId, command.limit);
    case "logs:list": return { data: await listLogs(workspaceId, command) };
    case "inbox:list": return listInbox(workspaceId, command.instagramAccountId);
    case "inbox:thread": return inboxThread(workspaceId, command.instagramAccountId, command.conversationId);
    case "inbox:send": return sendInbox(workspaceId, command.instagramAccountId, command.recipientId, command.text);
    case "diagnostics": return { data: await diagnostics(workspaceId) };
  }
}
