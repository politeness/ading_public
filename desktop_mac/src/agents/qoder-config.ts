import os from "node:os";
import {qoderDesktopSettings} from "./qoder-desktop-config";
import path from "node:path";
import {readFileSync} from "node:fs";
import { p } from "../prompt-language";

const object=(value:any):Record<string,any>=>value && typeof value==="object" && !Array.isArray(value)?value:{};
function merge(base:Record<string,any>,next:Record<string,any>):Record<string,any>{
  const result={...base};for(const [key,value] of Object.entries(next)){
    if(["__proto__","constructor","prototype"].includes(key))continue;
    result[key]=value && typeof value==="object" && !Array.isArray(value)?merge(object(base[key]),value):value;
  }return result;
}
/** Qoder stores newer model controls in per-model preferences, not only model.*. */
export function qoderNativeSettings(kind:AgentKind,cwd:string,selectedModel?:string){
  const folder=kind==="qoder-cn"?".qoder-cn":".qoder",root=(kind==="qoder-cn"?process.env.QODERCN_CONFIG_DIR:process.env.QODER_CONFIG_DIR)||path.join(os.homedir(),folder);
  let settings:Record<string,any>={};
  for(const file of [path.join(root,"settings.json"),path.join(cwd,".qoder","settings.json"),path.join(cwd,".qoder","settings.local.json")]){
    try{settings=merge(settings,object(JSON.parse(readFileSync(file,"utf8"))));}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  const desktop=qoderDesktopSettings(kind,selectedModel||(kind==="qoder-cn"?process.env.QODERCN_MODEL:process.env.QODER_MODEL));
  const model=object(settings.model),name=selectedModel||(kind==="qoder-cn"?process.env.QODERCN_MODEL:process.env.QODER_MODEL)||desktop.model||model.name;
  const preference=object(model.preferences?.[name]),generation=object(preference.generation),reasoning=object(generation.reasoning??preference.reasoning);
  const effort=desktop.reasoningEffort??reasoning.effort??((reasoning.enabled===false||reasoning.thinking?.type==="disabled")?"none":undefined)??preference.reasoningEffort??model.reasoningEffort;
  const switches=object(preference.functionSwitchSelections??model.functionSwitchSelections);
  const fastKey=Object.keys(switches).find(key=>/^high[_-]?speed$/i.test(key)||/^fast([_-]?model)?$/i.test(key));
  const fastValue=fastKey?switches[fastKey]:undefined;
  return {model:name,reasoningEffort:effort,fastMode:fastValue==="true"?true:fastValue==="false"?false:undefined,fastKey,switches,source:desktop.model?desktop.source:"CLI settings"};
}

export function qoderFastSettings(kind:AgentKind,cwd:string,model:string|undefined,fastMode:boolean):string {
  const native=qoderNativeSettings(kind,cwd,model);
  if(!native.fastKey)throw new Error(p("Qoder 未提供当前模型的 Fast 开关映射；请先在原 CLI 的 /model 参数面板配置 Fast，不能静默忽略阿钉的速度配置", "Qoder didn't provide a Fast switch mapping for the current model; configure Fast in the original CLI's /model panel first — ADing's speed setting can't be silently ignored"));
  const switches={...native.switches,[native.fastKey]:String(fastMode)};
  return JSON.stringify({model:{functionSwitchSelections:switches,...(native.model?{preferences:{[native.model]:{functionSwitchSelections:switches}}}:{})}});
}
