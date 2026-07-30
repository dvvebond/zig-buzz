import { describe, expect, it } from "vitest";
import { personalityTarget, usage } from "./index.js";

describe("Sprig", () => {
  it("maps built TypeScript personalities and rejects unknown names", () => {
    expect(personalityTarget("buzz-agent")).toMatch(
      /packages\/agent\/dist\/main\.js$/,
    );
    expect(personalityTarget("unknown")).toBeUndefined();
    expect(usage()).toContain("git-sign-nostr");
  });
});
