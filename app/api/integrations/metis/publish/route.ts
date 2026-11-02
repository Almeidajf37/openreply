import type { NextRequest } from "next/server";
import { createMetisPublishHandler } from "@/lib/integrations/metis-publish";
import { executeMetisPublish } from "@/lib/integrations/metis-publish-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const handler = createMetisPublishHandler({
  token: process.env.METIS_INTEGRATION_TOKEN,
  workspaceId: process.env.METIS_OPENREPLY_WORKSPACE_ID,
  organizationId: process.env.METIS_INSTAGRAM_ORGANIZATION_ID,
  execute: executeMetisPublish,
});

export async function POST(request: NextRequest) {
  return handler(request);
}
