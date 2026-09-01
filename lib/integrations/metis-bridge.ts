import { timingSafeEqual } from "crypto";
import { z } from "zod";

export type MetisCampaign = {
  id: string;
  name: string;
  isActive: boolean;
  accountUsername: string;
  keywords: string[];
  matchAnyWord: boolean;
  dmTriggerEnabled: boolean;
  postUrl: string | null;
  matchAnyPost: boolean;
  pendingNextReel: boolean;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
  updatedAt: string;
};

export type MetisBridgeDependencies = {
  token?: string;
  workspaceId?: string;
  listCampaigns(workspaceId: string): Promise<MetisCampaign[]>;
  setCampaignActive(
    workspaceId: string,
    campaignId: string,
    isActive: boolean,
  ): Promise<boolean>;
};

const updateSchema = z.object({
  id: z.string().min(1).max(128),
  isActive: z.boolean(),
});

function authorized(request: Request, token?: string) {
  if (!token || token.length < 32) return false;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createMetisBridgeHandler(dependencies: MetisBridgeDependencies) {
  return async (request: Request): Promise<Response> => {
    if (!dependencies.token || !dependencies.workspaceId) {
      return json({ success: false, error: "Integration not configured" }, 503);
    }
    if (!authorized(request, dependencies.token)) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }

    try {
      if (request.method === "GET") {
        const campaigns = await dependencies.listCampaigns(dependencies.workspaceId);
        return json({ success: true, data: campaigns });
      }

      if (request.method === "PATCH") {
        const parsed = updateSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return json({ success: false, error: "Invalid input" }, 400);
        }
        const updated = await dependencies.setCampaignActive(
          dependencies.workspaceId,
          parsed.data.id,
          parsed.data.isActive,
        );
        if (!updated) return json({ success: false, error: "Campaign not found" }, 404);
        return json({ success: true, data: parsed.data });
      }

      return json({ success: false, error: "Method not allowed" }, 405);
    } catch (error) {
      console.error("Metis bridge failed", error);
      return json({ success: false, error: "Integration unavailable" }, 502);
    }
  };
}
