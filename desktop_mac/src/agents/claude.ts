import path from "node:path";
import os from "node:os";
import { readdirSync } from "node:fs";
import { removeSkillDirs, writeSkillDirs } from "../skills/skill-dir";
import { skillRootMayExist, StreamJsonAgent } from "./cli-agent";
import type { SkillTarget } from "../skills/target";
import type {AgentRuntimeConfig, TurnInput} from "./types";
import {readSettingsFile} from "./runtime-config";
import {readClaudeDesktopSelection,readClaudeModels} from "./claude-config";
import { handshakeArgs, withHandshakeDirectory, type OneShotAsk } from "./handshake";
import { p } from "../prompt-language";

/**
 * Claude Code.
 *
 * When an execution turn installs a host approval callback, StreamJsonAgent uses manual + the bidirectional control channel.
 * Read-only/negotiation turns without an approval host use dontAsk, which must not pose as read-only authorization.
 *
 * The working directory is the child process cwd (Claude Code uses the process cwd); no extra argument is passed.
 */
export class ClaudeCodeAdapter extends StreamJsonAgent {
  protected async verificationArgs(agent: DiscoveredAgent, cwd: string, help: string, app?: AgentRuntimeConfig, ask?: OneShotAsk): Promise<string[]> {
    const config = await this.initializeConfiguration(agent, cwd, app);
    if (config.notice) throw new Error(config.notice);
    const args = handshakeArgs(this.kind, cwd, help, ask);
    // Keep the restricted probe settings, while matching the execution selection.
    const settingsIndex = args.indexOf("--settings") + 1;
    if (typeof config.fastMode === "boolean") {
      args[settingsIndex] = JSON.stringify({...JSON.parse(args[settingsIndex]), fastMode: config.fastMode});
    }
    return [...args,
      ...(config.model ? ["--model", config.model] : []),
      ...(config.reasoningEffort ? ["--effort", config.reasoningEffort] : [])];
  }

