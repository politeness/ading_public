import path from "node:path";
import {readdir,stat} from "node:fs/promises";
import { p } from "../prompt-language";

/** Execution permits are shared by all work sessions of one task/Agent pair. */
export class WorkSlots {
  private readonly groups = new Map<string, {active:number; queue:Array<()=>void>}>();
  acquire(key:string, limit:number, signal?:AbortSignal):Promise<()=>void> {
    signal?.throwIfAborted();
    let group=this.groups.get(key);
    if (!group) {group={active:0,queue:[]};this.groups.set(key,group);}
    const state=group;
    return new Promise((resolve,reject)=> {
      const abort=()=>{const index=state.queue.indexOf(start);if(index>=0)state.queue.splice(index,1);reject(signal?.reason ?? new Error(p("工作已取消", "The work was cancelled")));cleanup();};
      const cleanup=()=>{if(!state.active&&!state.queue.length)this.groups.delete(key);};
      const start=()=> {
        signal?.removeEventListener("abort",abort);
        state.active++;
        let released=false;
        resolve(()=>{if(released)return;released=true;state.active--;const next=state.queue.shift();if(next)next();cleanup();});
      };
      if (state.active<limit) start();
      else {state.queue.push(start);signal?.addEventListener("abort",abort,{once:true});}
    });
  }
}

export interface ParallelJob {id:string; instruction:string; sharedInstruction?:string; outputs:string[]; dependsOn?:string[]}
export interface OutputInspection {artifacts:string[];missing:string[]}

function outputPatternParts(spec:string):{directory:string;name:string;prefix:string;suffix:string}|undefined {
  const name=path.basename(spec),star=name.indexOf("*");
  if(star<0)return;
  return {directory:path.dirname(spec),name,prefix:name.slice(0,star),suffix:name.slice(star+1)};
}

function outputPatternMatches(pattern:NonNullable<ReturnType<typeof outputPatternParts>>,candidate:string):boolean {
  return candidate.startsWith(pattern.prefix)&&candidate.endsWith(pattern.suffix)&&candidate.length>=pattern.prefix.length+pattern.suffix.length;
}

/** Output claims support one basename wildcard for a runtime-discovered artifact count. */
export function outputSpecsConflict(left:string,right:string):boolean {
  if(left===right||left.startsWith(right+path.sep)||right.startsWith(left+path.sep))return true;
  const a=outputPatternParts(left),b=outputPatternParts(right);
  if(!a&&!b)return false;
  if(a&&b){
    if(a.directory!==b.directory)return a.directory.startsWith(right+path.sep)||b.directory.startsWith(left+path.sep);
    return (a.prefix.startsWith(b.prefix)||b.prefix.startsWith(a.prefix))&&
      (a.suffix.endsWith(b.suffix)||b.suffix.endsWith(a.suffix));
  }
  const pattern=a??b!,exact=a?right:left;
  if(pattern.directory===path.dirname(exact))return outputPatternMatches(pattern,path.basename(exact));
  return pattern.directory.startsWith(exact+path.sep)||exact.startsWith(pattern.directory+path.sep);
}

