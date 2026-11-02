import "server-only";

import { getMetaGraphApiVersion } from "@/lib/env";

const DEFAULT_TIMEOUT_MS = 20_000;
const REMOTE_ID = /^[0-9]{1,255}$/;

export type ContainerStatus =
  | "ERROR"
  | "EXPIRED"
  | "FINISHED"
  | "IN_PROGRESS"
  | "PUBLISHED";

export class ContentPublisherError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ContentPublisherError";
  }
}

type PublisherDependencies = {
  accessToken: string;
  instagramUserId: string;
  fetch?: typeof fetch;
  graphBaseUrl?: string;
  timeoutMs?: number;
};

function validId(value: unknown): value is string {
  return typeof value === "string" && REMOTE_ID.test(value);
}

export function createContentPublisher(dependencies: PublisherDependencies) {
  const fetcher = dependencies.fetch ?? fetch;
  const baseUrl = dependencies.graphBaseUrl ??
    `https://graph.instagram.com/${getMetaGraphApiVersion()}`;

  async function request(
    path: string,
    init: {
      method?: "GET" | "POST";
      body?: URLSearchParams;
      query?: Record<string, string>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetcher(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${dependencies.accessToken}`,
          ...(init.body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        body: init.body,
        signal: controller.signal,
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new ContentPublisherError(
          `meta_http_${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ContentPublisherError("meta_invalid_response", false);
      }
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ContentPublisherError) throw error;
      throw new ContentPublisherError(
        controller.signal.aborted ? "meta_request_timeout" : "meta_network_error",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createContainer(input: {
    imageUrl?: string;
    videoUrl?: string;
    caption?: string;
    carouselItem?: boolean;
    childIds?: string[];
  }) {
    const body = new URLSearchParams();
    if (input.imageUrl) body.set("image_url", input.imageUrl);
    if (input.videoUrl) {
      body.set("media_type", "REELS");
      body.set("video_url", input.videoUrl);
    }
    if (input.caption) body.set("caption", input.caption);
    if (input.carouselItem) body.set("is_carousel_item", "true");
    if (input.childIds) {
      if (!input.childIds.every((value) => REMOTE_ID.test(value))) {
        throw new ContentPublisherError("container_children_invalid", false);
      }
      body.set("media_type", "CAROUSEL");
      body.set("children", input.childIds.join(","));
    }
    const payload = await request(
      `${encodeURIComponent(dependencies.instagramUserId)}/media`,
      { method: "POST", body },
    );
    if (!validId(payload.id)) {
      throw new ContentPublisherError("meta_container_id_missing", false);
    }
    return { containerId: payload.id };
  }

  async function getContainerStatus(containerId: string) {
    if (!REMOTE_ID.test(containerId)) {
      throw new ContentPublisherError("container_id_invalid", false);
    }
    const payload = await request(encodeURIComponent(containerId), {
      query: { fields: "status_code" },
    });
    const status = String(payload.status_code);
    if (!["ERROR", "EXPIRED", "FINISHED", "IN_PROGRESS", "PUBLISHED"].includes(status)) {
      throw new ContentPublisherError("meta_container_status_invalid", false);
    }
    return { containerId, status: status as ContainerStatus };
  }

  async function publish(containerId: string) {
    if (!REMOTE_ID.test(containerId)) {
      throw new ContentPublisherError("container_id_invalid", false);
    }
    const body = new URLSearchParams({ creation_id: containerId });
    const payload = await request(
      `${encodeURIComponent(dependencies.instagramUserId)}/media_publish`,
      { method: "POST", body },
    );
    if (!validId(payload.id)) {
      throw new ContentPublisherError("meta_publish_result_ambiguous", false);
    }
    return { mediaId: payload.id };
  }

  async function getPublishedMedia(mediaId: string) {
    if (!REMOTE_ID.test(mediaId)) {
      throw new ContentPublisherError("media_id_invalid", false);
    }
    const payload = await request(encodeURIComponent(mediaId), {
      query: { fields: "id,permalink" },
    });
    if (
      payload.id !== mediaId ||
      typeof payload.permalink !== "string" ||
      payload.permalink.length > 2_048
    ) {
      throw new ContentPublisherError("meta_published_media_invalid", false);
    }
    const permalink = new URL(payload.permalink);
    if (permalink.protocol !== "https:") {
      throw new ContentPublisherError("meta_published_media_invalid", false);
    }
    return { mediaId, permalink: permalink.toString() };
  }

  async function diagnose() {
    await request(
      `${encodeURIComponent(dependencies.instagramUserId)}/content_publishing_limit`,
      { query: { fields: "quota_usage,config" } },
    );
    return { publishingAvailable: true };
  }

  return {
    createContainer,
    getContainerStatus,
    publish,
    getPublishedMedia,
    diagnose,
  };
}
