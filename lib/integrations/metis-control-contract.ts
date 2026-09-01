import { z } from "zod";

const campaignPayloadObject = z.object({
    name: z.string().trim().min(1).max(100),
    goal: z.string().trim().min(1).max(120).nullable().optional(),
    instagramAccountId: z.string().min(1).max(128),
    postId: z.string().min(1).max(128).nullable().optional(),
    postUrl: z.string().url().nullable().optional(),
    pendingNextReel: z.boolean().default(false),
    matchAnyPost: z.boolean().default(false),
    keywords: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
    matchAnyWord: z.boolean().default(false),
    dmTriggerEnabled: z.boolean().default(false),
    dmMessage: z.string().trim().min(1).max(1000),
    openingDmEnabled: z.boolean().default(false),
    openingDmMessage: z.string().trim().max(1000).nullable().optional(),
    openingDmButtonLabel: z.string().trim().max(64).nullable().optional(),
    linkButtonLabel: z.string().trim().max(20).nullable().optional(),
    requireFollow: z.boolean().default(false),
    followPromptMessage: z.string().trim().max(1000).nullable().optional(),
    followPromptButtonLabel: z.string().trim().max(20).nullable().optional(),
    followUpEnabled: z.boolean().default(false),
    followUpMessage: z.string().trim().max(1000).nullable().optional(),
    followUpDelayMinutes: z.number().int().min(0).max(1440).default(0),
    publicReplyEnabled: z.boolean().default(false),
    publicReplyMessages: z.array(z.string().trim().max(1000)).max(10).default([]),
    trackedDestinationUrl: z.union([z.string().url(), z.literal("")]).default(""),
    secondaryDestinationUrl: z.union([z.string().url(), z.literal("")]).default(""),
    secondaryButtonLabel: z.string().trim().max(20).nullable().optional(),
    isActive: z.boolean().default(true),
    wholeWordMatch: z.boolean().default(true),
  });

export const campaignPayloadSchema = campaignPayloadObject
  .refine((value) => value.matchAnyPost || value.pendingNextReel || Boolean(value.postId), {
    message: "Choose which post triggers the campaign",
    path: ["postId"],
  })
  .refine((value) => value.matchAnyWord || value.keywords.length > 0, {
    message: "Add a keyword or match any word",
    path: ["keywords"],
  })
  .refine(
    (value) =>
      !value.openingDmEnabled ||
      (Boolean(value.openingDmMessage) && Boolean(value.openingDmButtonLabel)),
    { message: "Opening DM needs a message and button", path: ["openingDmMessage"] },
  );

export const campaignPatchSchema = campaignPayloadObject.partial().extend({
  id: z.string().min(1).max(128),
  reportShareEnabled: z.boolean().optional(),
});

const accountId = z.string().min(1).max(128);
const campaignId = z.string().min(1).max(128);

export const metisControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dashboard"), instagramAccountId: accountId.optional() }),
  z.object({ action: z.literal("campaigns:list"), instagramAccountId: accountId.optional() }),
  z.object({ action: z.literal("campaigns:create"), campaign: campaignPayloadSchema }),
  z.object({ action: z.literal("campaigns:update"), campaign: campaignPatchSchema }),
  z.object({ action: z.literal("campaigns:delete"), campaignId }),
  z.object({ action: z.literal("templates:list") }),
  z.object({ action: z.literal("accounts:list") }),
  z.object({ action: z.literal("accounts:connect-url") }),
  z.object({ action: z.literal("accounts:disconnect"), instagramAccountId: accountId }),
  z.object({
    action: z.literal("posts:list"),
    instagramAccountId: accountId,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    action: z.literal("logs:list"),
    instagramAccountId: accountId.optional(),
    status: z.string().max(40).optional(),
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({ action: z.literal("inbox:list"), instagramAccountId: accountId }),
  z.object({
    action: z.literal("inbox:thread"),
    instagramAccountId: accountId,
    conversationId: z.string().min(1).max(256),
  }),
  z.object({
    action: z.literal("inbox:send"),
    instagramAccountId: accountId,
    recipientId: z.string().min(1).max(256),
    text: z.string().trim().min(1).max(1000),
  }),
  z.object({ action: z.literal("diagnostics") }),
]);

export type MetisControlRequest = z.infer<typeof metisControlRequestSchema>;
export type CampaignPayload = z.infer<typeof campaignPayloadSchema>;
export type CampaignPatch = z.infer<typeof campaignPatchSchema>;
