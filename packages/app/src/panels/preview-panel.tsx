import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Globe, RotateCw } from "lucide-react-native";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { isWeb } from "@/constants/platform";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
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

function PreviewPanel() {
  const { target, retargetCurrentTab } = usePaneContext();
  invariant(target.kind === "preview", "PreviewPanel requires preview target");

  const [draftUrl, setDraftUrl] = useState(target.url);
  const [frameKey, setFrameKey] = useState(0);

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
    setFrameKey((current) => current + 1);
  }, []);

  const iframe = useMemo(() => {
    if (!isWeb) {
      return null;
    }
    return React.createElement("iframe", {
      key: frameKey,
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
      </View>
      {isWeb ? (
        <View style={styles.previewFrame}>{iframe}</View>
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
  previewFrame: {
    flex: 1,
    backgroundColor: "white",
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
