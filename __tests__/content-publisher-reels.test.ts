import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createContentPublisher } from "@/lib/meta/content-publisher";

describe("Instagram Reel container", () => {
  it("sends media_type REELS and video_url to Meta", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const publisher = createContentPublisher({
      accessToken: "secret-for-test",
      instagramUserId: "178900000000001",
      graphBaseUrl: "https://graph.instagram.com/v25.0",
      fetch: fetcher as typeof fetch,
    });
    await expect(publisher.createContainer({
      videoUrl: "https://media.example.test/video.mp4",
      caption: "Legenda",
    })).resolves.toEqual({ containerId: "123" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v25.0/178900000000001/media");
    expect(options.method).toBe("POST");
    const body = options.body as URLSearchParams;
    expect(body.get("media_type")).toBe("REELS");
    expect(body.get("video_url")).toBe("https://media.example.test/video.mp4");
    expect(body.get("caption")).toBe("Legenda");
    expect(body.has("image_url")).toBe(false);
  });
});
