import { NextRequest, NextResponse } from "next/server";
import { softDisconnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const instagramAccountId =
    typeof body.instagramAccountId === "string"
      ? body.instagramAccountId.trim()
      : "";

  if (!instagramAccountId || instagramAccountId.length > 128) {
    return NextResponse.json(
      { success: false, error: "Instagram account id is required" },
      { status: 400 }
    );
  }

  const disconnected = await softDisconnectInstagramAccount(
    context.workspaceId,
    instagramAccountId,
  );
  if (disconnected.count !== 1) {
    return NextResponse.json(
      { success: false, error: "Instagram account not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
