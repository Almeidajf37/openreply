import { z } from "zod";

const remoteId = z.string().regex(/^[0-9]{1,255}$/);
const common = {
  metisOrganizationId: z.string().uuid(),
  openreplyAccountId: z.string().min(1).max(128),
  instagramUserId: remoteId,
  connectionGeneration: z.number().int().positive(),
  jobId: z.string().uuid(),
  attemptReceipt: z.string().uuid(),
  operationKey: z.string().min(1).max(160).regex(/^[a-z0-9:_-]+$/i),
};
const frozenAsset = z.object({
  path: z.string().min(1).max(1024),
  signedUrl: z.string().url().max(4096),
});

export const metisPublishRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("diagnostic"), ...common }),
  z.object({
    action: z.literal("create-container"),
    ...common,
    mode: z.enum(["IMAGE", "CAROUSEL_CHILD", "CAROUSEL_PARENT", "REELS"]),
    caption: z.string().max(2200).optional(),
    asset: frozenAsset.optional(),
    children: z.array(remoteId).min(2).max(10).optional(),
  }).superRefine((value, context) => {
    if (value.mode === "CAROUSEL_PARENT") {
      if (!value.children || value.asset) {
        context.addIssue({ code: "custom", message: "Carousel parent needs children only" });
      }
    } else if (!value.asset || value.children) {
      context.addIssue({ code: "custom", message: "Media container needs one asset" });
    }
  }),
  z.object({
    action: z.literal("container-status"),
    ...common,
    containerId: remoteId,
  }),
  z.object({
    action: z.literal("publish"),
    ...common,
    containerId: remoteId,
  }),
  z.object({
    action: z.literal("media"),
    ...common,
    mediaId: remoteId,
  }),
]);

export type MetisPublishRequest = z.infer<typeof metisPublishRequestSchema>;
