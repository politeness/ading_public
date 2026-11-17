import { log } from "../orchestration/diagnostics";
import { realpath, rmdir } from "node:fs/promises";
import { removeOwnSessionEntry } from "./session-discard";
import path from "node:path";
import os from "node:os";
import { removeManagedBlock, writeManagedBlock } from "../skills/block";
import { removeSkillDirs, writeSkillDirs } from "../skills/skill-dir";
import { skillRootMayExist, StreamJsonAgent } from "./cli-agent";
import type { SkillTarget } from "../skills/target";
import type { AgentRuntimeConfig, TurnInput, VerifyResult } from "./types";
import {qoderNativeSettings,qoderFastSettings} from "./qoder-config";
import {qoderCliModel} from "./qoder-desktop-config";
import {handshakeArgs,handshakeCommand,withHandshakeDirectory,type OneShotAsk} from "./handshake";
import { tm } from "../i18n";
import { p } from "../prompt-language";

class QoderModelUnavailableError extends Error {}

/**
 * Qoder CLI.
 *
 * The command line nearly copies Claude Code, with only these differences:
 *   1. Permission modes use underscores (bypass_permissions / dont_ask)
 *   2. There's an explicit --cwd; we set the child cwd too, but passing both is safer
 *   3. Qoder 1.1.41 lacks Claude's --verbose flag
 *
 * Skills go to AGENTS.md — that's Qoder's project instructions file (the context.fileName default).
 * It's the same file as codex's, so the sync layer dedupes by target file and writes each file only once.
 */
/** `--list-models` prints a MODEL header, then one name per line; custom models are `name (modelID)` and are selected by ID. */
export function parseQoderModels(stdout:string):AgentModelOption[] {
  return stdout.split("\n").map(line=>line.trim()).filter(line=>line&&line!=="MODEL").map(line=>{
    const custom=/^(.+?)\s+\(([^()\s]+)\)$/.exec(line);
    return custom ? {id:custom[2],label:custom[1]} : {id:line,label:line};
  });
}

export class QoderAdapter extends StreamJsonAgent {
  async verify(agent: DiscoveredAgent, app?: AgentRuntimeConfig): Promise<VerifyResult> {
    try { return await super.verify(agent,app); }
    catch(error) {
      if(!(error instanceof QoderModelUnavailableError))throw error;
      return {ok:false,text:error.message,recovery:{
        action:'login',label:tm("svc.agent.qoderSyncLabel"),statusText:tm("svc.agent.qoderSyncStatus"),
        message:tm("svc.agent.qoderSyncMessage",{label:this.label})
      }};
    }
  }

  loginAuthorizationUrl(line: string): string | undefined {
    const candidate=line.trim();
    try {
      const url=new URL(candidate);
      const host=this.kind==='qoder-cn'?'qoder.cn':'qoder.com';
      if(url.protocol==='https:'&&url.hostname===host&&!url.port&&!url.username&&!url.password&&
          url.pathname==='/device/selectAccounts'&&url.searchParams.has('challenge')&&url.searchParams.has('nonce'))return url.href;
    } catch { /* Ordinary login progress, not an authorization URL. */ }
    return undefined;
  }
  protected async readNativeConfiguration(_agent:DiscoveredAgent,workspacePath:string) {
    const {model,reasoningEffort,fastMode,source}=qoderNativeSettings(this.kind,workspacePath);
    // Same rule as every other adapter: an empty read is not a configuration.
    if(model===undefined&&reasoningEffort===undefined&&fastMode===undefined)return undefined;
    return {model,reasoningEffort,fastMode,source:`${this.label} ${source}`};
  }
  readonly kind: AgentKind = "qoder";
  protected readonly binary: string = "qoder";
  // The npm package @qoder-ai/qodercli installs a command named qodercli; it must also be found under Homebrew/nvm prefixes
  protected readonly binaryAliases: string[] = ["qodercli"];
  // Qoder CLIs validate MCP arguments client-side and send `jobs` as a JSON string.
  protected readonly lenientParallelSchema: boolean = true;
  readonly label: string = "Qoder";
  readonly installHint: string = "npm install -g @qoder-ai/qodercli";
  readonly loginHint: string = "qoder login";
  readonly logoutHint: string | undefined = undefined;
  readonly docsUrl: string = "https://docs.qoder.com/cli/overview";

  protected extraCandidates(): string[] {
    const home = os.homedir();
    return [
      path.join(home, ".qoder/entry/qoder"),
      path.join(home, ".local/bin/qodercli"),
      path.join(home, ".qoder/bin/qodercli/qodercli")
    ];
  }

  /**
   * Previously seeing Qoder.app here returned "enable ADing integration" and the UI showed "not connected".
   * But Qoder has no switch ADing can enable in one click, so the button only errored and the status was misleading.
   * The desktop app and the CLI are separate components: with no usable CLI, show "CLI not installed" with an install-CLI button.
   * When the app's launcher shim won't run, the reason appears in the hover tooltip via lastDiscoveryFailure.
   */
  async setupNotice(): Promise<AgentSetupNotice | null> {
    return null;
  }

  protected permissionArgs(fullAccess: boolean): string[] {
    return [
      "--permission-mode",
      fullAccess ? "bypass_permissions" : "dont_ask"
    ];
  }

  protected extraArgs(input: TurnInput): string[] {
    return ["--cwd", input.workspacePath,
      // Leaving out the user source drops ~/.qoder/AGENTS.md. Login is not a setting, and the model is pinned below.
      ...(input.isolateMemory ? ["--setting-sources", "project,local"] : []),
      ...(input.runtimeConfig?.model ? ["--model",qoderCliModel(this.kind,input.runtimeConfig.model)] : []),
      ...(input.runtimeConfig?.reasoningEffort ? ["--reasoning-effort",input.runtimeConfig.reasoningEffort] : []),
      ...(typeof input.runtimeConfig?.fastMode==="boolean" ? ["--settings",qoderFastSettings(this.kind,input.workspacePath,input.runtimeConfig.model,input.runtimeConfig.fastMode)] : [])];
  }

