import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/stores/workspace-tabs-store";

export function findAnnotationTargetAgentId(
  tabs: readonly WorkspaceTab[],
  currentTabId: string,
): string | null {
  const otherAgentTab = tabs.find(
    (tab) => tab.tabId !== currentTabId && tab.target.kind === "agent",
  );
  if (otherAgentTab?.target.kind === "agent") {
    return otherAgentTab.target.agentId;
  }

  const anyAgentTab = tabs.find((tab) => tab.target.kind === "agent");
  return anyAgentTab?.target.kind === "agent" ? anyAgentTab.target.agentId : null;
}

export function findAnnotationTargetAgentIdInLayout(
  layout: WorkspaceLayout,
  currentTabId: string,
): string | null {
  const panes = collectLayoutPanes(layout.root);
  const focusedPane = panes.find((pane) => pane.id === layout.focusedPaneId) ?? null;
  const focusedAgentId = findFocusedAgentInPane(focusedPane, currentTabId);
  if (focusedAgentId) {
    return focusedAgentId;
  }

  for (const pane of panes) {
    const agentId = findFocusedAgentInPane(pane, currentTabId);
    if (agentId) {
      return agentId;
    }
  }

  return findAnnotationTargetAgentId(
    panes.flatMap((pane) => pane.tabs),
    currentTabId,
  );
}

interface LayoutPaneWithTabs {
  id: string;
  focusedTabId: string | null;
  tabs: WorkspaceTab[];
}

function collectLayoutPanes(node: WorkspaceLayout["root"]): LayoutPaneWithTabs[] {
  if (node.kind === "pane") {
    return [node.pane as unknown as LayoutPaneWithTabs];
  }
  return node.group.children.flatMap((child) => collectLayoutPanes(child));
}

function findFocusedAgentInPane(
  pane: LayoutPaneWithTabs | null,
  currentTabId: string,
): string | null {
  if (!pane?.focusedTabId || pane.focusedTabId === currentTabId) {
    return null;
  }
  const focusedTab = pane.tabs.find((tab) => tab.tabId === pane.focusedTabId) ?? null;
  return focusedTab?.target.kind === "agent" ? focusedTab.target.agentId : null;
}
