import {readFile} from "node:fs/promises";
import type {AgentRuntimeConfig} from "./types";
import { p } from "../prompt-language";

function concreteModel(value:unknown):value is string {
  return typeof value==="string" && !!value.trim() && !/^<[^>]+>$/.test(value.trim());
}

/** Provider event streams sometimes report placeholders such as <synthetic>.
 * They are telemetry labels, not model ids, and must never become arguments of
 * a later provider invocation. Keep the last concrete shared snapshot instead.
 */
export function mergeRuntimeConfigSnapshot(current:AgentRuntimeConfig|undefined,next:AgentRuntimeConfig|undefined):AgentRuntimeConfig {
  const merged:AgentRuntimeConfig={};
  const apply=(config:AgentRuntimeConfig|undefined,baseline=false)=>{
    let accepted=false;
    if(config?.model&&merged.model&&config.model!==merged.model)delete merged.contextWindowTokens;
    if(Number.isSafeInteger(config?.contextWindowTokens)&&config!.contextWindowTokens!>=512)merged.contextWindowTokens=config!.contextWindowTokens;
    if(concreteModel(config?.model)){merged.model=config.model.trim();accepted=true;}
    if(typeof config?.reasoningEffort==="string"&&config.reasoningEffort.trim()){merged.reasoningEffort=config.reasoningEffort.trim();accepted=true;}
    if(typeof config?.serviceTier==="string"&&config.serviceTier.trim()){merged.serviceTier=config.serviceTier.trim();accepted=true;}
    if(typeof config?.fastMode==="boolean"){merged.fastMode=config.fastMode;accepted=true;}
    if((baseline||accepted)&&typeof config?.source==="string"&&config.source.trim())merged.source=config.source.trim();
    if(typeof config?.notice==="string"&&config.notice.trim())merged.notice=config.notice.trim();
  };
  apply(current,true);apply(next);
  // Whether the surviving values describe a user choice or a provider response
  // travels with them; a later real configuration clears the observed marker.
  const observed=next&&hasValues(next) ? next.observed : current?.observed;
  if(observed)merged.observed=true;
  return merged;
}

function hasValues(config:AgentRuntimeConfig):boolean {
  return concreteModel(config.model)||typeof config.fastMode==="boolean"||
    ["reasoningEffort","serviceTier"].some(key=>typeof (config as any)[key]==="string"&&(config as any)[key].trim());
}

/** Configuration precedence is shared; adapters only supply native values.
 *
 * Highest to lowest: an explicit ADing override, an explicit pin, what the
 * vendor's own app says right now, and finally the last selection ADing managed
 * to read from that app. A snapshot marked `observed` sits below all of them,
 * because it is only a report of what a previous turn ran. Without that rule a
 * single turn launched while the vendor app happened to be unreadable records
 * the CLI's built-in default and then keeps passing it explicitly, so the user's
 * configured model never comes back until the session is thrown away.
 */
export async function resolveRuntimeConfig(options:{
  app?:AgentRuntimeConfig; pinned?:AgentRuntimeConfig;
  /** Last configuration actually read from the vendor app, used only as a fallback. */
  remembered?:AgentRuntimeConfig;
  native:()=>Promise<AgentRuntimeConfig|undefined>;
}):Promise<AgentRuntimeConfig> {
  const values=(config:AgentRuntimeConfig|undefined):AgentRuntimeConfig=>Object.fromEntries(
    Object.entries(config??{}).filter(([key,value])=>key==="fastMode" ? typeof value==="boolean" : key==="model" ? concreteModel(value) :
      ["reasoningEffort","serviceTier"].includes(key) && typeof value==="string" && value.trim()));
  const choice=(config:AgentRuntimeConfig|undefined):AgentRuntimeConfig=>config?.observed ? {} : values(config);
  const app=choice(options.app),pinned=choice(options.pinned),remembered=choice(options.remembered);
  const overlay=(base:AgentRuntimeConfig):AgentRuntimeConfig=>{
    const native=values(base);
    const merged:AgentRuntimeConfig={...remembered,...native,...pinned,...app};
    if(base.model===merged.model&&Number.isSafeInteger(base.contextWindowTokens)&&base.contextWindowTokens!>=512)merged.contextWindowTokens=base.contextWindowTokens;
    // Only say the configuration came from the vendor app when this read supplied it.
    const stale=![app,pinned,native].some(layer=>Object.keys(layer).length)&&!!Object.keys(remembered).length;
    const source=Object.keys(app).length ? "ading" :
      Object.keys(pinned).length ? options.pinned?.source ?? base.source :
      stale ? p(`${options.remembered?.source ?? "上次读到的原生配置"}（本次未读到，沿用上次）`, `${options.remembered?.source ?? "the native configuration read last time"} (not read this time; using the previous one)`) : base.source;
    if(source)merged.source=source;
    const notice=base.notice ?? (stale ? p("暂时读不到原应用的当前选择，本轮沿用上次读到的配置", "Can't read the original app's current selection right now; this turn uses the configuration read last time") : undefined);
    if(notice)merged.notice=notice;
    return merged;
  };
  // A complete snapshot needs no native read. Partial overrides never suppress it.
  const chosen={...pinned,...app};
  if(chosen.model && chosen.reasoningEffort && typeof chosen.fastMode==="boolean")return overlay({source:options.pinned?.source});
  try {
    const native=await options.native();
    if(!native)return overlay({source:"provider-default"});
    const metadata:AgentRuntimeConfig={};
    if(typeof native.source==="string"&&native.source.trim())metadata.source=native.source.trim();
    if(typeof native.notice==="string"&&native.notice.trim())metadata.notice=native.notice.trim();
    return overlay(mergeRuntimeConfigSnapshot(metadata,native));
  } catch {
    // Do not silently claim native configuration was read successfully.
    return overlay({source:"provider-default",notice:p("原应用配置未能读取，使用厂商原生默认配置", "The original app's configuration couldn't be read; using the vendor's native default configuration")});
  }
}

/** Only adapters interpret vendor-specific keys. Never return credentials. */
export async function readSettingsFile(file:string):Promise<Record<string,any>> {
  try {const value=JSON.parse(await readFile(file,"utf8"));return value && typeof value==="object" && !Array.isArray(value) ? value : {};}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {};throw error;}
}

/**
 * A session records the configuration a turn ran with, never a selection the
 * user made — those live on the Agent, and are re-read every turn. So the whole
 * record is an observation and never pins the model.
 */
export function sessionRuntimeConfig(session:AgentSessionRef|null|undefined):AgentRuntimeConfig|undefined {
  const stored=session?.runtimeConfig;
  return stored && {...stored,observed:true};
}

/** After a model is chosen, the effort and Fast inherited from the original app may not apply to it: override only when the vendor explicitly says it's unsupported, otherwise keep inheriting. */
export function modelSelection(option:AgentModelOption,inherited:AgentRuntimeConfig|undefined):AgentRuntimeConfig {
  const effort=inherited?.reasoningEffort;
  return {model:option.id,source:"ADing",
    ...(effort&&option.efforts?.length&&!option.efforts.includes(effort)&&option.defaultEffort ? {reasoningEffort:option.defaultEffort} : {}),
    ...(inherited?.fastMode===true&&option.supportsFast===false ? {fastMode:false} : {})};
}