function resolveOutputSpec(value:string,cwd:string):string {
  const trimmed=value.trim();
  if(/[<>?\[\]{}]/.test(trimmed)||trimmed.split("*").length>2)throw new Error(p(`输出路径不能使用占位符；未知数量请只在文件名中使用一个 *：${trimmed}`, `Output paths can't use placeholders; for an unknown count, use a single * in the file name only: ${trimmed}`));
  const resolved=path.resolve(cwd,trimmed);
  if(path.dirname(resolved).includes("*"))throw new Error(p(`输出通配符只能出现在文件名中：${trimmed}`, `Output wildcards can only appear in the file name: ${trimmed}`));
  return resolved;
}
/** A completion feed lets callers review fast jobs while slow jobs keep running. */
export class CompletionFeed {
  readonly results:unknown[]=[];
  private readonly listeners=new Set<()=>void>();
  constructor(readonly batchId:string,readonly total:number){}
  push(result:unknown):void {this.results.push(result);for(const notify of this.listeners)notify();}
  async next(cursor:number,signal:AbortSignal,waitMs=30_000):Promise<object> {
    if(!Number.isInteger(cursor)||cursor<0||cursor>this.results.length)throw new Error(p("无效的结果游标", "Invalid result cursor"));
    signal.throwIfAborted();
    if(cursor===this.results.length && this.results.length<this.total)await new Promise<void>((resolve,reject)=> {
      const cleanup=()=>{clearTimeout(timer);this.listeners.delete(wake);signal.removeEventListener("abort",abort);};
      const wake=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(signal.reason);};
      const timer=setTimeout(wake,waitMs);
      this.listeners.add(wake);signal.addEventListener("abort",abort,{once:true});
    });
    return {batchId:this.batchId,cursor:this.results.length,results:this.results.slice(cursor),pending:this.total-this.results.length,
      instruction:p("先核验本次返回的产物，可立即处理这些工作的问题；其他工作继续运行。用 batchId 和 cursor 再调用 ading_parallel 获取后续结果，pending 为 0 后才能总结本批次。不要把所有产物的保存、后处理统一留到父会话；仅合并确需共同处理的结果。若用户要求全部、每个或完整覆盖，结束前还必须把原始输入总览、分派清单和实际产物重新对照，文件存在和子任务自报完成都不能证明没有漏项。", "First verify the outputs returned this time; you can handle problems with this work right away while other work keeps running. Call ading_parallel again with batchId and cursor to get further results, and only summarize this batch once pending is 0. Don't leave saving and post-processing of all outputs to the parent session; only merge results that genuinely need joint handling. If the user asked for all, each or complete coverage, before finishing you must also compare the overview of the original input, the dispatch list and the actual outputs again; files existing and sub-tasks reporting completion themselves can't prove nothing was missed.")};
  }
}
const parallelJobItemSchema = {type:"object",properties:{id:{type:"string"},instruction:{type:"string"},dependsOn:{type:"array",items:{type:"string"}},outputs:{type:"array",items:{type:"string"}}},required:["id","instruction","outputs"],additionalProperties:false};

export const parallelTool = {
  type:"function",name:"ading_parallel",deferLoading:false,
  get description(){return p("在当前会话内并行执行有实质耗时的独立工作；每个 job 会占用额外模型上下文，但不是新的顶层聊天。短小同质工作由父会话一次本地工具调用或脚本批量完成通常更快；启动完整子上下文更慢且更费 token。子通道不会复制父会话完整记录：多个 job 时必须把授权范围、共有输入、操作和验收标准完整且精简地写一次到 sharedInstruction，jobs 的 instruction 只写该项差异，避免重复长提示。若用户要求全部、每个、完整覆盖或按可见标记筛选，提交前先从原始输入总览建立紧凑清单，再让每个清单项对应一个 job；清单成员需从内容推断时，另加一个只读 coverage-audit job 独立核对总览并与生产项并发。样本会决定后续同方法任务时，把样本与 dependsOn 样本的后续 jobs 一次提交成依赖图，不要在父会话串行完成样本后再分派。dependsOn 只声明真正需要的上游工作编号，无依赖项立即并发，上游完成立即启动下游。每项包含制作、必要后处理、自检和最终写入；发现缺陷先定位原因，再继续修正直到合格。返修已有可用产物时先写独立候选，对照验收通过后才原子替换，不覆盖唯一可用版本。outputs 写实际必须交付的文件；数量必须运行时识别时，用文件名中单个 * 表示一组文件。默认等待整批结果；很长且需提前核验时使用 stream:true。失败只处理受影响项，不能重复成功工作。提交新批次只能传 jobs/sharedInstruction/stream；读取已有批次只能传 batchId/cursor。", "Run independent work that takes substantial time in parallel within the current conversation; each job uses extra model context, but isn't a new top-level chat. Short, homogeneous work is usually faster done by the parent session in one local tool call or script batch; starting a full sub-context is slower and costs more tokens. Sub-lanes don't copy the parent session's full history: with multiple jobs, write the authorized scope, shared inputs, operations and acceptance criteria once in sharedInstruction, completely and concisely, and have each job's instruction only state what differs for that item, avoiding repeated long prompts. If the user asks for all, each, complete coverage or filtering by visible marks, first build a compact list from the overview of the original input before submitting, then map each list item to one job; when list membership has to be inferred from content, add a separate read-only coverage-audit job that independently checks the overview, running concurrently with the production items. When a sample decides later tasks using the same method, submit the sample and the later jobs that dependsOn it together as one dependency graph, instead of finishing the sample serially in the parent session and then dispatching. dependsOn only declares the upstream work ids that are really needed; items without dependencies run concurrently right away, and downstream items start as soon as upstream ones finish. Each item includes production, necessary post-processing, self-check and final writing; when you find a defect, locate the cause first, then keep fixing until it passes. When reworking an existing usable output, write an independent candidate first and only replace atomically after it passes acceptance, never overwriting the only usable version. outputs lists the files that actually must be delivered; when the count can only be determined at run time, use a single * in the file name to mean a group of files. By default wait for the whole batch's results; use stream:true when it's long and needs early verification. For failures, only handle the affected items, and don't repeat successful work. Submitting a new batch may only pass jobs/sharedInstruction/stream; reading an existing batch may only pass batchId/cursor.");},
  inputSchema:{type:"object",properties:{
    sharedInstruction:{type:"string",minLength:1},stream:{type:"boolean"},
    jobs:{type:"array",minItems:1,maxItems:100,items:parallelJobItemSchema},
    batchId:{type:"string",minLength:1},cursor:{type:"integer",minimum:0}
  },oneOf:[
    {properties:{sharedInstruction:{type:"string",minLength:1},stream:{type:"boolean"},jobs:{type:"array",minItems:1,maxItems:100,items:parallelJobItemSchema}},required:["jobs"],additionalProperties:false},
    {properties:{batchId:{type:"string",minLength:1},cursor:{type:"integer",minimum:0}},required:["batchId"],additionalProperties:false}
  ]}
};

