import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { readJsoncSettings as readSettingsFile } from "../platform/jsonc-settings";
import type { AgentRuntimeConfig } from "./types";

export function qwenHome(): string {
  const value = process.env.QWEN_HOME;
  return value ? path.resolve(value.replace(/^~(?=\/|$)/, os.homedir())) : path.join(os.homedir(), ".qwen");
}

/** The settings layers in Qwen's precedence order and the auth type it would resolve. */
async function qwenSettings(workspace: string): Promise<{ layers: any[]; inferred: string }> {
  const root = qwenHome();
  const systemPath = process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH || (process.platform === "darwin"
    ? "/Library/Application Support/QwenCode/settings.json" : process.platform === "win32"
      ? "C:\\ProgramData\\qwen-code\\settings.json" : "/etc/qwen-code/settings.json");
  const defaults = await readSettingsFile(process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(systemPath), "system-defaults.json"));
  const user = await readSettingsFile(path.join(root, "settings.json"));
  const system = await readSettingsFile(systemPath);
  const trust = await readSettingsFile(process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH || path.join(root, "trustedFolders.json"));
  const canonical = async (value: string) => realpath(value).catch(() => path.resolve(value));
  const cwd = await canonical(workspace);
  let matched = -1, trusted = false;
  for (const [location, level] of Object.entries(trust)) {
    if (!["TRUST_FOLDER", "TRUST_PARENT", "DO_NOT_TRUST"].includes(String(level))) continue;
    const base = await canonical(level === "TRUST_PARENT" ? path.dirname(location) : location);
    const relative = path.relative(base, cwd);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      if (base.length > matched || base.length === matched && level === "DO_NOT_TRUST") {
        matched = base.length; trusted = level !== "DO_NOT_TRUST";
      }
    }
  }
  const trustEnabled = system.security?.folderTrust?.enabled ?? user.security?.folderTrust?.enabled ?? defaults.security?.folderTrust?.enabled ?? false;
  const project = trusted || trustEnabled === false ? await readSettingsFile(path.join(workspace, ".qwen/settings.json")) : {};
  const layers = [defaults, user, project, system];
  const auth = Object.assign({}, ...layers.map(layer => layer.security?.auth)).selectedType;
  // Match Qwen's provider inference: a key alone does not select a provider,
  // and Google's GOOGLE_MODEL belongs to Vertex rather than Gemini.
  const env = process.env;
  const inferred = auth || (env.QWEN_OAUTH ? "qwen-oauth" :
    env.OPENAI_API_KEY && (env.OPENAI_MODEL || env.QWEN_MODEL) && env.OPENAI_BASE_URL ? "openai" :
    env.GEMINI_API_KEY && env.GEMINI_MODEL ? "gemini" :
    (env.GOOGLE_API_KEY || env.GOOGLE_CLOUD_PROJECT) && env.GOOGLE_MODEL ? "vertex-ai" :
    env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL && env.ANTHROPIC_BASE_URL ? "anthropic" : "");
  return { layers, inferred };
}

/** Read only configuration fields; never return credentials or past sessions. */
export async function qwenNativeConfiguration(workspace: string): Promise<AgentRuntimeConfig | undefined> {
  const { layers, inferred } = await qwenSettings(workspace);
  const env = process.env;
  const model = Object.assign({}, ...layers.map(layer => layer.model));
  const envKeys: Record<string, string[]> = {
    openai: ["OPENAI_MODEL", "QWEN_MODEL"], "openai-responses": ["OPENAI_MODEL"],
    anthropic: ["ANTHROPIC_MODEL"], gemini: ["GEMINI_MODEL"], "vertex-ai": ["GOOGLE_MODEL"]
  };
  let name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : (envKeys[inferred] ?? []).map(key => env[key]).find(Boolean);
  // Native runtime snapshots can persist a provider-disambiguated display ID;
  // the actual model ID is the tail after the first two pipe-separated parts.
  while (name?.startsWith("$runtime|")) {
    const stripped = name.split("|").slice(2).join("|");
    if (!stripped) break;
    name = stripped;
  }
  const rawEffort = typeof model.reasoningEffort === "string" ? model.reasoningEffort : undefined;
  const effortAliases: Record<string, string> = { low: "low", medium: "medium", med: "medium", high: "high", xhigh: "xhigh", extrahigh: "xhigh", max: "max", maximum: "max" };
  const effort = rawEffort === "none" ? "none" : rawEffort ? effortAliases[rawEffort.trim().toLowerCase().replace(/[\s_-]+/g, "")] : undefined;
  if (!name && !effort) return undefined;
  // fastModel is a separate auxiliary model, NOT a Fast service tier.
  return { model: name, reasoningEffort: effort, source: "Qwen Code CLI settings" };
}

