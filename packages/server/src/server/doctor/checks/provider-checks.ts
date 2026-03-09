import { execFileSync } from "node:child_process";

import type { DoctorCheckResult } from "../types.js";

interface ProviderDef {
  name: string;
  command: string;
  label: string;
}

const PROVIDERS: ProviderDef[] = [
  { name: "claude", command: "claude", label: "Claude CLI" },
  { name: "codex", command: "codex", label: "Codex CLI" },
  { name: "opencode", command: "opencode", label: "OpenCode CLI" },
];

function whichCommand(command: string): string | null {
  try {
    return execFileSync("which", [command], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function getVersion(binaryPath: string): string | null {
  try {
    return execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function checkBinary(provider: ProviderDef): DoctorCheckResult {
  const binaryPath = whichCommand(provider.command);
  if (binaryPath) {
    return {
      id: `provider.${provider.name}.binary`,
      label: provider.label,
      status: "ok",
      detail: binaryPath,
    };
  }
  return {
    id: `provider.${provider.name}.binary`,
    label: provider.label,
    status: "error",
    detail: "Not found in PATH",
  };
}

function checkVersion(provider: ProviderDef): DoctorCheckResult {
  const binaryPath = whichCommand(provider.command);
  if (!binaryPath) {
    return {
      id: `provider.${provider.name}.version`,
      label: `${provider.label} version`,
      status: "error",
      detail: "Binary not found",
    };
  }

  const version = getVersion(binaryPath);
  if (version) {
    return {
      id: `provider.${provider.name}.version`,
      label: `${provider.label} version`,
      status: "ok",
      detail: version,
    };
  }

  return {
    id: `provider.${provider.name}.version`,
    label: `${provider.label} version`,
    status: "warn",
    detail: "Installed but version could not be parsed",
  };
}

export async function runProviderChecks(): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];
  for (const provider of PROVIDERS) {
    results.push(checkBinary(provider));
    results.push(checkVersion(provider));
  }
  return results;
}
