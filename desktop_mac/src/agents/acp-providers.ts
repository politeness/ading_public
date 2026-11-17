import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AcpAgent, type AcpLaunch } from "./acp-agent";
import { cliListsFlag, handshakeCommand, withHandshakeDirectory } from "./handshake";
import { removeOwnSessionEntry } from "./session-discard";
import { ProcessRunner } from "./process-runner";
import { readJsoncSettings } from "../platform/jsonc-settings";
import type { TurnInput } from "./types";
import { p } from "../prompt-language";

// Per-turn Kiro profiles carry the owning pid so a crashed instance's leftovers
// can be told apart from a live instance's profiles.
const KIRO_PROFILE = /^ading-(\d+)-[0-9a-f-]{36}\.json$/;

function ownerAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Remove profiles whose owning ADing process is gone (crash, kill, power loss);
 * close() only runs on a normal turn end. User profiles never match the pattern. */
export async function removeStaleKiroProfiles(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(names.map(async name => {
    const owner = KIRO_PROFILE.exec(name);
    if (owner && !ownerAlive(Number(owner[1]))) await rm(path.join(directory, name), { force: true });
  }));
}

/** The docs give no schema for `--list-models --format json`, so accept the array or wrapped object forms. */
export function parseKiroModels(stdout: string): AgentModelOption[] {
  const parsed = JSON.parse(stdout);
  const models = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
  return models.flatMap((item: any) => {
    const id = typeof item === "string" ? item : item?.model_id ?? item?.modelId ?? item?.id ?? item?.model_name ?? item?.name;
    if (typeof id !== "string" || !id) return [];
    const label = typeof item === "string" ? item : item.model_name ?? item.name ?? id;
    return [{ id, label: typeof label === "string" && label ? label : id,
      description: typeof item?.description === "string" && item.description ? item.description : undefined }];
  });
}

