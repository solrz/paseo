import { describe, expect, it } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/utils/workspace-tab-identity";

describe("workspace preview tab identity", () => {
  it("normalizes preview targets", () => {
    expect(
      normalizeWorkspaceTabTarget({ kind: "preview", url: " http://localhost:5173 " }),
    ).toEqual({
      kind: "preview",
      url: "http://localhost:5173",
    });
  });

  it("builds deterministic preview tab ids", () => {
    expect(
      buildDeterministicWorkspaceTabId({ kind: "preview", url: "http://localhost:5173" }),
    ).toBe("preview_http%3A%2F%2Flocalhost%3A5173");
  });

  it("compares preview targets by url", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "preview", url: "http://localhost:5173" },
        { kind: "preview", url: "http://localhost:5173" },
      ),
    ).toBe(true);
    expect(
      workspaceTabTargetsEqual(
        { kind: "preview", url: "http://localhost:5173" },
        { kind: "preview", url: "http://localhost:3000" },
      ),
    ).toBe(false);
  });
});
