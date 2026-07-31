import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Jimp } from "jimp";
import { describe, expect, it } from "vitest";

import { viewImageTool } from "./image.js";

describe("viewImageTool", () => {
  it("returns a bounded PNG image payload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "buzz-image-test-"));
    const file = path.join(directory, "pixel.png");
    const source = await new Jimp({
      color: 0xff3366ff,
      height: 2,
      width: 2,
    }).getBuffer("image/png");
    await writeFile(file, source);

    const result = await viewImageTool({ source: file });

    expect(result.type).toBe("image");
    expect(result.mimeType).toBe("image/png");
    expect(Buffer.from(result.data, "base64")).toEqual(Buffer.from(source));
  });

  it("rejects dimension bombs before decoding", async () => {
    const source = Buffer.from(
      await new Jimp({
        color: 0x000000ff,
        height: 2,
        width: 2,
      }).getBuffer("image/png"),
    );
    source.writeUInt32BE(100_000, 16);
    source.writeUInt32BE(100_000, 20);
    const dataUrl = `data:image/png;base64,${source.toString("base64")}`;

    await expect(viewImageTool({ source: dataUrl })).rejects.toThrow(
      /64 megapixels/,
    );
  });

  it("rejects animated formats and unsupported URL schemes", async () => {
    const gif = Buffer.from("GIF89a0000", "ascii").toString("base64");
    await expect(
      viewImageTool({ source: `data:image/gif;base64,${gif}` }),
    ).rejects.toThrow(/animated images/);
    await expect(
      viewImageTool({ source: "file:///tmp/private.png" }),
    ).rejects.toThrow(/unsupported URL scheme/);
  });
});
