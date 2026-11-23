import type { InstallProgress } from "./download-progress";
import { ClaudeCodeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { QoderAdapter } from "./qoder";
import { QoderCnAdapter } from "./qoder-cn";
import { KiroAdapter, CopilotAdapter } from "./acp-providers";
import { AntigravityAdapter } from "./antigravity";
import { QwenCodeAdapter } from "./qwen";
import { AgentLifecycleService } from "./lifecycle";
import { findDesktopApp } from "./desktop-apps";
import os from "node:os";
import type { SkillTarget } from "../skills/target";
import type { AgentAdapter, AgentRuntimeConfig, SteerInput, SteerResult, TurnInput, VerifyResult } from "./types";
import { tm } from "../i18n";
import { p } from "../prompt-language";

export interface DiscoveryResult {
  agents: DiscoveredAgent[];
  setupNotices: AgentSetupNotice[];
  /** Vendors with no usable CLI found but a file that won't run; the value is the human-readable reason */
  probeFailures: Partial<Record<AgentKind, string>>;
  /** Vendors whose app is present, with no usable CLI and no dedicated guidance (setupNotice) */
  cliMissing: AgentKind[];
}

/**
 * Registry of all agent adapters on this machine.
 * A new vendor must also be added to the types, lifecycle, cloud mapping and UI catalog.
 *
 * The order is the order in the contacts list. Each vendor "returns an empty array if no executable is found",
 * so having only one of them installed produces no errors at all.
 */
export class AgentRegistry {
  constructor(private readonly options: {openExternal?: (url:string)=>Promise<void>; openApp?: (path:string)=>Promise<void>} = {}) {}
  private readonly installFlights = new Map<AgentKind,Promise<AgentLifecycleResult>>();
  private readonly loginFlights = new Map<AgentKind,Promise<AgentLifecycleResult>>();
  private readonly cancelledLogins = new Set<AgentKind>();
  private discoveryFlight?: Promise<DiscoveryResult>;
  private readonly lifecycle = new AgentLifecycleService();
  private readonly adapters: AgentAdapter[] = [
    new CodexAdapter(),
    new ClaudeCodeAdapter(),
    new QoderAdapter(),
    new QoderCnAdapter(),
    new QwenCodeAdapter(),
    new KiroAdapter(),
    new CopilotAdapter(),
    new AntigravityAdapter()
  ];

  async discoverAll(): Promise<DiscoveryResult> {
    if (!this.discoveryFlight) {
      this.discoveryFlight = this.discoverOnce().finally(() => { this.discoveryFlight = undefined; });
    }
    return this.discoveryFlight;
  }

  private async discoverOnce(): Promise<DiscoveryResult> {
    const results = await Promise.all(
      this.adapters.map(async (adapter) => {
        const agents = await adapter
          .discover()
          .catch(() => [] as DiscoveredAgent[]);
        const notice =
          agents.length === 0
            ? await adapter.setupNotice?.().catch(() => null)
            : null;
        for(const agent of agents)agent.runtimeDefaults=await adapter.initializeConfiguration(agent,os.homedir());
        const failure = agents.length === 0 ? adapter.lastDiscoveryFailure?.() : undefined;
        const cliMissing = agents.length === 0 && !notice
          ? await adapter.vendorAppInstalled?.().catch(() => false) ?? false
          : false;
        return { kind: adapter.kind, agents, notice, failure, cliMissing };
      })
    );
    return {
      agents: results.flatMap((result) => result.agents),
      setupNotices: results
        .map((result) => result.notice)
        .filter((notice): notice is AgentSetupNotice => Boolean(notice)),
      cliMissing: results.filter((result) => result.cliMissing).map((result) => result.kind),
      probeFailures: Object.fromEntries(
        results
          .filter((result) => result.failure)
          .map((result) => [result.kind, result.failure])
      ) as Partial<Record<AgentKind, string>>
    };
  }

  adapterFor(kind: AgentKind): AgentAdapter | undefined {
    return this.adapters.find((adapter) => adapter.kind === kind);
  }

  /**
   * Which vendors are supported - **independent of what is installed on this machine**.
   *
   * The Agent setup page is built on this list: list everything supported first, then attach each one's status.
   * Doing it the other way (list only what is installed) is the old design, where an empty list leaves people not knowing what to do.
   */
  describeAll(): Array<
    Pick<AgentAdapter, "kind" | "label" | "installHint" | "loginHint" | "logoutHint" | "docsUrl">
  > {
    return this.adapters.map((adapter) => ({
      kind: adapter.kind,
      label: adapter.label,
      installHint: adapter.installHint,
      loginHint: adapter.loginHint,
      logoutHint: adapter.logoutHint,
      docsUrl: adapter.docsUrl
    }));
  }

  supportsModelList(kind: AgentKind): boolean {
    return !!this.adapters.find(adapter => adapter.kind === kind)?.listModels;
  }

  async listModels(agent: DiscoveredAgent): Promise<AgentModelOption[]> {
    return (await this.adapters.find(adapter => adapter.kind === agent.kind)?.listModels?.(agent)) ?? [];
  }

  async verify(agent: DiscoveredAgent, app?: AgentRuntimeConfig): Promise<VerifyResult> {
    const adapter = this.adapterFor(agent.kind);
    if (!adapter) return { ok: false, text: p(`暂不支持的 Agent 类型：${agent.kind}`, `Unsupported Agent type: ${agent.kind}`) };
    return adapter.verify(agent, app).catch((error: unknown) => ({
      ok: false,
      text: error instanceof Error ? error.message : String(error)
    }));
  }

  /** Ask one thing, get one answer, leave no trace. All four vendors share the same non-persisted channel; callers don't distinguish vendors */
  async askOnce(agent: DiscoveredAgent, prompt: string): Promise<VerifyResult> {
    const adapter = this.adapterFor(agent.kind);
    if (!adapter) return { ok: false, text: p(`暂不支持的 Agent 类型：${agent.kind}`, `Unsupported Agent type: ${agent.kind}`) };
    return adapter.askOnce(agent, prompt).catch((error: unknown) => ({
      ok: false,
      text: error instanceof Error ? error.message : String(error)
    }));
  }

  async runTurn(
    agent: DiscoveredAgent,
    input: TurnInput
  ): Promise<AgentTurnOutcome> {
    const adapter = this.adapterFor(agent.kind);
    if (!adapter) {
      return {
        ok: false,
        error: p(`暂不支持的 Agent 类型：${agent.kind}`, `Unsupported Agent type: ${agent.kind}`),
        steps: [],
        cancelled: false,
        metrics: { iterations: 0, sideEffects: false }
      };
    }
    return adapter.runTurn(agent, input);
  }

  async steer(kind:AgentKind,localUuid:string,input:SteerInput):Promise<SteerResult>{
    const adapter=this.adapterFor(kind);
    if(!adapter?.steer)return {status:"unsupported"};
    return adapter.steer(localUuid,input).catch(error=>({status:"failed",error:String(error)}));
  }

  async authStatus(kind: AgentKind, discovered?: DiscoveredAgent): Promise<AgentAuthStatus> {
    return this.lifecycle.authStatus(discovered ?? await this.requireDiscovered(kind));
  }

  async install(
    kind: AgentKind,
    confirmed: boolean,
    onProgress?: InstallProgress
  ): Promise<AgentLifecycleResult> {
    if (!confirmed) return this.lifecycle.install(kind, false, onProgress);
    const pending = this.installFlights.get(kind);
    if (pending) return pending;
    const flight = this.installRuntime(kind, onProgress).finally(() => this.installFlights.delete(kind));
    this.installFlights.set(kind, flight);
    return flight;
  }

  private async installRuntime(kind: AgentKind, onProgress?: InstallProgress): Promise<AgentLifecycleResult> {
    try {
      // Reuse a working CLI, including a runtime bundled with an existing App.
      // Installing an Agent must not require downloading its graphical client.
      const agents = await this.adapterFor(kind)?.discover();
      if (agents?.length) return {kind, action:"install", ok:true, requiresUserAction:false,
        message:p("已找到可用 CLI，正在检测", "A usable CLI was found; checking connection")};
      return await this.lifecycle.install(kind, true, onProgress);
    } catch (error) {
      return {kind, action:"install", ok:false, requiresUserAction:false, message:error instanceof Error ? error.message : String(error)};
    }
  }

  login(
    kind: AgentKind,
    confirmed: boolean,
    onProgress?: (text: string) => void
  ): Promise<AgentLifecycleResult> {
    if(!confirmed)return this.requireDiscovered(kind).then(agent=>this.lifecycle.login(agent,false,onProgress));
    const pending=this.loginFlights.get(kind);
    if(pending)return pending;
    this.cancelledLogins.delete(kind);
    const flight=this.loginOnce(kind,onProgress).finally(()=>{
      this.loginFlights.delete(kind);this.cancelledLogins.delete(kind);
    });
    this.loginFlights.set(kind,flight);
    return flight;
  }

  private async loginOnce(kind: AgentKind, onProgress?: (text:string)=>void): Promise<AgentLifecycleResult> {
    const agent=await this.requireDiscovered(kind),adapter=this.adapterFor(kind);
    const cancelled=():AgentLifecycleResult=>({kind,action:'login',ok:false,requiresUserAction:true,message:tm("svc.agent.loginCancelled")});
    if(this.cancelledLogins.has(kind))return cancelled();
    // Qwen's official desktop app configures the same ~/.qwen provider settings.
    // Opening it is a handoff, not evidence of successful authentication.
    if (kind === "qwen-code" && this.options.openApp) {
      const appPath = await findDesktopApp(kind);
      if (appPath) {
        await this.options.openApp(appPath);
        return {kind, action:"login", ok:false, requiresUserAction:true, awaitingUserAction:true,
          message:p("已打开 Qwen Code Desktop，请在 App 中配置模型服务，完成后回阿钉点击检测。", "Qwen Code Desktop is open. Configure a model provider in the app, then return to ADing and click Check.")};
      }
    }
    const opened=new Set<string>(),openings:Promise<void>[]=[];
    let openFailure=false;
    const result=await this.lifecycle.login(agent,true,text=>{
      if(this.cancelledLogins.has(kind))return;
      const url=adapter?.loginAuthorizationUrl?.(text);
      if(!url||!this.options.openExternal){onProgress?.(text);return;}
      // A device code can share the authorization URL's line. Keep that line
      // even when the browser has already been opened for the same URL.
      onProgress?.(text);
      if(opened.has(url))return;
      opened.add(url);
      onProgress?.(tm("svc.agent.loginInBrowser",{label:adapter?.label??kind}));
      openings.push(this.options.openExternal(url).catch(()=>{
        openFailure=true;
        this.lifecycle.cancel(kind,'login');
      }));
    });
    await Promise.all(openings);
    if(this.cancelledLogins.has(kind))return cancelled();
    return openFailure?{...result,ok:false,requiresUserAction:true,message:tm("svc.agent.loginPageFailed")}:result;
  }

  async logout(
    kind: AgentKind,
    confirmed: boolean,
    onProgress?: (text: string) => void
  ): Promise<AgentLifecycleResult> {
    return this.lifecycle.logout(
      await this.requireDiscovered(kind),
      confirmed,
      onProgress
    );
  }

  cancelLifecycle(kind: AgentKind, action: AgentLifecycleAction): boolean {
    if(action==='login'&&this.loginFlights.has(kind)){
      this.cancelledLogins.add(kind);
      this.lifecycle.cancel(kind,action);
      return true;
    }
    return this.lifecycle.cancel(kind, action);
  }

  /** For each agent present on this machine, probe where it lands for this scope */
  async resolveSkillTargets(
    scope: Scope,
    workspacePath: string,
    kinds: AgentKind[],
    onError?: (error: unknown, kind: AgentKind) => void
  ): Promise<SkillTarget[]> {
    const targets: SkillTarget[] = [];
    const failures: unknown[] = [];
    for (const adapter of this.adapters) {
      if (!kinds.includes(adapter.kind)) continue;
      try {
        const target = await adapter.resolveSkillTarget(scope, workspacePath);
        if (target) targets.push(target);
      } catch (error) {
        if (onError) onError(error, adapter.kind);
        else failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "));
    return targets;
  }

  async syncSkills(target: SkillTarget, skills: Skill[]): Promise<string[]> {
    return this.adapterFor(target.agentKind)?.syncSkills(target, skills) ?? [];
  }

  async unsyncSkills(target: SkillTarget): Promise<string[]> {
    return this.adapterFor(target.agentKind)?.unsyncSkills(target) ?? [];
  }

  cancel(kind: AgentKind, localUuid: string): boolean {
    return this.adapterFor(kind)?.cancel(localUuid) ?? false;
  }

  /** On app exit, reap every child process still running; leave no orphans */
  cancelEverything(): void {
    for(const kind of this.loginFlights.keys())this.cancelledLogins.add(kind);
    this.lifecycle.cancelAll();
    for (const adapter of this.adapters) {
      for (const localUuid of adapter.busyIds()) adapter.cancel(localUuid);
    }
  }

  /**
   * After cancelling, wait until all agent child processes have actually exited; return those still running.
   *
   * cancel sends SIGTERM first and SIGKILL 3 seconds later, so the limit here must cover that whole round,
   * otherwise we'd move on before SIGKILL takes effect and leave half-dead processes to the system.
   */
  async waitForAllExit(timeoutMs: number): Promise<string[]> {
    const stubborn = await Promise.all(
      [...this.adapters.map(adapter => adapter.waitForExit(timeoutMs)),this.lifecycle.waitForExit(timeoutMs)]
    );
    return stubborn.flat();
  }

  cancelChecks(): void {
    for (const adapter of this.adapters) {
      for (const id of adapter.busyIds()) if (id.endsWith("::verify")) adapter.cancel(id);
    }
  }

  isBusy(kind: AgentKind): boolean {
    return this.installFlights.has(kind) || this.loginFlights.has(kind)
      || (this.adapterFor(kind)?.busyIds().length ?? 0) > 0;
  }

  private async requireDiscovered(kind: AgentKind): Promise<DiscoveredAgent> {
    const discovered = (await this.discoverAll()).agents.find(
      (agent) => agent.kind === kind
    );
    if (!discovered) throw new Error(tm("svc.agent.cliNotInstalled", { kind }));
    return discovered;
  }
}
