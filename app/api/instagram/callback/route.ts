import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  getLongLivedToken,
  getUserInfo,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import {
  encryptToken,
  exchangeCodeForToken,
  isMetisOAuthStateForAuthority,
  type OAuthStatePayload,
  verifyOAuthState,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

function resultRedirect(
  baseUrl: string,
  state: OAuthStatePayload | null,
  result: string,
  reason?: string,
) {
  if (state?.source === "metis" && state.intentId) {
    const url = new URL("https://www.metisintelligence.com.br/app");
    url.searchParams.set("channel_intent", state.intentId);
    url.searchParams.set("instagram", result);
    url.hash = "content";
    return NextResponse.redirect(url);
  }
  const url = new URL("/settings", baseUrl);
  url.searchParams.set("instagram", result);
  if (reason) url.searchParams.set("reason", reason.slice(0, 200));
  return NextResponse.redirect(url);
}

async function failMetisIntent(state: OAuthStatePayload | null, code: string) {
  if (
    state?.source !== "metis" ||
    !state.intentId ||
    !state.actorId ||
    !state.metisOrganizationId
  ) return;

  await prisma.metisOAuthIntent.updateMany({
    where: {
      id: state.intentId,
      workspaceId: state.workspaceId,
      actorId: state.actorId,
      metisOrganizationId: state.metisOrganizationId,
      status: "PENDING",
    },
    data: { status: "FAILED", errorCode: code, completedAt: new Date() },
  });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();

  if (
    state?.source === "metis" &&
    !isMetisOAuthStateForAuthority(
      state,
      process.env.METIS_OPENREPLY_WORKSPACE_ID,
      process.env.METIS_INSTAGRAM_ORGANIZATION_ID,
    )
  ) {
    return resultRedirect(baseUrl, state, "invalid");
  }

  if (error) {
    await failMetisIntent(state, "denied");
    return resultRedirect(baseUrl, state, "denied");
  }
  if (!code || !state) {
    await failMetisIntent(state, "invalid");
    return resultRedirect(baseUrl, state, "invalid");
  }

  if (state.source === "metis") {
    const intent = await prisma.metisOAuthIntent.findUnique({
      where: { id: state.intentId! },
    });
    if (
      !intent ||
      intent.workspaceId !== state.workspaceId ||
      intent.actorId !== state.actorId ||
      intent.metisOrganizationId !== state.metisOrganizationId
    ) {
      return resultRedirect(baseUrl, state, "invalid");
    }
    if (intent.status === "COMPLETED") {
      return resultRedirect(baseUrl, state, "connected");
    }
    if (intent.status !== "PENDING" || intent.expiresAt.getTime() <= Date.now()) {
      await failMetisIntent(state, "expired");
      return resultRedirect(baseUrl, state, "expired");
    }
  } else {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);
    const membership = await prisma.workspaceMember.findFirst({
      where: { workspaceId: state.workspaceId, userId: session.user.id },
    });
    if (!membership || !canManageWorkspace(membership.role)) {
      return resultRedirect(baseUrl, state, "forbidden");
    }
  }

  try {
    const redirectUri = `${baseUrl}/api/instagram/callback`;
    const {
      accessToken: shortLivedToken,
      permissions: capabilities,
    } = await exchangeCodeForToken(code, redirectUri);
    const { accessToken: longLivedToken, expiresIn } = await getLongLivedToken(shortLivedToken);
    const userInfo = await getUserInfo(longLivedToken);
    const instagramId = userInfo.user_id ?? userInfo.id;
    const connection = await canConnectInstagramAccount({
      workspaceId: state.workspaceId,
      instagramId,
    });
    if (!connection.allowed) {
      await failMetisIntent(state, "already_connected");
      return resultRedirect(baseUrl, state, "already_connected");
    }

    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        longLivedToken,
      );
      webhookSubscribed = Boolean(subscription.success);
    } catch (subscriptionError) {
      console.warn("[Instagram Callback] Webhook subscription failed", subscriptionError);
    }

    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
    const encryptedToken = encryptToken(longLivedToken);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const account = await tx.instagramAccount.upsert({
        where: { instagramId },
        create: {
          workspaceId: state.workspaceId,
          instagramId,
          username: userInfo.username,
          name: userInfo.name,
          accessToken: encryptedToken,
          tokenExpiresAt,
          webhookSubscribed,
          connectionStatus: "CONNECTED",
          connectionGeneration: 1,
          capabilities,
          connectedAt: now,
        },
        update: {
          workspaceId: state.workspaceId,
          username: userInfo.username,
          name: userInfo.name,
          accessToken: encryptedToken,
          tokenExpiresAt,
          webhookSubscribed,
          connectionStatus: "CONNECTED",
          connectionGeneration: { increment: 1 },
          capabilities,
          disconnectedAt: null,
          connectedAt: now,
        },
      });

      if (state.source === "metis") {
        const completed = await tx.metisOAuthIntent.updateMany({
          where: {
            id: state.intentId!,
            workspaceId: state.workspaceId,
            actorId: state.actorId!,
            metisOrganizationId: state.metisOrganizationId!,
            status: "PENDING",
            expiresAt: { gt: now },
          },
          data: {
            status: "COMPLETED",
            instagramAccountId: account.id,
            completedAt: now,
            errorCode: null,
          },
        });
        if (completed.count !== 1) {
          throw new Error("Connect intent was consumed or expired");
        }
      }
    });

    return state.source === "metis"
      ? resultRedirect(baseUrl, state, "connected")
      : NextResponse.redirect(`${baseUrl}/dashboard?connected=true`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Callback] Error", err);
    await failMetisIntent(state, "callback_failed");
    await prisma.operationalEvent.create({
      data: {
        source: "SYSTEM",
        level: "ERROR",
        workspaceId: state.workspaceId,
        message: "Instagram connection failed",
        payload: { reason: message },
      },
    }).catch(() => {});
    return resultRedirect(baseUrl, state, "failed", message);
  }
}
