import { timingSafeEqual } from "crypto";
import {
  metisControlRequestSchema,
  type MetisControlRequest,
} from "@/lib/integrations/metis-control-contract";

export type MetisControlResult = {
  status?: number;
  data?: unknown;
  error?: string;
};

export type MetisControlDependencies = {
  token?: string;
  workspaceId?: string;
  execute(workspaceId: string, command: MetisControlRequest): Promise<MetisControlResult>;
};

function isAuthorized(request: Request, token?: string) {
  if (!token || token.length < 32) return false;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createMetisControlHandler(dependencies: MetisControlDependencies) {
  return async (request: Request): Promise<Response> => {
    if (!dependencies.token || !dependencies.workspaceId) {
      return json({ success: false, error: "Integration not configured" }, 503);
    }
    if (!isAuthorized(request, dependencies.token)) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }
    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405);
    }

    const parsed = metisControlRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        { success: false, error: "Invalid input", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      const result = await dependencies.execute(
        dependencies.workspaceId,
        parsed.data,
      );
      const status = result.status ?? (result.error ? 400 : 200);
      return json(
        result.error
          ? { success: false, error: result.error }
          : { success: true, data: result.data },
        status,
      );
    } catch (error) {
      console.error("Metis control bridge failed", error);
      return json({ success: false, error: "Integration unavailable" }, 502);
    }
  };
}