/**
 * The /model picker's catalog: modelProviders for the active auth type. A project
 * section replaces the user section rather than merging. --model only resolves
 * entries of the active provider (any other id becomes a bare Runtime Model), so
 * other providers are not offered, and qwen-oauth is hard-coded and has no catalog.
 */
export async function qwenModelOptions(workspace: string): Promise<AgentModelOption[]> {
  const { layers, inferred } = await qwenSettings(workspace);
  const providers = layers.map(layer => layer.modelProviders).filter(Boolean).at(-1);
  const entries = Array.isArray(providers?.[inferred]) ? providers[inferred] : [];
  const options = new Map<string, AgentModelOption>();
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || !entry.id.trim() || entry.imageOnly || entry.realtimeOnly || options.has(entry.id)) continue;
    const reasoning = entry.capabilities?.reasoning;
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts.filter((item: unknown) => typeof item === "string") : [];
    options.set(entry.id, { id: entry.id, label: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
      description: typeof entry.description === "string" && entry.description ? entry.description : undefined,
      ...(efforts.length ? { efforts } : {}), ...(typeof reasoning?.defaultEffort === "string" ? { defaultEffort: reasoning.defaultEffort } : {}) });
  }
  return [...options.values()];
}

/** Same settings/provider/endpoint precedence as Qwen; never infer capacity from a model name. */
export async function qwenContextWindow(workspace:string,selected?:string):Promise<number|undefined> {
  const {layers,inferred}=await qwenSettings(workspace);
  const model=Object.assign({},...layers.map(layer=>layer.model));
  const native=(await qwenNativeConfiguration(workspace))?.model;
  let name=selected ?? native;
  while(name?.startsWith("$runtime|"))name=name.split("|").slice(2).join("|");
  const providers=layers.map(layer=>layer.modelProviders).filter(Boolean).at(-1);
  const entries=Array.isArray(providers?.[inferred]) ? providers[inferred] : [];
  const entry=entries.find((item:any)=>item.id===name&&(!model.baseUrl||selected&&selected!==native||item.baseUrl===model.baseUrl));
  // A matching provider entry replaces top-level generationConfig, even when absent.
  const value=entry ? entry.generationConfig?.contextWindowSize : (!selected||selected===native) ? model.generationConfig?.contextWindowSize : undefined;
  const configured=typeof value==="number"&&Number.isSafeInteger(value)&&value>=512 ? value : undefined;
  // Local OpenAI-compatible services may expose their actual loaded window.
  // A model's architectural max is not the active server context length.
  const base=entry?.baseUrl ?? model.baseUrl ?? process.env.OPENAI_BASE_URL;
  const loaded=await localLoadedContext(base,name);
  return configured&&loaded ? Math.min(configured,loaded) : loaded??configured;
}

/** Read-only LM Studio metadata on an explicitly configured loopback endpoint.
 * Other servers/versions return unknown; never follow a redirect with credentials. */
export async function localLoadedContext(base:unknown,model:string|undefined):Promise<number|undefined> {
  if(typeof base!=="string"||!model)return undefined;
  try {
    const url=new URL(base);
    if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!["http:","https:"].includes(url.protocol)||url.username||url.password)return undefined;
    // Preserve a configured reverse-proxy prefix, replacing only the OpenAI suffix.
    url.pathname=url.pathname.replace(/\/v1\/?$/,"/").replace(/\/$/,"")+"/api/v1/models";url.search="";url.hash="";
    const response=await fetch(url,{signal:AbortSignal.timeout(1500),redirect:"error"});
    if(!response.ok)return undefined;
    const text=await response.text();if(text.length>2*1024*1024)return undefined;
    const data=JSON.parse(text);
    const windows:number[]=[];
    for(const entry of Array.isArray(data.models)?data.models:[])for(const instance of Array.isArray(entry.loaded_instances)?entry.loaded_instances:[]) {
      if(entry.key!==model&&instance.id!==model)continue;
      const value=instance.config?.context_length;
      if(typeof value==="number"&&Number.isSafeInteger(value)&&value>=512)windows.push(value);
    }
    return windows.length ? Math.min(...windows) : undefined;
  } catch {return undefined;}
}
