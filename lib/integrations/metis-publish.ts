import { timingSafeEqual } from "crypto";
import {
  metisPublishRequestSchema,
  type MetisPublishRequest,
} from "@/lib/integrations/metis-publish-contract";

export type MetisPublishResult = {
  status?: number;
  data?: unknown;
  error?: string;
  retryAfterSeconds?: number;
};

type Dependencies = {
  token?: string;
  workspaceId?: string;
  organizationId?: string;
  execute(workspaceId: string, command: MetisPublishRequest): Promise<MetisPublishResult>;
};

function authorized(request: Request, token?: string) {
  if (!token || token.length < 32) return false;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(body: unknown, status: number, retryAfterSeconds?: number) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
    },
  });
}

export function createMetisPublishHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (!dependencies.token || !dependencies.workspaceId || !dependencies.organizationId) {
      return json({ success: false, error: "Integration not configured" }, 503);
    }
    if (!authorized(request, dependencies.token)) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }
    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }
    const parsed = metisPublishRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        { success: false, error: "Invalid input", details: parsed.error.flatten() },
        400,
      );
    }
    if (parsed.data.metisOrganizationId !== dependencies.organizationId) {
      return json({ success: false, error: "Forbidden" }, 403);
    }
    try {
      const result = await dependencies.execute(dependencies.workspaceId, parsed.data);
      return json(
        result.error
          ? { success: false, error: result.error }
          : { success: true, data: result.data },
        result.status ?? (result.error ? 400 : 200),
        result.retryAfterSeconds,
      );
    } catch (error) {
      console.error("Metis publish bridge failed", error);
      return json({ success: false, error: "Integration unavailable" }, 502);
    }
  };
}