/** Bedrock accepts an object root but rejects root-level schema combinators.
 * Keep all field/item constraints; ParallelExecutor validates submit/poll mode
 * and parseParallelJobs validates the work before anything is dispatched. */
export const objectParallelInputSchema = {
  type:"object",properties:parallelTool.inputSchema.properties,additionalProperties:false
};

/**
 * Qoder clients validate call arguments against the advertised schema before the
 * request reaches ADing, and their models often send `jobs` as a JSON string, which
 * the strict oneOf schema rejects client-side. This variant keeps the same tool and
 * description but leaves shape checks to ADing: arguments are normalized by
 * normalizeParallelArguments and still validated by parseParallelJobs.
 */
// anyOf rather than a union `type`: Qoder's validator runs ajv in strict mode and
// prints a "use allowUnionTypes" warning per union keyword, which ADing then reported
// as the process failure text and hid the real error.
const eitherString = (schema:object) => ({anyOf:[schema,{type:"string"}]});
export const lenientParallelInputSchema = {type:"object",properties:{
  sharedInstruction:{type:"string"},stream:{anyOf:[{type:"boolean"},{type:"string"}]},
  // Keep the per-job fields visible: without them the model omitted every job id.
  jobs:eitherString({type:"array",items:{...parallelJobItemSchema,properties:{...parallelJobItemSchema.properties,
    dependsOn:eitherString({type:"array",items:{type:"string"}}),outputs:eitherString({type:"array",items:{type:"string"}})}}}),
  batchId:{type:"string"},cursor:{anyOf:[{type:"integer"},{type:"string"}]}
}};

/** Undo string-encoded values some clients send; validation stays in parseParallelJobs. */
export function normalizeParallelArguments(value:unknown):unknown {
  if(!value||typeof value!=="object"||Array.isArray(value))return value;
  const args={...(value as Record<string,unknown>)};
  const decode=(v:unknown)=>{if(typeof v!=="string")return v;try{return JSON.parse(v);}catch{return v;}};
  if(typeof args.jobs==="string")args.jobs=decode(args.jobs);
  if(Array.isArray(args.jobs))args.jobs=args.jobs.map(item=>{
    const job=decode(item);
    if(!job||typeof job!=="object"||Array.isArray(job))return job;
    const fields={...(job as Record<string,unknown>)};
    for(const key of ["outputs","dependsOn"])if(typeof fields[key]==="string"){const list=decode(fields[key]);fields[key]=Array.isArray(list)?list:[fields[key]];}
    return fields;
  });
  if(args.stream==="true"||args.stream==="false")args.stream=args.stream==="true";
  if(typeof args.cursor==="string"&&/^\d+$/.test(args.cursor))args.cursor=Number(args.cursor);
  return args;
}

