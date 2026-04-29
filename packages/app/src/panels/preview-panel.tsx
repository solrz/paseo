import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Check, CircleAlert, Globe, Pencil, RotateCw, Trash2, X } from "lucide-react-native";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { persistAttachmentFromBlob } from "@/attachments/service";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import { appendAttachmentToLiveDraft, appendTextToLiveDraft } from "@/hooks/use-agent-input-draft";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import {
  findAnnotationTargetAgentId,
  findAnnotationTargetAgentIdInLayout,
} from "@/panels/preview-annotation";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceTabsStore,
} from "@/stores/workspace-tabs-store";
import type { Theme } from "@/styles/theme";

const iframeStyle: CSSProperties = {
  border: 0,
  width: "100%",
  height: "100%",
  flex: 1,
  backgroundColor: "white",
};

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCheck = withUnistyles(Check);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);
const ThemedCircleAlert = withUnistyles(CircleAlert);

const PREVIEW_CONSOLE_MESSAGE_TYPE = "paseo_preview_console_error";
const MAX_PREVIEW_CONSOLE_ERRORS = 20;
const MONOSPACE_FONT_FAMILY =
  "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

const annotationCanvasStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  cursor: "crosshair",
  touchAction: "none",
  zIndex: 1,
};

function normalizePreviewUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function getPreviewTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  if (canvas.width === width && canvas.height === height) {
    return;
  }
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#ef4444";
  context.lineWidth = 4 * pixelRatio;
}

