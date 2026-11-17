import {cachedContextWindow} from "./context-window-cache";
import {ContextBudget} from "./context-budget";
import {withComputerGuidance} from "./computer-tools";
import {ParallelExecutor} from "./parallel-executor";
import type {TurnInput,AgentRuntimeConfig} from "./types";
import {mergeRuntimeConfigSnapshot,resolveRuntimeConfig} from "./runtime-config";
import {mergeTurnMetrics} from "./token-usage";
import { p } from "../prompt-language";
import {withKnowledgeGuidance,withMemoryIsolationGuidance} from "../knowledge/tools";

/** The execution policy belongs here, never in a provider adapter. */
export abstract class ExecutionAgent {
  readonly supportsParallelWork=true;
  private readonly contextBudget=new ContextBudget();
  protected async readContextWindow(_agent:DiscoveredAgent,input:TurnInput):Promise<number|undefined> {return input.runtimeConfig?.contextWindowTokens;}
  private readonly execution=new ParallelExecutor();

  private shouldRetrySilentCommunication(input:TurnInput,outcome:AgentTurnOutcome):boolean {
    return !!input.communicationOnly && !!input.discussionOnly && !input.signal?.aborted &&
      !outcome.ok && !outcome.cancelled && !!outcome.threadId && !outcome.partialMessage?.trim() &&
      !outcome.metrics.sideEffects && /超过\s*\d+\s*秒|timed?\s*out|timeout/i.test(outcome.error??"");
  }

  async initializeConfiguration(agent:DiscoveredAgent,workspacePath:string,app?:AgentRuntimeConfig):Promise<AgentRuntimeConfig> {
    return resolveRuntimeConfig({app,remembered:agent.runtimeDefaults,native:()=>this.nativeConfiguration(agent,workspacePath)});
  }

  /** Remember the last selection the vendor app actually reported. A moment when
   * it cannot be read — the desktop app closed, no session file written yet —
   * must not silently downgrade this Agent to whatever the CLI defaults to. */
  private async nativeConfiguration(agent:DiscoveredAgent,workspacePath:string):Promise<AgentRuntimeConfig|undefined> {
    const config=await this.readNativeConfiguration(agent,workspacePath);
    if(config?.model)agent.runtimeDefaults=mergeRuntimeConfigSnapshot(agent.runtimeDefaults,config);
    return config;
  }

  async runTurn(agent:DiscoveredAgent,input:TurnInput):Promise<AgentTurnOutcome> {
    let runtimeConfig=await resolveRuntimeConfig({app:input.appRuntimeConfig,pinned:input.runtimeConfig,
      remembered:agent.runtimeDefaults,native:()=>this.nativeConfiguration(agent,input.workspacePath)});
    let previous="";
    const publish=(config:AgentRuntimeConfig)=>{
      runtimeConfig=mergeRuntimeConfigSnapshot(runtimeConfig,config);
      input.onRuntimeConfig?.(runtimeConfig);
      const description=p(`${runtimeConfig.model??"厂商默认"} · 强度 ${runtimeConfig.reasoningEffort??"原生默认"} · Fast ${runtimeConfig.fastMode===undefined?"原生默认":runtimeConfig.fastMode?"开":"关"}（${runtimeConfig.source??"native"}）`, `${runtimeConfig.model??"vendor default"} · effort ${runtimeConfig.reasoningEffort??"native default"} · Fast ${runtimeConfig.fastMode===undefined?"native default":runtimeConfig.fastMode?"on":"off"} (${runtimeConfig.source??"native"})`);
      if(description!==previous){previous=description;input.onProgress(p(`模型配置：${description}`, `Model configuration: ${description}`));}
    };
    publish(runtimeConfig);
    if(runtimeConfig.notice)input.onProgress(runtimeConfig.notice);
    const execute=(turnInput:TurnInput)=>this.execution.run(
      agent,
      {...turnInput,runtimeConfig,onRuntimeConfig:publish},
      // Both top-level turns and parallel subtasks pass through here: turns with computer-use tools get usage instructions appended
      async (agent,input)=>{
        const paths=await input.refreshKnowledge?.() ?? [];
        const prepared=withComputerGuidance(withMemoryIsolationGuidance(withKnowledgeGuidance(input,paths)));
        const window=await cachedContextWindow(agent,prepared,()=>this.readContextWindow(agent,prepared)).catch(()=>undefined);
        return this.contextBudget.run(prepared,window,next=>this.executeTurn(agent,next));
      }
    );
    const first=await execute(input);
    if(!this.shouldRetrySilentCommunication(input,first))return first;
    input.onProgress(p("讨论回复超时且没有正文，正在保留原会话重试一次", "The discussion reply timed out with no text; retrying once in the original session"));
    const recovered=await execute({...input,threadId:first.threadId,runtimeConfig,
      prompt:p("上一轮模型请求超时且没有返回正文。请直接基于上一条用户消息完成原要求，保持简短；不要使用工具，也不要复述这条恢复说明。", "The previous model request timed out without returning any text. Complete the original request directly based on the last user message and keep it short; don't use tools, and don't repeat this recovery note.")});
    return {...recovered,steps:[...first.steps,...recovered.steps],metrics:mergeTurnMetrics(first.metrics,recovered.metrics)};
  }

  protected abstract readNativeConfiguration(agent:DiscoveredAgent,workspacePath:string):Promise<AgentRuntimeConfig|undefined>;
  protected abstract executeTurn(agent:DiscoveredAgent,input:TurnInput):Promise<AgentTurnOutcome>;
}
