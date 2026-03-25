import type pino from "pino";

import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentPersistenceHandle, AgentSessionConfig } from "./agent/agent-sdk-types.js";
import type { AgentSnapshotStore } from "./agent/agent-snapshot-store.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  toAgentPersistenceHandle,
} from "./persistence-hooks.js";

const pendingAgentBootstrapLoads = new Map<string, Promise<ManagedAgent>>();

export type ProviderHistoryCompatibilityServiceOptions = {
  agentManager: Pick<
    AgentManager,
    | "createAgent"
    | "getAgent"
    | "reloadAgentSession"
    | "resumeAgentFromPersistence"
  >;
  agentStorage: Pick<AgentSnapshotStore, "get">;
  logger: pino.Logger;
};

// Compatibility-only bridge for runtime paths that still need coordinated cold
// load, explicit resume, or refresh behavior.
export class ProviderHistoryCompatibilityService {
  private readonly agentManager: ProviderHistoryCompatibilityServiceOptions["agentManager"];
  private readonly agentStorage: ProviderHistoryCompatibilityServiceOptions["agentStorage"];
  private readonly logger: pino.Logger;

  constructor(options: ProviderHistoryCompatibilityServiceOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger.child({ component: "provider-history-compatibility" });
  }

  async ensureAgentLoaded(options: { agentId: string }): Promise<ManagedAgent> {
    const existing = this.agentManager.getAgent(options.agentId);
    if (existing) {
      return existing;
    }

    const inflight = pendingAgentBootstrapLoads.get(options.agentId);
    if (inflight) {
      return inflight;
    }

    const initPromise = this.loadStoredAgent(options);
    pendingAgentBootstrapLoads.set(options.agentId, initPromise);

    try {
      return await initPromise;
    } finally {
      const current = pendingAgentBootstrapLoads.get(options.agentId);
      if (current === initPromise) {
        pendingAgentBootstrapLoads.delete(options.agentId);
      }
    }
  }

  async resumeAgent(options: {
    handle: AgentPersistenceHandle;
    overrides?: Partial<AgentSessionConfig>;
  }): Promise<ManagedAgent> {
    return this.agentManager.resumeAgentFromPersistence(
      options.handle,
      options.overrides,
    );
  }

  async refreshAgent(options: { agentId: string }): Promise<ManagedAgent> {
    const existing = this.agentManager.getAgent(options.agentId);
    if (existing) {
      return existing.persistence
        ? await this.agentManager.reloadAgentSession(options.agentId)
        : existing;
    }

    const record = await this.agentStorage.get(options.agentId);
    if (!record) {
      throw new Error(`Agent not found: ${options.agentId}`);
    }

    const handle = toAgentPersistenceHandle(this.logger, record.persistence);
    if (!handle) {
      throw new Error(`Agent ${options.agentId} cannot be refreshed because it lacks persistence`);
    }

    return this.agentManager.resumeAgentFromPersistence(
      handle,
      buildConfigOverrides(record),
      options.agentId,
      extractTimestamps(record),
    );
  }

  private async loadStoredAgent(options: { agentId: string }): Promise<ManagedAgent> {
    const record = await this.agentStorage.get(options.agentId);
    if (!record) {
      throw new Error(`Agent not found: ${options.agentId}`);
    }

    const handle = toAgentPersistenceHandle(this.logger, record.persistence);
    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await this.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        options.agentId,
        extractTimestamps(record),
      );
      this.logger.info(
        { agentId: options.agentId, provider: record.provider },
        "Agent resumed from persistence",
      );
    } else {
      snapshot = await this.agentManager.createAgent(buildSessionConfig(record), options.agentId, {
        labels: record.labels,
      });
      this.logger.info(
        { agentId: options.agentId, provider: record.provider },
        "Agent created from stored config",
      );
    }

    return this.agentManager.getAgent(options.agentId) ?? snapshot;
  }
}
