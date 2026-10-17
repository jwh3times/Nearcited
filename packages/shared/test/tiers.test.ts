import { describe, expect, it } from "vitest";
import { strongerSurfaces, surfaceWithTier, tierChanges, tierOf } from "../src/tiers";

describe("an organization's tiers", () => {
  it("are Stronger on the assistants it pays for and is checked on, in a fixed order", () => {
    expect(strongerSurfaces({ surfaces: null, stronger_surfaces: ["claude", "chatgpt"] })).toEqual([
      "chatgpt",
      "claude",
    ]);
    // Paid for on one it is not checked on: that one is not asked at all.
    const one = { surfaces: ["claude" as const], stronger_surfaces: ["chatgpt" as const] };
    expect(strongerSurfaces(one)).toEqual([]);
    expect(tierOf(one, "chatgpt")).toBe("standard");
    expect(tierOf({ ...one, stronger_surfaces: ["claude"] }, "claude")).toBe("stronger");
  });

  it("are said beside the assistant's name when they are Stronger", () => {
    expect(surfaceWithTier("chatgpt", "stronger")).toBe("ChatGPT (stronger)");
    expect(surfaceWithTier("claude", "standard")).toBe("Claude");
    expect(surfaceWithTier("claude")).toBe("Claude");
  });
});

describe("tierChanges", () => {
  it("marks the scan where an assistant's tier changed from the last scan that asked it", () => {
    const changes = tierChanges([
      [{ surface: "chatgpt" }, { surface: "claude" }],
      [{ surface: "chatgpt", tier: "standard" }],
      [
        { surface: "chatgpt", tier: "stronger" },
        { surface: "claude", tier: "standard" },
      ],
      [{ surface: "chatgpt", tier: "stronger" }],
      [{ surface: "chatgpt" }, { surface: "claude", tier: "stronger" }],
    ]);
    expect(changes).toEqual([
      [],
      [],
      [{ surface: "chatgpt", tier: "stronger" }],
      [],
      [
        { surface: "chatgpt", tier: "standard" },
        { surface: "claude", tier: "stronger" },
      ],
    ]);
  });

  it("marks nothing at the first scan to ask an assistant", () => {
    expect(tierChanges([[], [{ surface: "claude", tier: "stronger" }]])).toEqual([[], []]);
  });
});