function getCanvasPoint(canvas: HTMLCanvasElement, event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Unable to load preview screenshot.")), {
      once: true,
    });
    image.src = dataUrl;
  });
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function captureAnnotatedPreviewBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const frame = canvas.parentElement;
  const captureRegion = getDesktopHost()?.window?.getCurrentWindow?.().captureRegion;
  if (!frame || typeof captureRegion !== "function") {
    return await canvasToPngBlob(canvas);
  }

  const toolbar = frame.querySelector<HTMLElement>(
    '[data-testid="workspace-preview-annotation-toolbar"]',
  );
  const previousCanvasVisibility = canvas.style.visibility;
  const previousToolbarVisibility = toolbar?.style.visibility;
  const rect = frame.getBoundingClientRect();

  try {
    canvas.style.visibility = "hidden";
    if (toolbar) {
      toolbar.style.visibility = "hidden";
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const backgroundDataUrl = await captureRegion({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
    const background = await loadImageFromDataUrl(backgroundDataUrl);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = background.naturalWidth || background.width;
    exportCanvas.height = background.naturalHeight || background.height;
    const context = exportCanvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(background, 0, 0, exportCanvas.width, exportCanvas.height);
    context.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
    return await canvasToPngBlob(exportCanvas);
  } finally {
    canvas.style.visibility = previousCanvasVisibility;
    if (toolbar) {
      toolbar.style.visibility = previousToolbarVisibility ?? "";
    }
  }
}

function getAnnotationTargetAgentId(input: {
  serverId: string;
  workspaceId: string;
  tabId: string;
}): string | null {
  const layoutKey = buildWorkspaceTabPersistenceKey(input);
  const layout = layoutKey ? useWorkspaceLayoutStore.getState().layoutByWorkspace[layoutKey] : null;
  const layoutAgentId = layout ? findAnnotationTargetAgentIdInLayout(layout, input.tabId) : null;
  if (layoutAgentId) {
    return layoutAgentId;
  }

  const layoutTabs = layoutKey
    ? useWorkspaceLayoutStore.getState().getWorkspaceTabs(layoutKey)
    : [];
  const tabs =
    layoutTabs.length > 0 ? layoutTabs : useWorkspaceTabsStore.getState().getWorkspaceTabs(input);
  return findAnnotationTargetAgentId(tabs, input.tabId);
}

interface PreviewConsoleError {
  id: string;
  kind: string;
  message: string;
  stack: string | null;
  url: string;
  timestamp: number;
}

function isPreviewConsoleMessage(value: unknown): value is Omit<PreviewConsoleError, "id"> & {
  type: typeof PREVIEW_CONSOLE_MESSAGE_TYPE;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === PREVIEW_CONSOLE_MESSAGE_TYPE &&
    typeof record.kind === "string" &&
    typeof record.message === "string" &&
    (typeof record.stack === "string" || record.stack === null || record.stack === undefined) &&
    typeof record.url === "string" &&
    typeof record.timestamp === "number"
  );
}

function formatPreviewConsoleError(error: PreviewConsoleError): string {
  const lines = [
    `Preview console ${error.kind}`,
    `URL: ${error.url}`,
    `Time: ${new Date(error.timestamp).toLocaleString()}`,
    "",
    error.message,
  ];
  if (error.stack && error.stack !== error.message) {
    lines.push("", error.stack);
  }
  return lines.join("\n");
}

function appendTextToDraft(input: { draftKey: string; text: string }): void {
  if (appendTextToLiveDraft(input.draftKey, input.text)) {
    return;
  }
  const store = useDraftStore.getState();
  const currentDraft = store.getDraftInput(input.draftKey);
  store.saveDraftInput({
    draftKey: input.draftKey,
    draft: {
      text: currentDraft?.text.trim() ? `${currentDraft.text}\n\n${input.text}` : input.text,
      cwd: currentDraft?.cwd ?? "",
      attachments: currentDraft?.attachments ?? [],
    },
  });
}

function PreviewPanel() {
  const { serverId, workspaceId, tabId, target, retargetCurrentTab } = usePaneContext();
  const toast = useToast();
  invariant(target.kind === "preview", "PreviewPanel requires preview target");

  const [draftUrl, setDraftUrl] = useState(target.url);
  const [frameKey, setFrameKey] = useState(0);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [hasAnnotation, setHasAnnotation] = useState(false);
  const [isAttachingAnnotation, setIsAttachingAnnotation] = useState(false);
  const [consoleErrors, setConsoleErrors] = useState<PreviewConsoleError[]>([]);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const isDrawingRef = useRef(false);

  useEffect(() => {
    setDraftUrl(target.url);
  }, [target.url]);

  const previewUrl = target.url;
  const submitUrl = useCallback(() => {
    const nextUrl = normalizePreviewUrl(draftUrl);
    if (!nextUrl || nextUrl === previewUrl) {
      return;
    }
    retargetCurrentTab({ kind: "preview", url: nextUrl });
  }, [draftUrl, previewUrl, retargetCurrentTab]);

  const reloadPreview = useCallback(() => {
    setConsoleErrors([]);
    setFrameKey((current) => current + 1);
  }, []);

  const clearAnnotation = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasAnnotation(false);
  }, []);

  const stopAnnotating = useCallback(() => {
    setIsAnnotating(false);
    setHasAnnotation(false);
    setIsAttachingAnnotation(false);
    isDrawingRef.current = false;
  }, []);

  const toggleAnnotating = useCallback(() => {
    setIsAnnotating((current) => !current);
  }, []);

  const toggleConsole = useCallback(() => {
    setIsConsoleOpen((current) => !current);
  }, []);

  const clearConsoleErrors = useCallback(() => {
    setConsoleErrors([]);
  }, []);

  const appendAnnotationToChat = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasAnnotation || isAttachingAnnotation) {
      return;
    }
    setIsAttachingAnnotation(true);

    const agentId = getAnnotationTargetAgentId({ serverId, workspaceId, tabId });
    if (!agentId) {
      toast.show("Open an agent chat before attaching a preview annotation.", { variant: "error" });
      setIsAttachingAnnotation(false);
      return;
    }

    const blob = await captureAnnotatedPreviewBlob(canvas);
    if (!blob) {
      toast.show("Unable to export preview annotation.", { variant: "error" });
      setIsAttachingAnnotation(false);
      return;
    }

    try {
      const metadata = await persistAttachmentFromBlob({
        blob,
        mimeType: "image/png",
        fileName: "preview-annotation.png",
      });
      const attachment = { kind: "image" as const, metadata };
      const draftKey = buildDraftStoreKey({ serverId, agentId });
      if (!appendAttachmentToLiveDraft(draftKey, attachment)) {
        const store = useDraftStore.getState();
        const currentDraft = store.getDraftInput(draftKey);
        store.saveDraftInput({
          draftKey,
          draft: {
            text: currentDraft?.text ?? "",
            cwd: currentDraft?.cwd ?? "",
            attachments: [...(currentDraft?.attachments ?? []), attachment],
          },
        });
      }
      toast.show("Preview annotation attached to chat.");
      stopAnnotating();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "Unable to attach preview annotation.", {
        variant: "error",
      });
      setIsAttachingAnnotation(false);
    }
  }, [hasAnnotation, isAttachingAnnotation, serverId, stopAnnotating, tabId, toast, workspaceId]);

  const setAnnotationCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (canvas) {
      resizeCanvasToDisplaySize(canvas);
    }
  }, []);

  const attachAnnotationPress = useCallback(() => {
    void appendAnnotationToChat();
  }, [appendAnnotationToChat]);

  const appendConsoleErrorToChat = useCallback(() => {
    const agentId = getAnnotationTargetAgentId({ serverId, workspaceId, tabId });
    if (!agentId) {
      toast.show("Open an agent chat before attaching a preview console error.", {
        variant: "error",
      });
      return;
    }
    const latestError = consoleErrors[0];
    if (!latestError) {
      return;
    }
    appendTextToDraft({
      draftKey: buildDraftStoreKey({ serverId, agentId }),
      text: formatPreviewConsoleError(latestError),
    });
    toast.show("Preview console error attached to chat.");
  }, [consoleErrors, serverId, tabId, toast, workspaceId]);

  const annotateButtonStyle = useMemo(
    () => [styles.reloadButton, isAnnotating ? styles.activeToolbarButton : undefined],
    [isAnnotating],
  );
  const consoleButtonStyle = useMemo(
    () => [
      styles.reloadButton,
      isConsoleOpen ? styles.activeToolbarButton : undefined,
      consoleErrors.length > 0 ? styles.consoleErrorButton : undefined,
    ],
    [consoleErrors.length, isConsoleOpen],
  );
  const annotationActionButtonStyle = useMemo(
    () => [
      styles.annotationButton,
      !hasAnnotation || isAttachingAnnotation ? styles.disabledButton : undefined,
    ],
    [hasAnnotation, isAttachingAnnotation],
  );
  const consoleActionButtonStyle = useMemo(
    () => [styles.annotationButton, consoleErrors.length === 0 ? styles.disabledButton : undefined],
    [consoleErrors.length],
  );

  useEffect(() => {
    if (!isWeb || !isAnnotating) {
      return;
    }
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) {
      return;
    }
    resizeCanvasToDisplaySize(canvas);
    const observer = new ResizeObserver(() => resizeCanvasToDisplaySize(canvas));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [isAnnotating]);

  useEffect(() => {
    if (!isWeb) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (!isPreviewConsoleMessage(event.data)) {
        return;
      }
      const nextError: PreviewConsoleError = {
        id: `${event.data.timestamp}:${Math.random().toString(36).slice(2)}`,
        kind: event.data.kind,
        message: event.data.message,
        stack: event.data.stack ?? null,
        url: event.data.url,
        timestamp: event.data.timestamp,
      };
      setConsoleErrors((current) => [nextError, ...current].slice(0, MAX_PREVIEW_CONSOLE_ERRORS));
      setIsConsoleOpen(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const annotationCanvas = useMemo(() => {
    if (!isWeb || !isAnnotating) {
      return null;
    }
    return React.createElement("canvas", {
      ref: setAnnotationCanvas,
      style: annotationCanvasStyle,
      "aria-label": "Preview annotation canvas",
      onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = event.currentTarget;
        resizeCanvasToDisplaySize(canvas);
        const context = canvas.getContext("2d");
        if (!context) {
          return;
        }
        const point = getCanvasPoint(canvas, event.nativeEvent);
        isDrawingRef.current = true;
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // Some synthetic/test pointer flows do not create an active pointer.
        }
        context.beginPath();
        context.moveTo(point.x, point.y);
      },
      onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingRef.current) {
          return;
        }
        const canvas = event.currentTarget;
        const context = canvas.getContext("2d");
        if (!context) {
          return;
        }
        const point = getCanvasPoint(canvas, event.nativeEvent);
        context.lineTo(point.x, point.y);
        context.stroke();
        setHasAnnotation(true);
      },
      onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => {
        isDrawingRef.current = false;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Ignore pointer capture mismatches from canceled/synthetic events.
        }
      },
      onPointerCancel: () => {
        isDrawingRef.current = false;
      },
    });
  }, [isAnnotating, setAnnotationCanvas]);

  const iframe = useMemo(() => {
    if (!isWeb) {
      return null;
    }
    return React.createElement("iframe", {
      key: frameKey,
      ref: iframeRef,
      src: previewUrl,
      style: iframeStyle,
      title: "App preview",
      // App previews need same-origin storage access for modern dev servers.
      // eslint-disable-next-line react/iframe-missing-sandbox
      sandbox: "allow-forms allow-modals allow-popups allow-same-origin allow-scripts",
    });
  }, [frameKey, previewUrl]);

  return (
    <View style={styles.container} testID="workspace-preview-panel">
      <View style={styles.toolbar}>
        <TextInput
          value={draftUrl}
          onChangeText={setDraftUrl}
          onSubmitEditing={submitUrl}
          onBlur={submitUrl}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          placeholder="http://localhost:5173"
          style={styles.urlInput}
          testID="workspace-preview-url-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reload preview"
          onPress={reloadPreview}
          style={styles.reloadButton}
          testID="workspace-preview-reload"
        >
          <ThemedRotateCw size={16} uniProps={mutedColorMapping} />
        </Pressable>
        {isWeb ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle preview console errors"
              onPress={toggleConsole}
              style={consoleButtonStyle}
              testID="workspace-preview-console-toggle"
            >
              <ThemedCircleAlert size={16} uniProps={mutedColorMapping} />
              {consoleErrors.length > 0 ? (
                <Text style={styles.consoleErrorBadge}>{consoleErrors.length}</Text>
              ) : null}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Annotate preview"
              onPress={toggleAnnotating}
              style={annotateButtonStyle}
              testID="workspace-preview-annotate"
            >
              <ThemedPencil size={16} uniProps={mutedColorMapping} />
            </Pressable>
          </>
        ) : null}
      </View>
      {isWeb ? (
        <View style={styles.previewFrame}>
          {iframe}
          {isConsoleOpen ? (
            <View style={styles.consolePanel} testID="workspace-preview-console-panel">
              <View style={styles.consolePanelHeader}>
                <Text style={styles.consolePanelTitle}>Console errors</Text>
                <View style={styles.consolePanelActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Attach latest preview console error"
                    disabled={consoleErrors.length === 0}
                    onPress={appendConsoleErrorToChat}
                    style={consoleActionButtonStyle}
                    testID="workspace-preview-console-attach"
                  >
                    <Text style={styles.annotationButtonText}>Attach latest</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Clear preview console errors"
                    disabled={consoleErrors.length === 0}
                    onPress={clearConsoleErrors}
                    style={consoleActionButtonStyle}
                    testID="workspace-preview-console-clear"
                  >
                    <Text style={styles.annotationButtonText}>Clear</Text>
                  </Pressable>
                </View>
              </View>
              {consoleErrors.length === 0 ? (
                <Text style={styles.consoleEmptyText}>No console errors captured.</Text>
              ) : (
                consoleErrors.slice(0, 5).map((error) => (
                  <View key={error.id} style={styles.consoleErrorRow}>
                    <Text style={styles.consoleErrorKind}>{error.kind}</Text>
                    <Text style={styles.consoleErrorMessage} numberOfLines={2}>
                      {error.message}
                    </Text>
                  </View>
                ))
              )}
            </View>
          ) : null}
          {annotationCanvas}
          {isAnnotating ? (
            <View style={styles.annotationToolbar} testID="workspace-preview-annotation-toolbar">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Attach preview annotation"
                disabled={!hasAnnotation || isAttachingAnnotation}
                onPress={attachAnnotationPress}
                style={annotationActionButtonStyle}
                testID="workspace-preview-annotation-attach"
              >
                <ThemedCheck size={16} uniProps={mutedColorMapping} />
                <Text style={styles.annotationButtonText}>
                  {isAttachingAnnotation ? "Attaching..." : "Attach"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear preview annotation"
                disabled={!hasAnnotation}
                onPress={clearAnnotation}
                style={annotationActionButtonStyle}
                testID="workspace-preview-annotation-clear"
              >
                <ThemedTrash2 size={16} uniProps={mutedColorMapping} />
                <Text style={styles.annotationButtonText}>Clear</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel preview annotation"
                onPress={stopAnnotating}
                style={styles.annotationButton}
                testID="workspace-preview-annotation-cancel"
              >
                <ThemedX size={16} uniProps={mutedColorMapping} />
                <Text style={styles.annotationButtonText}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.unsupportedState}>
          <Text style={styles.unsupportedTitle}>Preview is available on desktop and web.</Text>
          <Text style={styles.unsupportedBody}>{previewUrl}</Text>
        </View>
      )}
    </View>
  );
}

function usePreviewPanelDescriptor(target: { kind: "preview"; url: string }) {
  return {
    label: "Preview",
    subtitle: getPreviewTitle(target.url),
    titleState: "ready" as const,
    icon: Globe,
    statusBucket: null,
  };
}

export const previewPanelRegistration: PanelRegistration<"preview"> = {
  kind: "preview",
  component: PreviewPanel,
  useDescriptor: usePreviewPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  urlInput: {
    flex: 1,
    minHeight: 32,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    color: theme.colors.foreground,
    backgroundColor: theme.colors.background,
    fontSize: theme.fontSize.sm,
  },
  reloadButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  activeToolbarButton: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.foregroundMuted,
  },
  consoleErrorButton: {
    borderColor: theme.colors.destructive,
  },
  consoleErrorBadge: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    overflow: "hidden",
    paddingHorizontal: 4,
    color: theme.colors.destructiveForeground,
    backgroundColor: theme.colors.destructive,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 16,
  },
  previewFrame: {
    flex: 1,
    backgroundColor: "white",
    position: "relative",
  },
  consolePanel: {
    position: "absolute",
    top: theme.spacing[3],
    left: theme.spacing[3],
    right: theme.spacing[3],
    zIndex: 2,
    maxHeight: 220,
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  consolePanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  consolePanelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "700",
  },
  consolePanelActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  consoleEmptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  consoleErrorRow: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  consoleErrorKind: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    fontWeight: "700",
  },
  consoleErrorMessage: {
    color: theme.colors.foreground,
    fontFamily: MONOSPACE_FONT_FAMILY,
    fontSize: theme.fontSize.xs,
  },
  annotationToolbar: {
    position: "absolute",
    right: theme.spacing[3],
    bottom: theme.spacing[3],
    zIndex: 2,
    flexDirection: "row",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  annotationButton: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.background,
  },
  disabledButton: {
    opacity: 0.45,
  },
  annotationButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  unsupportedState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[2],
  },
  unsupportedTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    textAlign: "center",
  },
  unsupportedBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
