import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("provider history compatibility boundary", () => {
  test("session runtime code does not directly hydrate provider history", () => {
    const sessionSource = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
    const compatibilitySource = readFileSync(
      new URL("./provider-history-compatibility-service.ts", import.meta.url),
      "utf8",
    );

    expect(sessionSource).not.toMatch(/hydrateTimelineFromProvider\s*\(/);
    expect(compatibilitySource).not.toMatch(/hydrateTimelineFromProvider\s*\(/);
  });
});
