import type { NextRequest } from "next/server";
import { createMetisControlHandler } from "@/lib/integrations/metis-control";
import { executeMetisControl } from "@/lib/integrations/metis-control-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const handler = createMetisControlHandler({
  token: process.env.METIS_INTEGRATION_TOKEN,
  workspaceId: process.env.METIS_OPENREPLY_WORKSPACE_ID,
  execute: executeMetisControl,
});

export async function POST(request: NextRequest) {
  return handler(request);
}
