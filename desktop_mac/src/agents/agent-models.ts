import { tm } from "../i18n";
import type { Store } from "../store/store";
import type { AgentModelRelay } from "../store/agent-model-relay";
import type { AgentModelCache } from "./model-cache";
import { modelSelection } from "./runtime-config";

const MAX_REPORTED_LENGTH = 200;
const reported = (value: string | undefined) => value?.slice(0, MAX_REPORTED_LENGTH);

/**
 * Agent models: the list comes from the CLI on the Agent's computer, and the selection is stored there too (survives rediscovery, takes effect next turn).
 * Agents on other computers of the same account are handled by that computer via AgentModelRelay; borrowed Agents can't be configured.
 */
export class AgentModels {
  private readonly lists = new Map<string, AgentModelOption[]>();

  constructor(private readonly deps: {
    discovered: (userId: string) => DiscoveredAgent | undefined;
    registry: { supportsModelList(kind: AgentKind): boolean; listModels(agent: DiscoveredAgent): Promise<AgentModelOption[]> };
    cache: AgentModelCache;
    store: () => Pick<Store, "getUser" | "currentUser" | "updateAgent">;
    relay: () => AgentModelRelay | undefined;
    /** A local Agent's model state changed: report it again so other computers see it */
    changed: () => void;
    log: (event: string, data: Record<string, unknown>) => unknown;
  }) {}

  async catalog(userId: string): Promise<AgentModelCatalog> {
    if (this.deps.discovered(userId)) return this.localCatalog(userId);
    const remote = await this.remoteTarget(userId);
    if (!remote) return { supported: false, models: [] };
    const current = {
      selected: remote.selected, nativeModel: remote.nativeModel,
      ...(remote.selected ? { selectedLabel: remote.selectedLabel ?? remote.selected } : {})
    };
    if (!remote.online) return { supported: true, models: [], readOnly: true, ...current };
    try {
      const relay = this.deps.relay();
      if (!relay) throw new Error(tm("main.agents.modelRemoteDisconnected"));
      const catalog = await relay.request(userId, { action: "catalog" });
      if (!catalog) throw new Error(tm("main.agents.modelRemoteRejected"));
      if (catalog.models.length || !catalog.selected) return catalog;
      return { ...catalog, selectedLabel: catalog.selected === remote.selected ? current.selectedLabel : catalog.selected };
    } catch (error) {
      return { supported: true, models: [], ...current, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async set(userId: string, modelId: string | null): Promise<UserRef> {
    if (this.deps.discovered(userId)) return this.setLocal(userId, modelId);
    const remote = await this.remoteTarget(userId);
    if (!remote) throw new Error(tm("main.agents.modelNotLocal"));
    if (!remote.online) throw new Error(tm("main.agents.modelRemoteOffline"));
    const relay = this.deps.relay();
    if (!relay) throw new Error(tm("main.agents.modelRemoteDisconnected"));
    await relay.request(userId, { action: "set", modelId });
    return (await this.deps.store().getUser(userId))!;
  }

  async localCatalog(userId: string): Promise<AgentModelCatalog> {
    const found = this.deps.discovered(userId);
    if (!found || !this.deps.registry.supportsModelList(found.kind)) return { supported: false, models: [] };
    const user = await this.deps.store().getUser(userId);
    const base = { selected: user?.modelConfig?.model, nativeModel: found.runtimeDefaults?.model };
    try {
      const models = await this.listed(userId, found);
      return models.length ? { supported: true, models, ...base } : { supported: false, models: [] };
    } catch (error) {
      await this.deps.log("agent-models-failed", { kind: found.kind, error: error instanceof Error ? error.message : String(error) });
      return { supported: true, models: [], ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setLocal(userId: string, modelId: string | null): Promise<UserRef> {
    const found = this.deps.discovered(userId);
    if (!found) throw new Error(tm("main.agents.modelNotLocal"));
    const store = this.deps.store();
    let modelConfig: AgentRuntimeSettings = {};
    if (modelId !== null) {
      // A setting from another computer may arrive right after this computer restarted, before the list is in memory
      const option = (this.lists.get(userId) ?? await this.listed(userId, found)).find(model => model.id === modelId);
      if (!option) throw new Error(tm("main.agents.modelUnavailable", { model: modelId }));
      modelConfig = modelSelection(option, found.runtimeDefaults);
    }
    const user = await store.updateAgent(userId, { modelConfig });
    this.deps.changed();
    return user;
  }

  /** Current model reported with Agent status. Uses only the existing cache; never starts the CLI for this */
  async snapshot(agent: UserRef): Promise<RemoteAgentModel> {
    const selected = agent.modelConfig?.model;
    const native = this.deps.discovered(agent.userId)?.runtimeDefaults?.model;
    const selectedLabel = selected ? await this.deps.cache.label(agent.userId, selected) : undefined;
    const nativeLabel = native ? await this.deps.cache.label(agent.userId, native) : undefined;
    return {
      ...(selected ? { selected: reported(selected) } : {}),
      ...(selectedLabel ? { selectedLabel: reported(selectedLabel) } : {}),
      ...(native ? { nativeModel: reported(nativeLabel ?? native) } : {})
    };
  }

  private async listed(userId: string, found: DiscoveredAgent): Promise<AgentModelOption[]> {
    const cached = await this.deps.cache.get(userId, found.version);
    const models = cached ?? await this.deps.registry.listModels(found);
    if (!models.length) return models;
    this.lists.set(userId, models);
    if (!cached) {
      await this.deps.cache.set(userId, found.version, models);
      // The display name is known only once the list exists; other computers rely on it while this one is offline
      this.deps.changed();
    }
    return models;
  }

  /** Agents on other computers of the same account running a newer client (that has reported model state) */
  private async remoteTarget(userId: string): Promise<(RemoteAgentModel & { online: boolean }) | undefined> {
    const store = this.deps.store();
    const user = await store.getUser(userId);
    if (!user?.remote?.model || !user.kind || !this.deps.registry.supportsModelList(user.kind)) return undefined;
    if ((user.owner ?? (await store.currentUser()).userId) !== (await store.currentUser()).userId) return undefined;
    return { ...user.remote.model, online: user.remote.online };
  }
}
