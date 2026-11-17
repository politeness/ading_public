import path from "node:path";
import { StreamJsonAgent, skillRootMayExist } from "./cli-agent";
import { writeSkillDirs, removeSkillDirs } from "../skills/skill-dir";
import type { SkillTarget } from "../skills/target";
import type { AgentRuntimeConfig, TurnInput, VerifyResult, SteerResult } from "./types";
import { AGENT_PROBE_TIMEOUT_MS, handshakePrompt, withHandshakeDirectory } from "./handshake";
import { p } from "../prompt-language";

/** Reuse CLI discovery/process ownership and the shared ExecutionAgent pipeline.
 * Subclasses replace the stream-json transport, including health checks. */
export abstract class NativeCliAgent extends StreamJsonAgent {
  private readonly probeInputs = new WeakSet<TurnInput>();
  private readonly signedOutInputs = new WeakSet<TurnInput>();
  protected isProbe(input: TurnInput): boolean { return this.probeInputs.has(input); }
  /** Record that this turn failed because the CLI is signed out; probe results carry it as VerifyResult.signedOut. */
  protected markSignedOut(input: TurnInput): void { this.signedOutInputs.add(input); }
  async steer(): Promise<SteerResult> { return { status: "unsupported" }; }
  protected abstract skillDirectories(workspace: string): { user: string; workspace: string };
  protected permissionArgs(): string[] { return []; }
  async resolveSkillTarget(scope: Scope, workspace: string): Promise<SkillTarget | null> {
    const dirPath = this.skillDirectories(workspace)[scope === "workspace" ? "workspace" : "user"];
    const root = scope === "workspace" ? workspace : path.dirname(dirPath);
    if (!await skillRootMayExist(root)) return null;
    return { agentKind: this.kind, scope, style: "skill-dir", dirPath,
      humanNote: p(`同步完整技能包到 ${dirPath}`, `Syncs complete skill packages to ${dirPath}`) };
  }
  syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]> {
    return target.dirPath ? writeSkillDirs(target.dirPath, skills, { ownerFingerprint: target.ownerFingerprint }) : Promise.resolve([]);
  }
  unsyncSkills(target: SkillTarget): Promise<string[]> {
    return target.dirPath ? removeSkillDirs(target.dirPath, { ownerFingerprint: target.ownerFingerprint }) : Promise.resolve([]);
  }
  async verify(agent: DiscoveredAgent, app?: AgentRuntimeConfig): Promise<VerifyResult> {
    return this.probe(agent, handshakePrompt(), app);
  }
  async askOnce(): Promise<VerifyResult> {
    // These CLIs persist native sessions; never create hidden naming sessions.
    return { ok: false, text: p("该 CLI 暂不支持不留会话的内部调用", "This CLI does not support session-free internal calls") };
  }
  private async probe(agent: DiscoveredAgent, prompt: string, app?: AgentRuntimeConfig): Promise<VerifyResult> {
    return withHandshakeDirectory(this.kind, async workspacePath => {
      const runtimeConfig = await this.initializeConfiguration(agent, workspacePath, app);
      if (runtimeConfig.notice) return { ok: false, text: runtimeConfig.notice };
      const input: TurnInput = {
        workspacePath, prompt, runtimeConfig, discussionOnly: true, fullAccess: false,
        timeoutMs: AGENT_PROBE_TIMEOUT_MS, onProgress: () => undefined
      };
      this.probeInputs.add(input);
      const outcome = await this.executeTurn({ ...agent, localUuid: `${agent.localUuid}::verify` }, input);
      return { ok: outcome.ok, text: outcome.ok ? outcome.message : outcome.error,
        ...(!outcome.ok && this.signedOutInputs.has(input) ? { signedOut: true } : {}) };
    });
  }
}

export function assertNoFast(config?: AgentRuntimeConfig): void {
  if (config?.fastMode === true || config?.serviceTier) throw new Error(p(
    "该 CLI 没有对应的 Fast 服务参数，请清除该覆盖配置", "This CLI has no equivalent Fast service option; clear that override"));
}