export class KiroAdapter extends AcpAgent {
  constructor(private readonly home = os.homedir()) { super(); }
  private staleProfilesRemoved?: Promise<void>;
  readonly kind: AgentKind = "kiro";
  protected readonly objectParallelSchema = true;
  protected readonly binary = "kiro-cli";
  readonly label = "Kiro";
  readonly installHint = "https://kiro.dev/cli/";
  readonly loginHint = "kiro-cli login";
  readonly logoutHint = "kiro-cli logout";
  readonly docsUrl = "https://kiro.dev/docs/cli/acp/";
  protected extraCandidates(): string[] { return this.desktopAppPaths().map(base => path.join(base, "Contents/MacOS/kiro-cli")); }
  /** The documented scripting form; session/new is the fallback when its output can't be read. */
  async listModels(agent: DiscoveredAgent): Promise<AgentModelOption[]> {
    const listed = await withHandshakeDirectory(this.kind, async cwd => {
      const result = await new ProcessRunner().run(`models:${randomUUID()}`, { ...handshakeCommand(agent.executablePath, ["chat", "--list-models", "--format", "json"]),
        cwd, label: this.label, backgroundPriority: true, timeoutMs: 20_000, onLine: () => undefined });
      try { return result.failure ? [] : parseKiroModels(result.stdout); } catch { return []; }
    });
    return listed.length ? listed : super.listModels(agent);
  }
  protected skillDirectories(workspace: string) { return { user: path.join(this.home, ".kiro/skills"), workspace: path.join(workspace, ".kiro/skills") }; }
  protected async readNativeConfiguration(agent: DiscoveredAgent, workspace: string) {
    // Ask the CLI for effective, non-secret keys; it owns v2/v3 path migration
    // and user/workspace precedence. Never dump the full settings collection.
    const read = async (key: string) => JSON.parse((await promisify(execFile)(agent.executablePath,
      ["settings", key, "--format", "json"], { cwd: workspace, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout);
    const [model, defaults] = await Promise.all([read("chat.defaultModel"), read("chat.modelDefaults")]);
    if (model != null && typeof model !== "string") throw new Error(p("Kiro 模型配置格式无效", "Invalid Kiro model setting"));
    if (!model) return undefined;
    const selected = defaults?.[model];
    const effort = selected?.output_config?.effort ?? selected?.reasoning?.effort;
    if (effort !== undefined && typeof effort !== "string") throw new Error(p("Kiro 强度配置格式无效", "Invalid Kiro effort setting"));
    return { model, ...(effort ? { reasoningEffort: effort } : {}), source: "kiro-cli settings" };
  }
  /** Kiro documents no way to turn saving off. `chat --delete-session` is its own removal (per
   * directory, not while open), but follows chat's engine setting rather than the v2 engine pinned
   * below. Kiro's ACP docs list the .json and .jsonl under ~/.kiro/sessions/cli/; third-party clients
   * also report a .lock there. */
  protected async discardSession(agent: DiscoveredAgent, sessionId: string, input: TurnInput): Promise<number> {
    if (await cliListsFlag(agent, "--delete-session", ["chat", "--help"])) {
      await this.runner.run(`${agent.localUuid}::discard`, { executablePath: agent.executablePath, args: ["chat", "--delete-session", sessionId],
        cwd: input.workspacePath, label: this.label, backgroundPriority: true, timeoutMs: 15_000, onLine: () => undefined });
    }
    const root = path.join(this.home, ".kiro/sessions/cli");
    const removed = await Promise.all([".json", ".jsonl", ".lock"].map(suffix => removeOwnSessionEntry(root, `${sessionId}${suffix}`, "file")));
    return removed.filter(Boolean).length;
  }
  protected async prepareAcp(input: TurnInput): Promise<AcpLaunch> {
    // Explicitly use the validated v2 protocol, not a moving default engine.
    // Unique, owned profiles prevent parallel lanes from changing each other.
    const name = `ading-${process.pid}-${randomUUID()}`;
    const directory = path.join(this.home, ".kiro/agents");
    await mkdir(directory, { recursive: true });
    this.staleProfilesRemoved ??= removeStaleKiroProfiles(directory).catch(() => undefined);
    await this.staleProfilesRemoved;
    const file = path.join(directory, `${name}.json`);
    const restricted = input.discussionOnly || !input.fullAccess;
    await writeFile(file, JSON.stringify({ name, tools: input.discussionOnly ? [] : restricted ? ["read"] : ["*"],
      allowedTools: [], includeMcpJson: false, hooks: {}, resources: restricted ? [] : [
        "skill://~/.kiro/skills/*/SKILL.md", "skill://.kiro/skills/*/SKILL.md"
      ] }), { mode: 0o600, flag: "wx" });
    return { args: ["acp", "--agent-engine=v2", "--agent", name, "--trust-tools=",
      ...(input.runtimeConfig?.model ? ["--model", input.runtimeConfig.model] : []),
      ...(input.runtimeConfig?.reasoningEffort ? ["--effort", input.runtimeConfig.reasoningEffort] : [])],
      close: () => rm(file, { force: true }) };
  }
  loginAuthorizationUrl(line: string): string | undefined {
    // `login --use-device-flow` prints an AWS IAM Identity Center / Builder ID
    // verification page; open only that official start portal over https.
    for (const raw of line.match(/https:\/\/[^\s"'<>\x00-\x1f\x7f]+/g) ?? []) {
      try {
        const url = new URL(raw.replace(/[).,;:!?]+$/, ""));
        if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
            url.hostname.endsWith(".awsapps.com") && url.pathname.startsWith("/start")) return url.href;
      } catch { /* Ordinary login progress, not an authorization URL. */ }
    }
    return undefined;
  }
}

export class CopilotAdapter extends AcpAgent {
  readonly kind: AgentKind = "copilot";
  protected readonly binary = "copilot";
  readonly label = "GitHub Copilot";
  readonly installHint = "https://github.com/features/copilot";
  readonly loginHint = "copilot login";
  readonly logoutHint = undefined;
  readonly docsUrl = "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server";
  protected skillDirectories(workspace: string) { return { user: path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "skills"), workspace: path.join(workspace, ".github/skills") }; }
  protected async readNativeConfiguration() {
    const file = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "settings.json");
    const settings = await readJsoncSettings(file);
    const model = process.env.COPILOT_MODEL || settings.model;
    if (model !== undefined && typeof model !== "string") throw new Error(p("Copilot 模型配置格式无效", "Invalid Copilot model setting"));
    return model ? { model, source: process.env.COPILOT_MODEL ? "COPILOT_MODEL" : file } : undefined;
  }
  /** Copilot documents no flag to skip saving, and `/session delete` is interactive only. Its docs say
   * session-state/ holds one directory per session ID and that deleting removes that history; the
   * index in session-store.db has no documented per-session removal, so it stays. */
  protected async discardSession(_agent: DiscoveredAgent, sessionId: string): Promise<number> {
    const root = path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "session-state");
    return await removeOwnSessionEntry(root, sessionId, "directory") ? 1 : 0;
  }
  protected async prepareAcp(input: TurnInput): Promise<AcpLaunch> {
    return { args: ["--acp", "--no-auto-update", "--disable-builtin-mcps", "--no-ask-user", "--sync-session=off",
      ...(input.discussionOnly ? ["--available-tools="] : !input.fullAccess ? ["--available-tools=view,glob,grep"] : []),
      // The docs name no switch for ~/.copilot/copilot-instructions.md alone, so this likely drops workspace instructions too. Scripted runs need --enable-memory for memory; never passed here.
      ...(input.discussionOnly || input.isolateMemory ? ["--no-custom-instructions"] : []),
      ...(input.runtimeConfig?.model ? ["--model", input.runtimeConfig.model] : []),
      ...(input.runtimeConfig?.reasoningEffort ? ["--reasoning-effort", input.runtimeConfig.reasoningEffort] : [])],
      // Ambient auto-approval must not bypass ADing's normal permission flow.
      env: { ...process.env, COPILOT_ALLOW_ALL: "false", COPILOT_ASSISTED_APPROVAL: "false" } };
  }
  loginAuthorizationUrl(line: string): string | undefined {
    const raw = line.match(/https:\/\/github\.com\/login\/device\b/)?.[0];
    return raw;
  }
}
