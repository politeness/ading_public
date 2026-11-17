import path from "node:path";
import {randomUUID} from "node:crypto";
import {ProcessRunner,type ProcessChannel} from "./process-runner";
import {readdir} from "node:fs/promises";
import {readSettingsFile} from "./runtime-config";
import type {AgentRuntimeConfig} from "./types";

/** Desktop Code stores its explicit selector values separately from CLI settings.
 * Only inspect configuration metadata for the signed-in account, never transcripts
 * or cached responses. The most recently focused, unarchived Code session supplies
 * the desktop selection; timestamps describe focus, not background activity.
 */
export async function readClaudeDesktopSelection(root:string):Promise<AgentRuntimeConfig|undefined> {
  const config=await readSettingsFile(path.join(root,"config.json"));
  const account=config.lastKnownAccountUuid;
  if(typeof account!=="string" || !/^[a-zA-Z0-9-]+$/.test(account))return;
  const accountRoot=path.join(root,"claude-code-sessions",account);
  const directories=await readdir(accountRoot,{withFileTypes:true}).catch((error)=>{
    if(error.code==="ENOENT")return [];throw error;
  });
  const orgs=directories.filter(entry=>entry.isDirectory());
  // Without an active-org identifier, do not cross account/organization boundaries.
  if(orgs.length!==1)return;
  const folder=path.join(accountRoot,orgs[0].name);
  const files=await readdir(folder);
  const sessions=await Promise.all(files.filter(name=>/^local_[a-zA-Z0-9-]+\.json$/.test(name)).map(async name=>{
    try{return await readSettingsFile(path.join(folder,name));}catch{return undefined;}
  }));
  const current=sessions.filter(session=>session && session.isArchived===false &&
    typeof session.lastFocusedAt==="number" && Number.isFinite(session.lastFocusedAt))
    .sort((a,b)=>b!.lastFocusedAt-a!.lastFocusedAt)[0];
  if(!current)return;
  const model=typeof current.model==="string" && current.model.trim() ? current.model : undefined;
  const reasoningEffort=typeof current.effort==="string"?current.effort:undefined;
  const fastMode=typeof current.sessionSettings?.fastMode==="boolean" ? current.sessionSettings.fastMode : undefined;
  if(model===undefined && reasoningEffort===undefined && fastMode===undefined)return;
  return {model,reasoningEffort,fastMode,
    source:"Claude Code desktop selection (most recently focused session)"};
}

/** The stream-json initialize response carries the account's model picker; no message is sent, so no quota is used. */
export async function readClaudeModels(agent:DiscoveredAgent,cwd:string):Promise<AgentModelOption[]> {
  let channel:ProcessChannel|undefined,models:AgentModelOption[]|undefined;
  const result=await new ProcessRunner().run(`models:${randomUUID()}`,{executablePath:agent.executablePath,
    args:["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--no-session-persistence"],
    cwd,label:"Claude Code models",timeoutMs:20000,retainLine:()=>undefined,
    onStart:started=>{channel=started;started.write({type:"control_request",request_id:"ading-models",request:{subtype:"initialize"}});},
    onLine:line=>{try {
      const event=JSON.parse(line);
      if(event.type!=="control_response"||event.response?.request_id!=="ading-models")return;
      const listed=event.response?.response?.models;
      if(Array.isArray(listed))models=listed
        // "default" just means no explicit choice, which is what following the app already does.
        .filter((item:any)=>typeof item?.value==="string"&&item.value&&item.value!=="default")
        .map((item:any)=>({id:item.value,label:item.displayName||item.value,description:item.description||undefined,
          ...(Array.isArray(item.supportedEffortLevels) ? {efforts:item.supportedEffortLevels} : {}),
          supportsFast:item.supportsFastMode===true}));
      channel?.end();
    }catch{}}
  });
  if(!models)throw new Error(result.failure||"Claude Code model list unavailable");
  return models;
}
