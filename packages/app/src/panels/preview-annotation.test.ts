import { describe, expect, it } from "vitest";
import {
  findAnnotationTargetAgentId,
  findAnnotationTargetAgentIdInLayout,
} from "@/panels/preview-annotation";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/stores/workspace-tabs-store";

describe("findAnnotationTargetAgentId", () => {
  it("prefers an agent tab other than the preview tab", () => {
    const tabs: WorkspaceTab[] = [
      { tabId: "preview", target: { kind: "preview", url: "http://localhost:5173" }, createdAt: 1 },
      { tabId: "agent_a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 2 },
    ];

    expect(findAnnotationTargetAgentId(tabs, "preview")).toBe("agent-a");
  });

  it("returns null when no agent tab is open", () => {
    const tabs: WorkspaceTab[] = [
      { tabId: "preview", target: { kind: "preview", url: "http://localhost:5173" }, createdAt: 1 },
    ];

    expect(findAnnotationTargetAgentId(tabs, "preview")).toBeNull();
  });
});

describe("findAnnotationTargetAgentIdInLayout", () => {
  it("prefers the focused agent tab in the focused pane", () => {
    const layout = {
      focusedPaneId: "chat-pane",
      root: {
        kind: "group",
        group: {
          id: "root",
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [
            {
              kind: "pane",
              pane: {
                id: "chat-pane",
                tabIds: ["old-agent", "focused-agent"],
                focusedTabId: "focused-agent",
                tabs: [
                  { tabId: "old-agent", target: { kind: "agent", agentId: "old" }, createdAt: 1 },
                  {
                    tabId: "focused-agent",
                    target: { kind: "agent", agentId: "focused" },
                    createdAt: 2,
                  },
                ],
              },
            },
            {
              kind: "pane",
              pane: {
                id: "preview-pane",
                tabIds: ["preview"],
                focusedTabId: "preview",
                tabs: [
                  {
                    tabId: "preview",
                    target: { kind: "preview", url: "http://localhost:5173" },
                    createdAt: 3,
                  },
                ],
              },
            },
          ],
        },
      },
    } as unknown as WorkspaceLayout;

    expect(findAnnotationTargetAgentIdInLayout(layout, "preview")).toBe("focused");
  });
});
