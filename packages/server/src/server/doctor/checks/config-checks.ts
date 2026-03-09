import { loadPersistedConfig } from "../../persisted-config.js";
import type { DoctorCheckResult } from "../types.js";

/**
 * Validate that a listen string is parseable as a valid listen target.
 * Inline check to avoid importing from bootstrap.ts (which has heavy transitive deps).
 */
function isValidListenString(listen: string): boolean {
  // Named pipe
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) return true;
  // Unix socket
  if (listen.startsWith("/") || listen.startsWith("~") || listen.includes(".sock")) return true;
  if (listen.startsWith("unix://")) return true;
  // TCP host:port
  if (listen.includes(":")) {
    const port = parseInt(listen.split(":")[1]!, 10);
    return Number.isFinite(port);
  }
  // Just a port
  return Number.isFinite(parseInt(listen, 10));
}

function checkConfigValid(paseoHome: string): DoctorCheckResult {
  try {
    loadPersistedConfig(paseoHome);
    return {
      id: "config.valid",
      label: "Config file",
      status: "ok",
      detail: "Valid",
    };
  } catch (err) {
    return {
      id: "config.valid",
      label: "Config file",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkListenAddress(paseoHome: string): DoctorCheckResult {
  try {
    const config = loadPersistedConfig(paseoHome);
    const listen = config.daemon?.listen ?? "127.0.0.1:6767";
    if (!isValidListenString(listen)) {
      return {
        id: "config.listen",
        label: "Listen address",
        status: "error",
        detail: `Malformed listen address: ${listen}`,
      };
    }
    return {
      id: "config.listen",
      label: "Listen address",
      status: "ok",
      detail: listen,
    };
  } catch (err) {
    return {
      id: "config.listen",
      label: "Listen address",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runConfigChecks(paseoHome: string): Promise<DoctorCheckResult[]> {
  return [checkConfigValid(paseoHome), checkListenAddress(paseoHome)];
}
