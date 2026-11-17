import path from "node:path";
import {randomUUID} from "node:crypto";
import {removeTree} from "../platform/remove-tree";
import {makeScratchDirectory} from "./scratch";
import {WorkSlots,CompletionFeed,parseParallelJobs,inspectOutputs,outputSpecsConflict,runJobGraph} from "./parallel-work";
import {executionPlanPrompt,parseExecutionPlan} from "./execution-plan";
import type {TurnInput,AgentRuntimeConfig} from "./types";
import {mergeRuntimeConfigSnapshot} from "./runtime-config";
import {mergeTurnMetrics} from "./token-usage";
import { p } from "../prompt-language";

type ExecuteTurn = (agent:DiscoveredAgent,input:TurnInput)=>Promise<AgentTurnOutcome>;
type WorkResult={id:string;ok:boolean;state:string;failureKind?:string;threadId?:string;outputs:string[];message?:string;error?:string};
const compactResult=(value:string|undefined,limit=1600)=>value&&value.length>limit ? p(`${value.slice(0,limit)}\n…（子任务长回复已截断，产物路径和状态由共享执行层单独保留）`, `${value.slice(0,limit)}\n… (long sub-task reply truncated; output paths and status are kept separately by the shared execution layer)`) : value;
const childStartupNoise=/^(?:等待当前会话的并行执行容量|正在启动(?:…|\.\.\.)?$|正在连接|已连接(?:$|[：:])|模型配置[：:])/;
const commonChildPrompt=(job:ReturnType<typeof parseParallelJobs>[number],unattended:boolean)=>p(`你是同一个 Agent 的临时并行执行通道，只完成一个已分派工作。父会话完整聊天记录不会复制到这里；下面的公共要求和本项差异构成完整执行边界，不猜测或扩展范围。不要创建其他会话、委派或重做其他工作。

本批公共要求：
${job.sharedInstruction??"遵守用户给定的输入范围和验收标准；只处理本项明确指定的对象。"}

速度优先交付约定：直接使用当前可行方法，不做与交付无关的环境、帮助命令或可选参考资料探测；仅在真实报错或缺少必要语法时补查。合并可一次完成的读取、命令和检查，不发送非必要阶段说明。发现缺陷先定位原因，再继续修正直到符合要求。返修已有可用文件时先写独立候选，验收通过后才原子替换，不覆盖唯一可用版本。必须实际完成必要制作、后处理、自检和保存；完成后立即用不超过 800 字报告产物路径、验证结果和遗留问题。${unattended?"本通道已继承无人值守权限，厂商原生快速授权已开启，不要再次请求宿主逐项审批。":"需要权限时使用正常审批，未获授权不得绕过。"}`, `You are a temporary parallel execution lane of the same Agent, completing only one dispatched piece of work. The parent session's full chat history isn't copied here; the shared requirements and this item's specifics below make up the complete execution boundary — don't guess or expand the scope. Don't create other sessions, delegate, or redo other work.

Shared requirements for this batch:
${job.sharedInstruction??"Follow the input scope and acceptance criteria the user gave; only process the objects this item explicitly names."}

Speed-first delivery conventions: use the currently workable method directly, without probing the environment, help commands or optional reference material unrelated to delivery; only look things up on a real error or when necessary syntax is missing. Combine reads, commands and checks that can be done at once, and don't send unnecessary stage notes. When you find a defect, locate the cause first, then keep fixing until it meets the requirements. When reworking an existing usable file, write an independent candidate first and only replace atomically after it passes acceptance, never overwriting the only usable version. You must actually complete the necessary production, post-processing, self-check and saving; when done, immediately report the output paths, verification results and remaining issues in no more than 800 words. ${unattended?"This lane has inherited unattended permissions and the vendor's native fast authorization is on; don't ask the host for item-by-item approval again.":"When you need permissions, use the normal approval process; don't bypass it without authorization."}`);
/** Provider-independent lanes: shared capacity, output ownership and cancellation. */
export class ParallelExecutor {
  private readonly workSlots = new WorkSlots();
  private readonly parallelOutputs = new Map<string,Set<string>>();
  async run(agent:DiscoveredAgent,input:TurnInput,execute:ExecuteTurn):Promise<AgentTurnOutcome> {
    const config=input.parallelWork;
    if(!config || !input.fullAccess || input.discussionOnly || input.communicationOnly) return execute(agent,input);
    let runtimeConfig=input.runtimeConfig;
    const rememberModel=(snapshot:AgentRuntimeConfig)=>{runtimeConfig=mergeRuntimeConfigSnapshot(runtimeConfig,snapshot);input.onRuntimeConfig?.(runtimeConfig);};
    const scope=new AbortController();
    const signal=input.signal ? AbortSignal.any([input.signal,scope.signal]) : scope.signal;
    const sessionBudget=Math.max(1,Math.min(11,Math.floor(config.sessionBudget??1)||1));
    const canFanOut=config.allowSplit&&sessionBudget>1;
    // The parent provider session remains alive while its tool call waits. Leave
    // one budget slot for it so total concurrent provider sessions stay bounded.
    const limit=Math.max(1,Math.min(10,sessionBudget-1,Math.floor(config.limit)||10));
    let release:(()=>void)|undefined;
    let splitting=0;
    // Each batch's wrap-up (release output claims, delete lane temp directories, splitting--, reclaim the parent lane);
    // the last page of results is handed over only after it finishes; see lastPageAfterBookkeeping
    const bookkeeping=new Map<string,Promise<unknown>>();
    const lastPageAfterBookkeeping=async(page:unknown,batchId:string)=>{
      // The parent session ends the turn once pending is 0; if batch wrap-up isn't done yet, splitting is still above 0,
      // and the end check would misjudge it as "parent session ended early with parallel work undelivered". So the last page waits for wrap-up
      if(!(page as {pending?:number}).pending)await bookkeeping.get(batchId)?.then(()=>undefined,()=>undefined);
      return page;
    };
    const feeds=new Map<string,CompletionFeed>();
    const batches:Promise<unknown>[]=[];
    const childMetrics:TurnMetrics[]=[];
    let acquiring:Promise<void>|undefined;
    const acquire=async()=>{
      if(release)return;
      if(!acquiring){input.onProgress(p("等待当前会话的并行执行容量", "Waiting for parallel execution capacity for the current conversation"));acquiring=this.workSlots.acquire(config.key,limit,signal).then(slot=>{release=slot;}).finally(()=>{acquiring=undefined;});}
      await acquiring;
    };
    try {
      if(config.executionSlot)await acquire();
      if(input.canStartWork && !input.canStartWork())return {
        ok:false,notStarted:"agent-unavailable",
        error:p("Agent 当前不可用，未启动排队工作；请检查额度、登录或连接状态", "The Agent is currently unavailable and the queued work wasn't started; check quota, login or connection status"),
        cancelled:signal.aborted,steps:[],metrics:{iterations:0,sideEffects:false}
      };
      const onParallelWork=canFanOut ? async (args:unknown,requestSignal:AbortSignal)=> {
        const request=args as {batchId?:string;cursor?:number;sharedInstruction?:string;stream?:boolean;jobs?:unknown};
        if(request?.batchId){
          if(request.jobs!==undefined)throw new Error(p("不能同时提交工作与读取批次", "Can't submit work and read a batch at the same time"));
          const feed=feeds.get(request.batchId);if(!feed)throw new Error(p("批次不存在于当前会话，先核对已交付文件；不要盲目重做", "The batch doesn't exist in the current session; check the delivered files first, and don't blindly redo the work"));
          return lastPageAfterBookkeeping(await feed.next(request.cursor??0,requestSignal),request.batchId);
        }
        const jobs=parseParallelJobs(args,input.workspacePath);
        const feed=new CompletionFeed(randomUUID(),jobs.length);feeds.set(feed.batchId,feed);
        const batch=(async()=> {
          const claims=this.parallelOutputs.get(config.key)??new Set<string>();
          const outputs=jobs.flatMap(job=>job.outputs);
          for(const output of outputs)if([...claims].some(q=>outputSpecsConflict(q,output)))throw new Error(p(`其他工作正在写入相同产物：${output}`, `Other work is writing the same output: ${output}`));
          outputs.forEach(p=>claims.add(p));this.parallelOutputs.set(config.key,claims);splitting++;
          try {
          // A parent waiting for its children does not consume an execution lane.
          if(acquiring)await acquiring;
          release?.();release=undefined;
          const results=await runJobGraph<WorkResult>(jobs,async (job,dependencies)=> {
            const workId=`${job.id}:${randomUUID()}`;
            const unattended=input.fullAccess&&input.permissionMode==="unattended";
            input.onProgress(p(`并行工作 ${job.id}：已排队（当前会话每 Agent 最多 ${limit} 路）`, `Parallel work ${job.id}: queued (at most ${limit} lanes per Agent for the current conversation)`));
            // Lane-specific temp directory. Declared outside the try so it gets deleted however the lane ends (see the finally below)
            let scratchPath:string|undefined;
            try {
              let lastProgress="";
              const childProgress=(text:string)=>{const normalized=text.trim();if(!normalized||childStartupNoise.test(normalized)||normalized===lastProgress)return;lastProgress=normalized;input.onProgress(p(`并行工作 ${job.id}：${normalized}`, `Parallel work ${job.id}: ${normalized}`));};
              const isolatedExecute:ExecuteTurn=async(child,turn)=>{
                // config.key is "task:Agent" and job.id is this lane's work; leftovers can be traced back to their source
                scratchPath??=await makeScratchDirectory("work",...config.key.split(":"),job.id);
                return execute(child,{...turn,prompt:p(`${turn.prompt}\n\n本执行通道专属临时目录：${scratchPath}\n所有临时脚本、裁图、调试文件和缓存必须写在此目录内；不得写 /tmp/z1.png 等公共固定文件名，也不得使用其他通道的临时文件。可在命令中设置 TMPDIR 为此目录。最终交付仍写指定输出路径，工作目录与审批边界不变。`, `${turn.prompt}\n\nThis execution lane's own temp directory: ${scratchPath}\nAll temporary scripts, crops, debug files and caches must be written in this directory; don't write public fixed file names like /tmp/z1.png, and don't use other lanes' temp files. You can set TMPDIR to this directory in commands. Final deliverables still go to the specified output paths; the working directory and approval boundaries are unchanged.`)});
              };
              const outcome=await this.run({...agent,localUuid:`${agent.localUuid}::parallel:${workId}`},{
                ...input,threadId:undefined,steerable:false,signal:requestSignal,onParallelWork:undefined,runtimeConfig,onRuntimeConfig:rememberModel,
                onPermission:unattended?undefined:input.onPermission,
                parallelWork:{...config,executionSlot:true,allowSplit:false,planBeforeExecution:false},
                prompt:p(`${commonChildPrompt(job,unattended)}\n\n唯一当前工作 ${job.id}：\n${job.instruction}\n输出路径：${job.outputs.join("、")||"返回只读分析结果"}`, `${commonChildPrompt(job,unattended)}\n\nThe only current work ${job.id}:\n${job.instruction}\nOutput paths: ${job.outputs.join(", ")||"return a read-only analysis result"}`),
                ...(dependencies.length ? {prompt:p(`${commonChildPrompt(job,unattended)}\n\n唯一当前依赖工作 ${job.id}：\n${job.instruction}\n必须交付：${job.outputs.join("、")||"只读结果"}\n上游已完成结果：\n${JSON.stringify(dependencies.map(d=>({...d,message:compactResult(d.message)})))}\n核对上游实际文件后直接完成、自检并保存；不重复上游工作。`, `${commonChildPrompt(job,unattended)}\n\nThe only current dependent work ${job.id}:\n${job.instruction}\nMust deliver: ${job.outputs.join(", ")||"read-only result"}\nCompleted upstream results:\n${JSON.stringify(dependencies.map(d=>({...d,message:compactResult(d.message)})))}\nCheck the actual upstream files, then complete, self-check and save directly; don't repeat the upstream work.`)} : {}),
                onProgress:childProgress,
                onAudit:event=>input.onAudit?.({...event,id:`${workId}:${event.id??""}`,parallelWorkId:workId})
              },isolatedExecute);
              childMetrics.push(outcome.metrics);
              const inspected=outcome.ok ? await inspectOutputs(job.outputs) : {artifacts:[],missing:[]};
              const ok=outcome.ok&&!inspected.missing.length;
              const error=inspected.missing.length ? p(`声明的产物不存在或为空，或不是文件：${inspected.missing.join("、")}`, `Declared outputs don't exist, are empty or aren't files: ${inspected.missing.join(", ")}`) : outcome.ok ? undefined : outcome.error;
              if(!outcome.ok && !outcome.cancelled)await input.onWorkFailure?.(outcome.error);
              input.onProgress(p(`并行工作 ${job.id}：${ok ? "已交付，待核验" : `未完成：${error}`}`, `Parallel work ${job.id}: ${ok ? "delivered, pending verification" : `not finished: ${error}`}`));
              const result={id:job.id,ok,state:ok ? "delivered" : "blocked",failureKind:inspected.missing.length ? "missing_outputs" : outcome.ok ? undefined : outcome.cancelled ? "cancelled" : "execution_failed",threadId:outcome.threadId,outputs:inspected.artifacts.length ? inspected.artifacts : job.outputs,message:compactResult(outcome.ok ? outcome.message : outcome.partialMessage),error:compactResult(error)};
              feed.push(result);return result;
            } catch(error) {const result={id:job.id,ok:false,state:"blocked",failureKind:"execution_failed",error:String(error),outputs:job.outputs};feed.push(result);return result;}
            finally {
              job.outputs.forEach(p=>claims.delete(p));
              // The lane's temp directory lives and dies with the lane: otherwise every parallel run would leave in the system temp directory
              // a copy of the sub-Agent's temp scripts, crops and caches that nobody ever cleans. Final outputs go to the paths declared in job.outputs,
              // not this directory (the prompt requires the same of sub-Agents), so deleting it doesn't affect delivery.
              if(scratchPath)await removeTree(scratchPath).catch(()=>undefined);
            }
          },job=>{
            const result={id:job.id,ok:false,state:"blocked",failureKind:"dependency_failed",outputs:job.outputs,error:p("上游工作未完成，本项未执行；其他独立工作继续", "Upstream work isn't finished, so this item wasn't run; other independent work continues")};
            input.onProgress(p(`并行工作 ${job.id}：依赖受阻，未启动`, `Parallel work ${job.id}: blocked by a dependency, not started`));feed.push(result);return result;
          });
          return {results,instruction:p("逐项检查结果和实际产物；只重试有明确可恢复原因的失败项，保留成功产物。若用户范围含全部、每个或完整覆盖，必须重新查看原始输入总览并与分派项、产物逐项对照，主动发现漏项或多选；产物数量和子任务自报完成不是完整性证据。需要用户处理的失败明确说明原因。", "Check the results and actual outputs item by item; only retry failures that have a clear recoverable cause, and keep successful outputs. If the user's scope includes all, each or complete coverage, you must look at the overview of the original input again and compare it item by item with the dispatched items and outputs, actively finding omissions or extra selections; the number of outputs and sub-tasks reporting completion themselves aren't evidence of completeness. For failures that need the user to act, state the reason clearly.")};
          } finally {outputs.forEach(p=>claims.delete(p));if(!claims.size)this.parallelOutputs.delete(config.key);splitting--;if(!splitting&&config.executionSlot&&!signal.aborted)await acquire();}
        })();
        batches.push(batch);
        bookkeeping.set(feed.batchId,batch);
        if(request?.stream){
          // Propagate validation failures; a streaming caller otherwise observes
          // completed jobs through the feed while this promise keeps executing.
          return Promise.race([feed.next(0,requestSignal),batch.then(()=>feed.next(0,requestSignal))])
            .then(page=>lastPageAfterBookkeeping(page,feed.batchId));
        }
        return batch;
      } : undefined;
      let executionInput=input;
      if(config.planBeforeExecution && onParallelWork){
        input.onProgress(p("正在识别独立工作和真实依赖", "Identifying independent work and real dependencies"));
        const planning=await execute(agent,{...input,threadId:undefined,signal,fullAccess:false,discussionOnly:false,communicationOnly:false,
          parallelWork:undefined,onParallelWork:undefined,onPermission:input.onPermission,timeoutMs:45_000,
          runtimeConfig,onRuntimeConfig:rememberModel,prompt:executionPlanPrompt(input.prompt),
          onProgress:text=>input.onProgress(p(`执行拆分：${text}`, `Execution split: ${text}`))});
        const planningTimedOut=!planning.ok&&!planning.cancelled&&!planning.metrics.sideEffects&&/超过\s*\d+\s*秒|timed out|timeout exceeded/i.test(planning.error??"");
        if(!planning.ok&&!planningTimedOut)return {...planning,threadId:input.threadId};
        signal.throwIfAborted();
        const fallbackPlan=(reason:string)=>({decision:"direct" as const,reason,evidence:p("规划未返回可靠计划。不要重复整套预检；利用用户已给出的输入和范围开始执行，独立工作可直接使用并发工具分派。不得把规划失败当成交付成功。", "Planning didn't return a reliable plan. Don't repeat the whole pre-check; start executing using the input and scope the user already gave, and dispatch independent work directly with the concurrency tools. Don't treat a planning failure as successful delivery.")});
        let plan:ReturnType<typeof parseExecutionPlan>;
        if(planningTimedOut)plan=fallbackPlan(p("只读拆分超时，回退正常执行，任务尚未完成", "The read-only split timed out; falling back to normal execution. The task isn't finished"));
        else try{plan=parseExecutionPlan(planning.ok?planning.message:"",input.workspacePath);}
        catch(error){
          if(planning.metrics.sideEffects)throw error;
          plan=fallbackPlan(p("只读拆分返回了无效计划，回退正常执行，任务尚未完成", "The read-only split returned an invalid plan; falling back to normal execution. The task isn't finished"));
        }
        input.onProgress(p(`执行拆分：${plan.reason}`, `Execution split: ${plan.reason}`));
        if(plan.decision==="parallel"){
          input.onProgress(p(`自动调度 ${plan.jobs!.length} 项工作，无依赖项立即并发，依赖完成后补位`, `Automatically scheduling ${plan.jobs!.length} work items: items without dependencies run concurrently right away, others fill in as dependencies complete`));
          const sharedInstruction=[plan.evidence?.trim()?p(`只读预检已确认（直接复用，除非后续发现冲突证据，否则不要重新扫描）：${plan.evidence.trim()}`, `Confirmed by the read-only pre-check (reuse directly; don't rescan unless conflicting evidence turns up later): ${plan.evidence.trim()}`):"",plan.sharedInstruction??""].filter(Boolean).join("\n\n");
          let page=await onParallelWork({jobs:plan.jobs,...(sharedInstruction?{sharedInstruction}:{}),stream:true},signal) as {batchId:string;cursor:number;results:WorkResult[];pending:number};
          const completed:WorkResult[]=[];
          while(true){
            completed.push(...page.results);
            for(const result of page.results)input.onProgress(p(`并行进度 ${completed.length}/${plan.jobs!.length}：${result.id} ${result.ok ? "已交付，待总体验收" : "未完成"}`, `Parallel progress ${completed.length}/${plan.jobs!.length}: ${result.id} ${result.ok ? "delivered, pending overall acceptance" : "not finished"}`));
            if(!page.pending)break;
            page=await onParallelWork({batchId:page.batchId,cursor:page.cursor},signal) as typeof page;
          }
          // The last result reaches the feed just before batch bookkeeping releases
          // output claims and restores the parent lane. Finish that bookkeeping before verification.
          await Promise.all(batches);
          const resultById=new Map(completed.map(result=>[result.id,result]));
          const batch={results:plan.jobs!.map(job=>resultById.get((job as {id:string}).id)!).filter(Boolean)};
          signal.throwIfAborted();
          const messageLimit=Math.min(4000,Math.floor(60_000/Math.max(1,batch.results.length)));
          const summary=batch.results.map(result=>({...result,message:result.message?.slice(0,messageLimit)}));
          executionInput={...input,
            ...(batch.results.every(result=>result.ok)?{fullAccess:false}:{}),
            prompt:p(`${input.prompt}\n\n系统已按执行计划完成调度，不要从头执行原任务或重做成功项。\n只读阶段发现：${plan.evidence??"无额外发现"}\n工作结果（长回复已截取，产物路径与状态完整保留）：${JSON.stringify(summary)}\n现在做独立总体验收并向用户报告。重新读取原始输入与实际产物，逐项核对：应交付对象是否选对、是否遗漏或多选，以及每个文件的内容、格式、保存路径是否符合用户要求；不能把子执行通道的自检或一句“完成”当成验收证据。全部子项交付时当前为只读验收阶段，不得重写或重新生成；发现实际缺陷如实报告，不能声称全部通过。只处理结果中明确未完成的部分；不得把上游失败的依赖项当成功，不自动重试无可恢复依据的失败。已有文件先检查，再做必要修正。`, `${input.prompt}\n\nThe system has finished scheduling according to the execution plan; don't execute the original task from scratch or redo successful items.\nRead-only stage findings: ${plan.evidence??"no additional findings"}\nWork results (long replies trimmed; output paths and status kept in full): ${JSON.stringify(summary)}\nNow do an independent overall acceptance and report to the user. Re-read the original input and the actual outputs and check item by item: whether the objects to deliver were chosen correctly, whether anything was missed or extra, and whether each file's content, format and save path meet the user's requirements; don't take a sub-lane's self-check or a single "done" as acceptance evidence. When all sub-items are delivered, this is a read-only acceptance stage: don't rewrite or regenerate; report actual defects truthfully, and don't claim everything passed. Only handle the parts the results explicitly mark as unfinished; don't treat dependent items whose upstream failed as successful, and don't automatically retry failures with no basis for recovery. Check existing files first, then make the necessary corrections.`)};
        }else executionInput={...input,prompt:p(`${input.prompt}\n\n执行前已判断本轮直接完成：${plan.reason}\n已有只读发现：${plan.evidence??"无"}\n无需再次进行完整预检或向用户复述计划，继续完成任务。`, `${input.prompt}\n\nBefore execution it was decided to finish this round directly: ${plan.reason}\nExisting read-only findings: ${plan.evidence??"none"}\nNo need to do another full pre-check or restate the plan to the user; continue and finish the task.`)};
      }
      const outcome=await execute(agent,{...executionInput,signal,onParallelWork:executionInput.fullAccess?onParallelWork:undefined,hasPendingWork:()=>splitting>0,runtimeConfig,onRuntimeConfig:rememberModel});
      const parentEndedWithPendingWork=splitting>0;
      if(parentEndedWithPendingWork)await Promise.allSettled(batches);
      const metrics=mergeTurnMetrics(outcome.metrics,...childMetrics);
      if(outcome.ok&&parentEndedWithPendingWork)return {ok:false,threadId:outcome.threadId,error:p("父会话提前结束，仍有并行工作未交付；已有文件保留，请核对后继续未完成项", "The parent session ended early with parallel work still undelivered; existing files are kept. Check them, then continue the unfinished items"),partialMessage:outcome.message,cancelled:false,steps:outcome.steps,metrics};
      return {...outcome,metrics};
    } catch(error) {
      return {ok:false,error:String(error),cancelled:signal.aborted,steps:[],metrics:{iterations:0,sideEffects:false}};
    } finally {scope.abort();release?.();await Promise.allSettled(batches);release?.();}
  }
}
