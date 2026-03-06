"use dom";

import { useEffect, useMemo, useRef } from "react";
import type { DOMProps } from "expo/dom";
import "@xterm/xterm/css/xterm.css";
import type { ITheme } from "@xterm/xterm";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import { TerminalEmulatorRuntime } from "../terminal/runtime/terminal-emulator-runtime";
import { focusWithRetries } from "../utils/web-focus";
import {
  summarizeTerminalText,
  terminalDebugLog,
} from "../terminal/runtime/terminal-debug";

function buildXtermThemeKey(theme: ITheme): string {
  const values: Array<string> = [
    theme.background,
    theme.foreground,
    theme.cursor,
    theme.cursorAccent,
    theme.selectionBackground,
    theme.selectionForeground,
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ].map((value) => (typeof value === "string" ? value : ""));

  return values.join("|");
}

interface TerminalEmulatorProps {
  dom?: DOMProps;
  streamKey: string;
  initialOutputText: string;
  initialOutputChunkSequence?: number;
  outputChunkText: string;
  outputChunkSequence: number;
  outputChunkReplay?: boolean;
  testId?: string;
  xtermTheme?: ITheme;
  swipeGesturesEnabled?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onInput?: (data: string) => Promise<void> | void;
  onResize?: (input: { rows: number; cols: number }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  onOutputChunkConsumed?: (sequence: number) => Promise<void> | void;
  pendingModifiers?: PendingTerminalModifiers;
  focusRequestToken?: number;
  resizeRequestToken?: number;
}

declare global {
  interface Window {}
}

export default function TerminalEmulator({
  streamKey,
  initialOutputText,
  initialOutputChunkSequence = 0,
  outputChunkText,
  outputChunkSequence,
  outputChunkReplay = false,
  testId = "terminal-surface",
  xtermTheme = {
    background: "#0b0b0b",
    foreground: "#e6e6e6",
    cursor: "#e6e6e6",
  },
  swipeGesturesEnabled = false,
  onSwipeLeft,
  onSwipeRight,
  onInput,
  onResize,
  onTerminalKey,
  onPendingModifiersConsumed,
  onOutputChunkConsumed,
  pendingModifiers = { ctrl: false, shift: false, alt: false },
  focusRequestToken = 0,
  resizeRequestToken = 0,
}: TerminalEmulatorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<TerminalEmulatorRuntime | null>(null);
  const appliedChunkSequenceRef = useRef(0);
  const mountedThemeRef = useRef<ITheme>(xtermTheme);
  const themeKey = useMemo(() => buildXtermThemeKey(xtermTheme), [xtermTheme]);

  useEffect(() => {
    mountedThemeRef.current = xtermTheme;
    runtimeRef.current?.setTheme({ theme: xtermTheme });
  }, [themeKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !swipeGesturesEnabled) {
      return;
    }

    const SWIPE_MIN_PX = 22;
    const VERTICAL_CANCEL_PX = 12;
    const HORIZONTAL_DOMINANCE_RATIO = 1.2;

    let tracking = false;
    let activePointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const reset = () => {
      tracking = false;
      activePointerId = null;
      startX = 0;
      startY = 0;
      fired = false;
    };

    const shouldTreatAsVertical = (dx: number, dy: number) => {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDy < VERTICAL_CANCEL_PX) {
        return false;
      }
      return absDy > absDx;
    };

    const shouldTreatAsHorizontal = (dx: number, dy: number) => {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < SWIPE_MIN_PX) {
        return false;
      }
      if (absDy === 0) {
        return true;
      }
      return absDx / absDy >= HORIZONTAL_DOMINANCE_RATIO;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) {
        return;
      }
      tracking = true;
      fired = false;
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!tracking || fired) {
        return;
      }
      if (activePointerId !== null && event.pointerId !== activePointerId) {
        return;
      }

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      if (shouldTreatAsVertical(dx, dy)) {
        reset();
        return;
      }

      if (!shouldTreatAsHorizontal(dx, dy)) {
        return;
      }

      fired = true;

      if (dx > 0) {
        onSwipeRight?.();
      } else {
        onSwipeLeft?.();
      }

      if (event.cancelable) {
        event.preventDefault();
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (activePointerId !== null && event.pointerId !== activePointerId) {
        return;
      }
      reset();
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (activePointerId !== null && event.pointerId !== activePointerId) {
        return;
      }
      reset();
    };

    root.addEventListener("pointerdown", onPointerDown, { passive: true });
    root.addEventListener("pointermove", onPointerMove, { passive: false });
    root.addEventListener("pointerup", onPointerUp, { passive: true });
    root.addEventListener("pointercancel", onPointerCancel, { passive: true });

    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [onSwipeLeft, onSwipeRight, swipeGesturesEnabled]);

  useEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) {
      return;
    }

    const runtime = new TerminalEmulatorRuntime();
    runtimeRef.current = runtime;
    runtime.setCallbacks({
      callbacks: {
        onInput,
        onResize,
        onTerminalKey,
        onPendingModifiersConsumed,
      },
    });
    runtime.setPendingModifiers({ pendingModifiers });
    runtime.mount({
      root,
      host,
      initialOutputText,
      theme: mountedThemeRef.current,
    });
    appliedChunkSequenceRef.current = Math.max(
      0,
      Math.floor(initialOutputChunkSequence)
    );

    return () => {
      runtime.unmount();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
      appliedChunkSequenceRef.current = 0;
    };
  }, [streamKey]);

  useEffect(() => {
    runtimeRef.current?.setCallbacks({
      callbacks: {
        onInput,
        onResize,
        onTerminalKey,
        onPendingModifiersConsumed,
      },
    });
  }, [onInput, onPendingModifiersConsumed, onResize, onTerminalKey]);

  useEffect(() => {
    runtimeRef.current?.setPendingModifiers({ pendingModifiers });
  }, [pendingModifiers]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (outputChunkSequence <= 0) {
      return;
    }

    if (outputChunkSequence <= appliedChunkSequenceRef.current) {
      terminalDebugLog({
        scope: "emulator-component",
        event: "output:chunk:skip-duplicate",
        details: {
          sequence: outputChunkSequence,
          lastAppliedSequence: appliedChunkSequenceRef.current,
        },
      });
      onOutputChunkConsumed?.(outputChunkSequence);
      return;
    }

    if (!runtime) {
      onOutputChunkConsumed?.(outputChunkSequence);
      return;
    }

    appliedChunkSequenceRef.current = outputChunkSequence;

    if (outputChunkText.length === 0) {
      terminalDebugLog({
        scope: "emulator-component",
        event: "output:chunk:clear",
        details: {
          sequence: outputChunkSequence,
        },
      });
      runtime.clear({
        onCommitted: () => {
          onOutputChunkConsumed?.(outputChunkSequence);
        },
      });
      return;
    }
    terminalDebugLog({
      scope: "emulator-component",
      event: "output:chunk:write",
      details: {
        sequence: outputChunkSequence,
        replay: outputChunkReplay,
        length: outputChunkText.length,
        preview: summarizeTerminalText({ text: outputChunkText, maxChars: 80 }),
      },
    });
    runtime.write({
      text: outputChunkText,
      suppressInput: outputChunkReplay,
      onCommitted: () => {
        onOutputChunkConsumed?.(outputChunkSequence);
      },
    });
  }, [onOutputChunkConsumed, outputChunkReplay, outputChunkSequence, outputChunkText]);

  useEffect(() => {
    if (focusRequestToken <= 0) {
      return;
    }
    return focusWithRetries({
      focus: () => {
        runtimeRef.current?.focus();
      },
      isFocused: () => {
        const root = rootRef.current;
        if (!root) {
          return false;
        }
        const active = typeof document !== "undefined" ? document.activeElement : null;
        return active instanceof HTMLElement && root.contains(active);
      },
    });
  }, [focusRequestToken]);

  useEffect(() => {
    if (resizeRequestToken <= 0) {
      return;
    }
    runtimeRef.current?.resize({ force: true });
  }, [resizeRequestToken]);

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        backgroundColor: xtermTheme.background ?? "#0b0b0b",
        overflow: "hidden",
        overscrollBehavior: "none",
        touchAction: "pan-y",
      }}
      onPointerDown={() => {
        terminalDebugLog({
          scope: "emulator-component",
          event: "surface:pointer-down-focus",
        });
        runtimeRef.current?.focus();
      }}
    >
      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          height: "100%",
          overflow: "hidden",
          overscrollBehavior: "none",
        }}
      />
    </div>
  );
}