export function parseParallelJobs(value:unknown,cwd:string):ParallelJob[] {
  const request=value as {jobs?:unknown;sharedInstruction?:unknown};
  const jobs=request?.jobs;
  if(request.sharedInstruction!==undefined && (typeof request.sharedInstruction!=="string"||!request.sharedInstruction.trim()))throw new Error(p("sharedInstruction 必须是有效的公共说明", "sharedInstruction must be a valid shared instruction"));
  const shared=typeof request.sharedInstruction==="string" ? request.sharedInstruction.trim() : "";
  if(!Array.isArray(jobs)||!jobs.length||jobs.length>100)throw new Error(p("jobs 必须包含 1 至 100 项工作", "jobs must contain 1 to 100 work items"));
  const ids=new Set<string>(),outputs:string[]=[];
  const parsed:ParallelJob[]=jobs.map(job=> {
    if(!job||typeof job.id!=="string"||!job.id.trim()||ids.has(job.id)||typeof job.instruction!=="string"||!job.instruction.trim()||!Array.isArray(job.outputs)||job.outputs.some((p:unknown)=>typeof p!=="string"||!p.trim()))throw new Error(p("工作编号须唯一，工作说明和输出路径须有效", "Work ids must be unique, and work instructions and output paths must be valid"));
    ids.add(job.id);
    const resolved=job.outputs.map((p:string)=>resolveOutputSpec(p,cwd));
    for(const output of resolved){if(outputs.some(q=>outputSpecsConflict(q,output)))throw new Error(p(`并行产物路径冲突：${output}`, `Parallel output path conflict: ${output}`));outputs.push(output);}
    if(job.dependsOn!==undefined && (!Array.isArray(job.dependsOn)||job.dependsOn.some((id:unknown)=>typeof id!=="string")||new Set(job.dependsOn).size!==job.dependsOn.length))throw new Error(p("dependsOn 必须是不重复的工作编号数组", "dependsOn must be an array of unique work ids"));
    return {id:job.id,instruction:job.instruction.trim(),...(shared?{sharedInstruction:shared}:{}),outputs:resolved,...(job.dependsOn?.length?{dependsOn:job.dependsOn}:{})};
  });
  const visiting=new Set<string>(),visited=new Set<string>(),byId=new Map(parsed.map(job=>[job.id,job]));
  const visit=(id:string)=>{
    if(visited.has(id))return;
    if(visiting.has(id))throw new Error(p("工作依赖存在循环", "Work dependencies contain a cycle"));
    const job=byId.get(id);if(!job)throw new Error(p(`依赖工作不存在：${id}`, `Dependency work doesn't exist: ${id}`));
    visiting.add(id);for(const dep of job.dependsOn??[])visit(dep);visiting.delete(id);visited.add(id);
  };
  for(const job of parsed)visit(job.id);
  return parsed;
}

/** Start every ready node; dependent work never holds a lane while waiting. */
export async function runJobGraph<T extends {ok:boolean}>(jobs:ParallelJob[],run:(job:ParallelJob,dependencies:T[])=>Promise<T>,blocked:(job:ParallelJob)=>T):Promise<T[]> {
  const byId=new Map(jobs.map(job=>[job.id,job])),pending=new Map<string,Promise<T>>();
  const start=(id:string):Promise<T>=>{
    const existing=pending.get(id);if(existing)return existing;
    const job=byId.get(id)!;
    const result=Promise.resolve().then(async()=>{
      const deps=await Promise.all((job.dependsOn??[]).map(start));
      return deps.some(result=>!result.ok)?blocked(job):run(job,deps);
    });
    pending.set(id,result);return result;
  };
  return Promise.all(jobs.map(job=>start(job.id)));
}

export async function inspectOutputs(outputs:string[]):Promise<OutputInspection> {
  const artifacts:string[]=[],missing:string[]=[];
  for(const spec of outputs) {
    const pattern=outputPatternParts(spec);
    if(pattern){
      let names:string[];
      try{names=await readdir(pattern.directory);}catch(error){if(["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??"")){missing.push(spec);continue;}throw error;}
      const matches=names.filter(name=>outputPatternMatches(pattern,name)).sort();
      let delivered=false;
      for(const name of matches){const candidate=path.join(pattern.directory,name);const info=await stat(candidate);if(info.isFile()&&info.size){artifacts.push(candidate);delivered=true;}}
      if(!delivered)missing.push(spec);
      continue;
    }
    try {const info=await stat(spec);if(info.isFile()&&info.size)artifacts.push(spec);else missing.push(spec);}
    catch(error){if(["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))missing.push(spec);else throw error;}
  }
  return {artifacts:[...new Set(artifacts)],missing};
}

export async function missingOutputs(outputs:string[]):Promise<string[]> {return (await inspectOutputs(outputs)).missing;}
