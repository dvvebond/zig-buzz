import { describe, expect, it } from "vitest";

import { parseMediaTags } from "./media";

describe("message media metadata", () => {
  it("deduplicates safe media and classifies extension fallbacks", () => {
    expect(
      parseMediaTags([
        [
          "imeta",
          "url https://cdn.example/image.webp",
          "dim 1200x800",
          "alt First",
        ],
        [
          "imeta",
          "url https://cdn.example/image.webp",
          "m image/webp",
          "alt Final",
        ],
        [
          "imeta",
          "url https://cdn.example/video.mp4",
          "image https://cdn.example/poster.jpg",
        ],
      ]),
    ).toEqual([
      {
        alt: "Final",
        kind: "image",
        mimeType: "image/webp",
        url: "https://cdn.example/image.webp",
      },
      {
        kind: "video",
        posterUrl: "https://cdn.example/poster.jpg",
        url: "https://cdn.example/video.mp4",
      },
    ]);
  });

  it("rejects unsafe URLs", () => {
    expect(
      parseMediaTags([["imeta", "url javascript:alert(1)", "m image/png"]]),
    ).toEqual([]);
  });
});
