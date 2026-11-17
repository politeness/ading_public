import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import { tm } from "../i18n";
import path from "node:path";
import type {ToolPermissionRequest} from "../agents/types";

export const permissionModes: PermissionMode[] = ["manual","leader","unattended"];
export class PermissionPolicy {
  private mode: PermissionMode = "unattended";
  private loaded = false;
  private loading?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<AbortController>();
  constructor(private file: string, private deps: {
    manual(conversation:Conversation,agent:UserRef,request:ToolPermissionRequest):Promise<boolean>;
    review(conversation:Conversation,agent:UserRef,request:ToolPermissionRequest):Promise<boolean | undefined>;
    audit(conversation:Conversation,agent:UserRef,mode:PermissionMode,allowed:boolean):Promise<void>;
  }) {}
  async get(): Promise<PermissionMode> {
    if (!this.loaded) {
      this.loading ??= (async()=>{
        try {
          const saved = JSON.parse(await readFile(this.file,"utf8"));
          if (!permissionModes.includes(saved.mode)) throw Error(tm("main.permission.modeInvalid"));
          this.mode = saved.mode;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.loaded = true;
      })();
      try {await this.loading;} finally {this.loading=undefined;}
    }
    return this.mode;
  }
  set(mode:PermissionMode):Promise<PermissionMode> {
    if (!permissionModes.includes(mode)) return Promise.reject(Error(tm("main.permission.modeUnknown")));
    const save = async () => {
      await this.get();
      await mkdir(path.dirname(this.file),{recursive:true});
      await writeFile(this.file+".tmp",JSON.stringify({mode}),{mode:0o600});
      await rename(this.file+".tmp",this.file);
      this.mode=mode;
      for (const pending of this.pending) pending.abort();
      return mode;
    };
    const next=this.queue.then(save,save);this.queue=next.catch(()=>undefined);return next;
  }
  async request(conversation:Conversation,agent:UserRef,request:ToolPermissionRequest):Promise<boolean> {
    while (!request.signal.aborted) {
      const mode=await this.get();
      const changed=new AbortController();this.pending.add(changed);
      const signal=AbortSignal.any([request.signal,changed.signal]);
      try {
        let allowed:boolean | undefined;
        if (mode === "unattended") allowed=true;
        else if (mode === "manual") allowed=await this.deps.manual(conversation,agent,{...request,signal});
        else {
          allowed=await this.deps.review(conversation,agent,{...request,signal});
          // A missing leader, timeout or ambiguous review never counts as approval.
          if (allowed === undefined && !signal.aborted) allowed=await this.deps.manual(conversation,agent,{...request,signal});
        }
        if (request.signal.aborted) return false;
        if (changed.signal.aborted) continue;
        await this.deps.audit(conversation,agent,mode,!!allowed);
        if (request.signal.aborted) return false;
        if (changed.signal.aborted) continue;
        return !!allowed;
      } catch(error) {
        if(request.signal.aborted)return false;
        if(changed.signal.aborted)continue;
        throw error;
      } finally {this.pending.delete(changed);}
    }
    return false;
  }
}

export function parsePermissionDecision(text:string): {allowed:boolean;reason:string} | undefined {
  const candidate=text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
  try {
    const parsed=JSON.parse(candidate);
    if (["allow","deny"].includes(parsed.decision) && typeof parsed.reason === "string" && parsed.reason.trim()) return {allowed:parsed.decision==="allow",reason:parsed.reason.trim()};
  } catch { /* Natural-language uncertainty is referred to the owner. */ }
  return undefined;
}
