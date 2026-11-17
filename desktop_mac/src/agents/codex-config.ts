import {ProcessRunner,type ProcessChannel} from "./process-runner";
import {codexChildEnvironment} from "./codex-environment";
import {randomUUID} from "node:crypto";
import {clientInfo} from "./client-info";
import type {AgentRuntimeConfig} from "./types";

export function codexRuntimeConfig(value:Record<string,any>):AgentRuntimeConfig {
  return {...(Number.isSafeInteger(value.model_context_window)&&value.model_context_window>=512 ? {contextWindowTokens:value.model_context_window} : {}),model:value.model,reasoningEffort:value.model_reasoning_effort,serviceTier:value.service_tier,
    fastMode:value.service_tier==="priority" || value.service_tier==="fast",source:"Codex config/read"};
}

/** Fast is a common switch; service-tier names belong to this adapter only. */
export function codexServiceTier(config:AgentRuntimeConfig|undefined):string|undefined {
  const tier=config?.serviceTier;
  if(config?.fastMode===true)return tier==="fast" || tier==="priority" ? tier : "priority";
  if(config?.fastMode===false)return !tier || tier==="priority" || tier==="fast" ? "default" : tier;
  return tier;
}

/** Native read-only configuration RPC; no thread or model turn is created. */
export async function readCodexConfiguration(agent:DiscoveredAgent,cwd:string):Promise<AgentRuntimeConfig> {
  return codexRuntimeConfig(await readCodexNativeConfiguration(agent,cwd));
}

/** Native read-only model/list RPC. Follows the cursor; hidden models are not offered by Codex either. */
export async function readCodexModels(agent:DiscoveredAgent,cwd:string):Promise<AgentModelOption[]> {
  let channel:ProcessChannel,done=false,failure="";
  const models:AgentModelOption[]=[];
  const page=(cursor?:string)=>channel.write({id:2,method:"model/list",params:cursor ? {cursor} : {}});
  const result=await new ProcessRunner().run(`models:${randomUUID()}`,{executablePath:agent.executablePath,args:["app-server","--stdio"],cwd,env:codexChildEnvironment(),label:"Codex models",timeoutMs:20000,retainLine:()=>undefined,
    onStart:c=>{channel=c;channel.write({id:1,method:"initialize",params:{clientInfo:clientInfo()}});},
    onLine:line=>{try {
      const event=JSON.parse(line);
      if(event.error){failure=String(event.error.message??"");channel.end();return;}
      if(event.id===1){channel.write({method:"initialized",params:{}});page();}
      if(event.id===2){
        for(const item of event.result?.data??[]) {
          if(item?.hidden||typeof item?.model!=="string"||!item.model)continue;
          const efforts=(item.supportedReasoningEfforts??[]).map((entry:any)=>entry?.reasoningEffort??entry).filter((entry:unknown)=>typeof entry==="string");
          models.push({id:item.model,label:item.displayName||item.model,description:item.description||undefined,
            ...(efforts.length ? {efforts} : {}),...(item.defaultReasoningEffort ? {defaultEffort:item.defaultReasoningEffort} : {})});
        }
        if(event.result?.nextCursor)page(event.result.nextCursor);else{done=true;channel.end();}
      }
    }catch{}}
  });
  if(!done)throw new Error(failure||result.failure||"Codex model list unavailable");
  return models;
}

/** Keep native parsing/profile precedence; never log credentials returned by this RPC. */
export async function readCodexNativeConfiguration(agent:DiscoveredAgent,cwd:string):Promise<Record<string,any>> {
  let channel:ProcessChannel,config:Record<string,any>|undefined;
  const runner=new ProcessRunner();
  await runner.run(`config:${randomUUID()}`,{executablePath:agent.executablePath,args:["app-server","--stdio"],cwd,env:codexChildEnvironment(),label:"Codex configuration",timeoutMs:10000,retainLine:()=>undefined,
    onStart:c=>{channel=c;channel.write({id:1,method:"initialize",params:{clientInfo:clientInfo()}});},
    onLine:line=>{try {
      const event=JSON.parse(line);
      if(event.error){channel.end();return;}
      if(event.id===1){channel.write({method:"initialized",params:{}});channel.write({id:2,method:"config/read",params:{cwd,includeLayers:false}});}
      if(event.id===2){const value=event.result?.config;if(value)config=value;channel.end();}
    }catch{}}
  });
  if(!config)throw new Error("Codex native configuration unavailable");
  return config;
}
