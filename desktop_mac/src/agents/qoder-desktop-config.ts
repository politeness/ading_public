import os from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {readChromiumPreference} from '../platform/chromium-preferences';
import { p } from "../prompt-language";

function desktopRoot(kind:AgentKind):string|undefined {
 const cn=kind==='qoder-cn',override=cn?process.env.QODERCN_APP_CONFIG_DIR:process.env.QODER_APP_CONFIG_DIR;
 if(!override&&(cn?process.env.QODERCN_CONFIG_DIR:process.env.QODER_CONFIG_DIR))return undefined;
 return override??path.join(os.homedir(),'Library','Application Support',cn?'com.qodercn.app.stable':'com.qoder.app.stable');
}

function queryDatabase(database:string,sql:string):Record<string,unknown>[] {
 const source=existsSync(database+'-wal') ? database : `${pathToFileURL(database).href}?immutable=1`;
 return JSON.parse(execFileSync('/usr/bin/sqlite3',['-readonly','-json',source,sql],{encoding:'utf8',timeout:2000,maxBuffer:1024*1024})||'[]');
}

/** Desktop BYOK selection keys are UI ids, not CLI model ids. Read metadata only;
 * credentials remain owned and loaded by Qoder. Never fall back to a paid default. */
export function qoderCliModel(kind:AgentKind,model:string):string {
 if(!model.startsWith('byok:'))return model;
 const selection=model.slice(5);
 const parts=selection.split('/').map(part=>decodeURIComponent(part));
 if(parts.some(part=>!part||/[\s\0]/.test(part)))throw new Error(p('Qoder 自定义模型标识无效，请在原应用重新选择模型', "Invalid Qoder custom model identifier; select the model again in the original app"));
 // Multi-model custom endpoints encode provider/model separately in the UI.
 if(parts.length===2)return parts.join('/');
 if(parts.length!==1)throw new Error(p('Qoder 自定义模型标识无效，请在原应用重新选择模型', "Invalid Qoder custom model identifier; select the model again in the original app"));
 const id=parts[0],root=desktopRoot(kind),database=root&&path.join(root,'main.sqlite');
 if(database&&existsSync(database)){
  const tables=queryDatabase(database,"SELECT name FROM sqlite_master WHERE type='table' AND name='byok_model_capability_metadata'");
  if(tables.length){
   const rows=queryDatabase(database,`SELECT DISTINCT config_kind,model_key FROM byok_model_capability_metadata WHERE config_id='${id.replace(/'/g,"''")}'`);
   const custom=rows.filter(row=>row.config_kind==='custom');
   if(custom.length){
    if(rows.length!==1||typeof custom[0].model_key!=='string')throw new Error(p('Qoder 自定义模型配置不明确，请在原应用重新选择模型', "The Qoder custom model configuration is ambiguous; select the model again in the original app"));
    return `${id}/${custom[0].model_key}`;
   }
  }
 }
 // Catalog BYOK models use their decoded config id directly.
 return id;
}

/** Provider-specific persisted desktop preferences; never edit the original app. */
export function qoderDesktopSettings(kind:AgentKind,selectedModel?:string){
 const cn=kind==='qoder-cn',root=desktopRoot(kind);
 if(!root)return {};
 if(!existsSync(root))return {};
 const stored=readChromiumPreference(path.join(root,'Local Storage','leveldb'),cn?'qoder-cn-app://renderer':'qoder-app://renderer','qoder:chat-composer:selected-model');
 let model:string|undefined;
 if(stored.value!==undefined){const value=JSON.parse(stored.value);if(typeof value==='string'&&value.trim())model=value;}
 const database=path.join(root,'main.sqlite');let reasoningEffort:string|undefined,fromSession=false;
 if(existsSync(database)){
  // A cleanly closed WAL database may retain WAL mode in its header after the
  // sidecars were removed. sqlite3 -readonly then emits a noisy "unable to open"
  // error because it cannot create shared-memory files. Immutable mode is safe
  // only in that no-WAL case; a running app keeps the normal path so current WAL
  // preferences remain visible.
  const query=(sql:string)=>queryDatabase(database,sql);
  // A deleted composer preference is not a choice of Auto: the desktop app keeps
  // running the model its last session used, so fall back to that whenever the
  // composer key yields no value, tombstoned or absent.
  if(!model){const row=query("SELECT model FROM chat_sessions WHERE deleted_at IS NULL AND archived=0 AND session_kind='standard' AND model IS NOT NULL ORDER BY updated_at DESC LIMIT 1")[0];if(typeof row?.model==='string'){model=row.model;fromSession=true;}}
  const name=selectedModel??model;
  if(name){const row=query(`SELECT reasoning_effort FROM chat_model_preferences WHERE model_key='${name.replace(/'/g,"''")}' LIMIT 1`)[0];if(typeof row?.reasoning_effort==='string')reasoningEffort=row.reasoning_effort;}
 }
 // Only claim Auto when neither the composer nor any past session names a model.
 return {model:model??(stored.found?'auto':undefined),reasoningEffort,source:stored.found&&!fromSession?'desktop composer':'desktop session'};
}
