import type { NextRequest } from "next/server";
import { createMetisBridgeHandler } from "@/lib/integrations/metis-bridge";
import {
  listMetisCampaigns,
  setMetisCampaignActive,
} from "@/lib/integrations/metis-bridge-data";

export const dynamic = "force-dynamic";

const handler = createMetisBridgeHandler({
  token: process.env.METIS_INTEGRATION_TOKEN,
  workspaceId: process.env.METIS_OPENREPLY_WORKSPACE_ID,
  listCampaigns: listMetisCampaigns,
  setCampaignActive: setMetisCampaignActive,
});

export async function GET(request: NextRequest) {
  return handler(request);
}

export async function PATCH(request: NextRequest) {
  return handler(request);
}
