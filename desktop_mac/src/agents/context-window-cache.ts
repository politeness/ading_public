import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,rename,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import type {TurnInput} from "./types";

interface Entry {model:string;tokens:number|null;}
/** Capacity belongs to an Agent's model in its native project configuration.
 * No TTL/probe on ordinary sends; changing the selection replaces that entry.
 * Unknown is cached too, while failed probes can be tried again later. */
export class ContextWindowCache {
  private loaded?:Promise<Map<string,Entry>>;
  private readonly selected=new Map<string,string>();
  private readonly flights=new Map<string,Promise<number|undefined>>();
  private writes:Promise<void>=Promise.resolve();
  constructor(private readonly file?:string){}
  private entries():Promise<Map<string,Entry>> {
    return this.loaded??=(async()=>{
      if(!this.file)return new Map();
      try {
        const rows=JSON.parse(await readFile(this.file,"utf8"));
        return new Map<string,Entry>(Array.isArray(rows) ? rows.filter(row=>Array.isArray(row)&&/^[a-f0-9]{64}$/.test(row[0])&&typeof row[1]?.model==="string"&&(row[1].tokens===null||Number.isSafeInteger(row[1].tokens)&&row[1].tokens>=512)) : []);
      }catch{return new Map();}
    })();
  }
  async get(agent:DiscoveredAgent,input:TurnInput,read:()=>Promise<number|undefined>):Promise<number|undefined> {
    const identity=createHash("sha256").update(JSON.stringify([agent.kind,agent.localUuid.split("::")[0],agent.executablePath,agent.version,input.workspacePath])).digest("hex");
    const model=input.runtimeConfig?.model??"";
    this.selected.set(identity,model);
    const entries=await this.entries(),entry=entries.get(identity);
    if(entry?.model===model)return entry.tokens??undefined;
    const key=JSON.stringify([identity,model]);
    const existing=this.flights.get(key);if(existing)return existing;
    const flight=(async()=>{
      const value=await read();
      const tokens=typeof value==="number"&&Number.isSafeInteger(value)&&value>=512 ? value : null;
      if(this.selected.get(identity)===model){
        entries.set(identity,{model,tokens});
        if(entries.size>1000)entries.delete(entries.keys().next().value!);
        await this.persist(entries);
      }
      return tokens??undefined;
    })().finally(()=>{if(this.flights.get(key)===flight)this.flights.delete(key);});
    this.flights.set(key,flight);return flight;
  }
  private persist(entries:Map<string,Entry>):Promise<void> {
    if(!this.file)return Promise.resolve();
    const file=this.file;
    const write=async()=>{
      const candidate=`${file}.${randomUUID()}.candidate`;
      try {await mkdir(path.dirname(file),{recursive:true});await writeFile(candidate,JSON.stringify([...entries]),{mode:0o600});await rename(candidate,file);}
      catch {/* Cache I/O never blocks a turn; memory remains available. */}
      finally{await rm(candidate,{force:true}).catch(()=>undefined);}
    };
    return this.writes=this.writes.then(write,write);
  }
}
let shared=new ContextWindowCache();
export function configureContextWindowCache(file:string):void {shared=new ContextWindowCache(file);}
export function cachedContextWindow(agent:DiscoveredAgent,input:TurnInput,read:()=>Promise<number|undefined>):Promise<number|undefined> {return shared.get(agent,input,read);}
