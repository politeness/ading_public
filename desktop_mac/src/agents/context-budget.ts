import type {TurnInput} from "./types";
import {isContextOverflow} from "../orchestration/connection-recovery";
import {log} from "../orchestration/diagnostics";
import {p} from "../prompt-language";

/** UTF-8 bytes are a deliberately conservative token estimate, not a claimed tokenizer count. */
export const estimateInputTokens=(text:string):number=>Buffer.byteLength(text,"utf8");
export class ContextBudget {
  private readonly threads=new Map<string,number>();
  async run(input:TurnInput,window:number|undefined,execute:(input:TurnInput)=>Promise<AgentTurnOutcome>):Promise<AgentTurnOutcome> {
    // Unknown custom models are NOT assumed to have the capacity of their namesake.
    // Reserve room for vendor system/tools, output, and tokenizer uncertainty.
    const capacity=typeof window==="number"&&Number.isSafeInteger(window)&&window>=512 ? window : undefined;
    const budget=capacity ? Math.floor(capacity*0.5) : 32768;
    await log("context-budget",{capacity,source:window ? "native" : "conservative-fallback",inputBudget:budget,inputEstimate:estimateInputTokens(input.prompt)});
    const key=input.threadId ? `${input.workspacePath}\0${input.threadId}` : undefined;
    const previous=key ? this.threads.get(key)??0 : 0;
    let messages=input.contextMessages?.slice();
    const original=input.split?.dialogue;
    // Group and direct prompts render complete messages with different separators.
    // Preserve framing and every non-history section, including appended execution instructions.
    let separator="\n\n";
    if(messages&&original&&!original.includes(messages.join(separator)))separator="\n";
    const rendered=messages?.join(separator);
    if(!input.split||!messages?.length||!rendered||!original?.includes(rendered)||!input.prompt.includes(original))messages=undefined;
    const materialize=():TurnInput=>{
      if(!messages||messages.join(separator)===rendered)return input;
      const dialogue=original!.replace(rendered!,()=>messages!.join(separator));
      return {...input,contextMessages:messages.slice(),prompt:input.prompt.replace(original!,()=>dialogue),split:{...input.split!,dialogue}};
    };
    let prepared=materialize();
    while(!input.threadId&&messages&&messages.length>1&&estimateInputTokens(prepared.prompt)>budget){messages.shift();prepared=materialize();}
    // A resumed provider transcript must be rebuilt by the scheduler, which owns
    // the durable ledger. Never start a new thread with only the latest delta.
    if(input.threadId&&previous+estimateInputTokens(prepared.prompt)>budget)return {ok:false,error:"context_length_exceeded: rebuild provider context",threadId:input.threadId,steps:[],cancelled:false,metrics:{iterations:0,sideEffects:false}};
    // Fixed instructions and the latest request may exceed an estimate (vendor
    // tokenizers differ). Try them intact; the native service remains authoritative.
    for(;;){
      const outcome=await execute(prepared);
      if(outcome.ok){
        if(outcome.threadId){
          this.threads.set(`${input.workspacePath}\0${outcome.threadId}`,previous+estimateInputTokens(prepared.prompt)+estimateInputTokens(outcome.message));
          if(this.threads.size>1000)this.threads.delete(this.threads.keys().next().value!);
        }
        return outcome;
      }
      if(!isContextOverflow(outcome.error)||outcome.cancelled||input.signal?.aborted||input.threadId||outcome.metrics.sideEffects||outcome.partialMessage?.trim())return outcome;
      if(!messages)return outcome;
      if(messages.length<=1)return {...outcome,contextBudgetExhausted:true,error:p("已缩减到最新消息，模型仍无法容纳当前请求及原生工具。请增大模型服务的上下文容量或缩短这条消息。", "History was reduced to the latest message, but the model still cannot fit this request and its native tools. Increase the model service's context capacity or shorten this message.")+"\n"+outcome.error};
      // Strictly decrease the oldest whole-message prefix on every silent retry.
      // Halving bounds the number of requests even for very long histories.
      messages.splice(0,Math.max(1,Math.floor(messages.length/2)));
      prepared={...materialize(),threadId:undefined};
    }
  }
}