  protected async verificationArgs(agent: DiscoveredAgent, cwd: string, help: string, app?: AgentRuntimeConfig, ask?: OneShotAsk): Promise<string[]> {
    const config=await this.initializeConfiguration(agent,cwd,app);
    if(config.notice)throw new Error(config.notice);
    // ask must be passed through: without it, askOnce still asks the connectivity check question,
    // and task naming would get back "OK" as the name.
    const args=ask ? handshakeArgs(this.kind,cwd,help,ask) : handshakeArgs(this.kind,cwd,help);
    if(!config.model)return args;
    const model=qoderCliModel(this.kind,config.model);
    if(config.model.startsWith('byok:')){
      if(!help.includes('--list-models'))throw new Error(p('当前 Qoder CLI 不支持自定义模型检测，请更新 CLI', "The current Qoder CLI doesn't support custom model detection; please update the CLI"));
      // Unknown --model values silently fall back to an official model in Qoder.
      // Check the CLI account's catalog before interpreting any quota failure.
      const listed=await this.runner.run(`${agent.localUuid}::verify`,{
        ...handshakeCommand(agent.executablePath,[...args,'--list-models']),
        cwd,label:this.label,backgroundPriority:true,timeoutMs:15_000,onLine:()=>undefined
      });
      if(listed.failure)throw new Error(listed.failure);
      const available=listed.stdout.split('\n').some(line=>line.trim()===model||line.trim().endsWith(`(${model})`));
      if(!available)throw new QoderModelUnavailableError(p(`${this.label} CLI 未找到当前自定义模型，请同步原应用账号后重试`, `${this.label} CLI didn't find the current custom model; sync the original app's account and try again`));
    }
    return [...args,'--model',model];
  }

  listModels(agent: DiscoveredAgent): Promise<AgentModelOption[]> {
    return withHandshakeDirectory(this.kind, async cwd => {
      const listed = await this.runner.run(`${agent.localUuid}::models`, {
        ...handshakeCommand(agent.executablePath, ["--list-models"]),
        cwd, label: this.label, backgroundPriority: true, timeoutMs: 20_000, onLine: () => undefined
      });
      if (listed.failure) throw new Error(listed.failure);
      return parseQoderModels(listed.stdout);
    });
  }

  protected streamDetailArgs(): string[] {
    return [];
  }

  /** Headless runs keep auto memory off unless the environment turns it on, and ADing may inherit that environment. */
  protected turnEnvironment(input: TurnInput): NodeJS.ProcessEnv | undefined {
    if (!input.isolateMemory) return undefined;
    const prefix = this.kind === "qoder-cn" ? "QODERCN_" : "QODER_";
    return { ...process.env, ...Object.fromEntries(["MEMORY_HEADLESS", "MEMORY_USER", "MEMORY_PROJECT", "DREAM"].map(name => [prefix + name, "false"])) };
  }

  protected get configDir(): string { return process.env.QODER_CONFIG_DIR || path.join(os.homedir(), ".qoder"); }

  /** Qoder has no switch for its per-session debug log, so a turn that must leave no record removes its own afterwards. */
  protected async executeTurn(agent: DiscoveredAgent, input: TurnInput): Promise<AgentTurnOutcome> {
    const outcome = await super.executeTurn(agent, input);
    if (input.noSessionPersistence && !input.threadId && outcome.threadId) await this.discardSessionLog(outcome.threadId, input.workspacePath);
    return outcome;
  }

  private async discardSessionLog(sessionId: string, workspacePath: string): Promise<void> {
    try {
      const root = path.join(this.configDir, "logs", "sessions", (await realpath(workspacePath)).replace(/[^A-Za-z0-9]/g, "-"));
      const removed = await removeOwnSessionEntry(root, sessionId, "directory");
      if (removed) await rmdir(root).catch(() => undefined);
      await log("session-log-discarded", { kind: this.kind, sessionId, removed });
    } catch (error) {
      await log("session-log-discard-failed", { kind: this.kind, sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async resolveSkillTarget(scope: Scope, workspacePath: string): Promise<SkillTarget | null> {
    const home = path.join(os.homedir(), ".qoder");
    const base = scope === "workspace" ? workspacePath : home;
    if (!(await skillRootMayExist(base))) return null;
    const dirPath = scope === "workspace" ? path.join(base, ".qoder", "skills") : path.join(base, "skills");
    return { agentKind: this.kind, scope, style: "skill-dir", dirPath,
      compatibilityFilePath: path.join(base, "AGENTS.md"),
      humanNote: p(`同步完整技能包到 ${dirPath}`, `Syncs complete skill packages to ${dirPath}`) };
  }

  async syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]> {
    if (target.style === "managed-block" && target.filePath) {
      await writeManagedBlock(target.filePath, skills, { ownerFingerprint: target.ownerFingerprint }); return [target.filePath];
    }
    if (!target.dirPath) return [];
    return writeSkillDirs(target.dirPath, skills, { ownerFingerprint: target.ownerFingerprint });
  }

  async unsyncSkills(target: SkillTarget): Promise<string[]> {
    const cleared = target.dirPath ? await removeSkillDirs(target.dirPath, { ownerFingerprint: target.ownerFingerprint }) : [];
    const file = target.compatibilityFilePath ?? target.filePath;
    if (file && await removeManagedBlock(file, { ownerFingerprint: target.ownerFingerprint })) cleared.push(file);
    return cleared;
  }
}