  protected async readNativeConfiguration(_agent:DiscoveredAgent,workspacePath:string) {
    const root=process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),".claude");
    const user=await readSettingsFile(path.join(root,"settings.json"));
    const project=await readSettingsFile(path.join(workspacePath,".claude/settings.json"));
    const local=await readSettingsFile(path.join(workspacePath,".claude/settings.local.json"));
    const config={...user,...project,...local};
    const model=process.env.ANTHROPIC_MODEL || config.model;
    const reasoningEffort=process.env.CLAUDE_CODE_EFFORT_LEVEL || config.modelSettings?.[model]?.effortLevel || config.effortLevel;
    // A custom CLI profile must not inherit another desktop account's selection.
    const desktop=process.env.CLAUDE_CONFIG_DIR ? undefined :
      await readClaudeDesktopSelection(path.join(os.homedir(),"Library/Application Support/Claude"));
    const native={model:desktop?.model ?? (typeof model==="string"&&model.trim()?model:undefined),
      reasoningEffort:desktop?.reasoningEffort ?? (typeof reasoningEffort==="string"&&reasoningEffort.trim()?reasoningEffort:undefined),
      // Nothing configured means inherit; fabricating false would send
      // --settings {"fastMode":false} for a switch the user never touched.
      fastMode:process.env.CLAUDE_CODE_DISABLE_FAST_MODE==="1" ? false :
        desktop?.fastMode ?? (config.fastModePerSessionOptIn===true ? false :
          typeof config.fastMode==="boolean" ? config.fastMode : undefined),
      source:desktop?.source ?? "Claude Code native settings"};
    // Claiming this source with nothing in it hides the real situation: the model
    // then comes from the CLI's own default, not from anything the user chose.
    if(native.model===undefined&&native.reasoningEffort===undefined&&native.fastMode===undefined)return undefined;
    return native;
  }
  listModels(agent:DiscoveredAgent):Promise<AgentModelOption[]> {
    return withHandshakeDirectory(this.kind,cwd=>readClaudeModels(agent,cwd));
  }

  protected extraArgs(input:TurnInput):string[] {
    return [...(input.runtimeConfig?.model ? ["--model",input.runtimeConfig.model] : []),
      ...(input.runtimeConfig?.reasoningEffort ? ["--effort",input.runtimeConfig.reasoningEffort] : []),
      ...this.settingsArgs(input)];
  }
  /** --settings takes one value, so the Fast switch and the memory isolation share it. */
  private settingsArgs(input:TurnInput):string[] {
    // User settings stay loaded: they can hold the login helper and API endpoint, so --setting-sources is not an option here.
    const root=process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),".claude");
    const settings={...(typeof input.runtimeConfig?.fastMode==="boolean" ? {fastMode:input.runtimeConfig.fastMode} : {}),
      ...(input.isolateMemory ? {autoMemoryEnabled:false,claudeMdExcludes:[path.join(root,"CLAUDE.md"),path.join(root,"rules/**")]} : {})};
    return Object.keys(settings).length ? ["--settings",JSON.stringify(settings)] : [];
  }
  protected turnEnvironment(input:TurnInput):NodeJS.ProcessEnv|undefined {
    return input.isolateMemory ? {...process.env,CLAUDE_CODE_DISABLE_AUTO_MEMORY:"1"} : undefined;
  }
  readonly kind: AgentKind = "claude-code";
  readonly cumulativeTokenUsage = true;
  protected readonly binary = "claude";
  readonly label = "Claude Code";
  readonly installHint = "npm i -g @anthropic-ai/claude-code";
  readonly loginHint = p("claude  # 首次启动会引导登录", "claude  # the first launch guides you through login");
  readonly logoutHint = "claude auth logout";
  readonly docsUrl = "https://code.claude.com/docs/en/quickstart";

  protected extraCandidates(): string[] {
    const home = os.homedir();
    const managedRoot = path.join(
      home,
      "Library/Application Support/Claude/claude-code"
    );
    const executable = "claude.app/Contents/MacOS/claude";
    let managedVersions: string[] = [];
    try {
      managedVersions = readdirSync(managedRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) =>
          right.localeCompare(left, undefined, { numeric: true })
        )
        .flatMap((version) => {
          // Accept both layouts: earlier <version>/claude.app,
          // and since 2026-10 the Claude desktop app nests a hash directory under the version: <version>/<hash>/claude.app
          const versionDir = path.join(managedRoot, version);
          let nested: string[] = [];
          try {
            nested = readdirSync(versionDir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && entry.name !== "claude.app")
              .map((entry) => path.join(versionDir, entry.name, executable));
          } catch {
            // If the version directory can't be read, only try the old layout
          }
          return [path.join(versionDir, executable), ...nested];
        });
    } catch {
      // Claude desktop app isn't installed, or it doesn't host Claude Code yet.
    }

    return [path.join(home, ".claude/local/claude"), ...managedVersions];
  }

  async setupNotice(): Promise<AgentSetupNotice | null> {
    // An existing graphical App must not block direct CLI installation.
    return null;
  }

  protected permissionArgs(fullAccess: boolean): string[] {
    return ["--permission-mode", fullAccess ? "bypassPermissions" : "dontAsk"];
  }

  // Claude Code folds a mid-turn steer silently unless asked to replay it; the
  // replay (isReplay) is emitted when the steer reaches the model, as Qoder does.
  protected streamingInputArgs(): string[] {
    return ["--replay-user-messages"];
  }

  // ---------------------------------------------------------------------------
  // Skill sync: use its own skill mechanism instead of stuffing CLAUDE.md
  // ---------------------------------------------------------------------------

  /**
   * The workspace layer goes to <project>/.claude/skills — this directory belongs to the project itself,
   * and Claude Code creates it too, so create it if missing.
   *
   * The global layer goes to ~/.claude/skills, which affects the user's direct use of Claude Code outside ADing,
   * so it's only used when ~/.claude already exists and is writable; never create the user's config directory from scratch.
   */
  async resolveSkillTarget(
    scope: Scope,
    workspacePath: string
  ): Promise<SkillTarget | null> {
    if (scope === "workspace") {
      if (!(await skillRootMayExist(workspacePath))) return null;
      const dirPath = path.join(workspacePath, ".claude", "skills");
      return {
        agentKind: this.kind,
        scope,
        style: "skill-dir",
        dirPath,
        humanNote: p(`写入 ${dirPath}，一条技能一个目录，只在这个项目里生效`, `Writes to ${dirPath}, one directory per skill, only taking effect in this project`)
      };
    }

    const home = path.join(os.homedir(), ".claude");
    if (!(await skillRootMayExist(home))) return null;
    const dirPath = path.join(home, "skills");
    return {
      agentKind: this.kind,
      scope,
      style: "skill-dir",
      dirPath,
      humanNote:
        p("写入 ~/.claude/skills。注意：这会影响你在 ADing 之外直接使用 Claude Code", "Writes to ~/.claude/skills. Note: this affects your direct use of Claude Code outside ADing")
    };
  }

  async syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]> {
    if (target.style !== "skill-dir" || !target.dirPath) return [];
    return writeSkillDirs(target.dirPath, skills, { ownerFingerprint: target.ownerFingerprint });
  }

  async unsyncSkills(target: SkillTarget): Promise<string[]> {
    if (target.style !== "skill-dir" || !target.dirPath) return [];
    return removeSkillDirs(target.dirPath, { ownerFingerprint: target.ownerFingerprint });
  }
}
