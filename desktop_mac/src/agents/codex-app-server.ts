import {computerDynamicTools,computerToolsEnabled,isComputerTool,runComputerTool,toCodexContent} from "./computer-tools";
import {clientInfo} from "./client-info";
import {ProcessRunner,type ProcessChannel} from "./process-runner";
import {codexChildEnvironment} from "./codex-environment";
import type {SteerInput,SteerResult,TurnInput} from "./types";
import {parallelTool} from "./parallel-work";
import type {AgentRuntimeConfig} from "./types";
import {codexRuntimeConfig,codexServiceTier} from "./codex-config";
import {recordTokenUsage,setTokenUsage} from "./token-usage";
import {ToolLoopGuard} from "./tool-loop-guard";
import { p, p as localized } from "../prompt-language";
import { log } from "../orchestration/diagnostics";
import {isKnowledgeTool,knowledgeTools,runKnowledgeTool} from "../knowledge/tools";

export type RegisterCodexSteer=(handler:(input:SteerInput)=>Promise<SteerResult>)=>()=>void;

/** An owned stdio app-server exposes approvals and same-turn steering. */
export async function runCodexWithApprovals(runner:ProcessRunner,agent:DiscoveredAgent,input:TurnInput,registerSteer?:RegisterCodexSteer,env:NodeJS.ProcessEnv=codexChildEnvironment()):Promise<AgentTurnOutcome> {
  let channel:ProcessChannel;
  let threadId=input.threadId,turnId:string | undefined;
  let message="",legacyMessage="",error="",completed=false;
  let approvalCount=0;
  const scope=new AbortController();
  const signal=input.signal ? AbortSignal.any([input.signal,scope.signal]) : scope.signal;
  const pending=new Map<string,AbortController>();
  const nativeChildren=new Set<string>();
  const nativeChildTurns=new Map<string,string>();
  const nativeChildControllers=new Map<string,AbortController>();
  const ownedThread=(id:unknown):id is string=>typeof id==="string"&&(id===threadId||nativeChildren.has(id));
  const recordNativeChildren=(event:any)=>{
    if(!threadId)return;
    if(event.method==="thread/started") {
      const child=event.params?.thread;
      const parent=child?.parentThreadId??child?.source?.subAgent?.thread_spawn?.parent_thread_id;
      if(typeof child?.id==="string"&&child.id!==threadId&&ownedThread(parent))nativeChildren.add(child.id);
    }
    const owner=event.params?.threadId;
    if(!ownedThread(owner))return;
    const active=owner===threadId ? turnId : nativeChildTurns.get(owner);
    const item=event.params?.item;
    if(event.method==="item/completed"&&item?.type==="collabAgentToolCall"&&item.tool==="spawnAgent"&&item.status==="completed"&&active&&event.params?.turnId===active&&item.senderThreadId===owner&&Array.isArray(item.receiverThreadIds)) {
      for(const receiver of item.receiverThreadIds)if(typeof receiver==="string"&&receiver!==threadId)nativeChildren.add(receiver);
    }
    if(nativeChildren.has(owner)) {
      if(event.method==="turn/started"&&typeof event.params?.turn?.id==="string") {
        if(event.params.turn.id!==nativeChildTurns.get(owner)){nativeChildControllers.get(owner)?.abort();nativeChildControllers.set(owner,new AbortController());}
        nativeChildTurns.set(owner,event.params.turn.id);
      }
      if(event.method==="turn/completed"&&event.params?.turn?.id===nativeChildTurns.get(owner)) {
        nativeChildTurns.delete(owner);nativeChildControllers.get(owner)?.abort();nativeChildControllers.delete(owner);
      }
    }
  };
  const steerRequests=new Map<number,{resolve:(result:SteerResult)=>void;timer:NodeJS.Timeout}>();
  // Codex records steered input as a userMessage item of the active turn before
  // sampling again. Only a final answer item started after that echo has seen it.
  const steersSent:{content:string;id:string}[]=[];
  const steersEchoed:string[]=[];
  const steersSeen=new Set<string>();
  const messageSteers=new Map<string,string[]>();
  const receiveUserItem=(item:any)=>{
    if(item?.type!=="userMessage"||!steersSent.length)return;
    const text=(Array.isArray(item.content) ? item.content : []).filter((part:any)=>part?.type==="text").map((part:any)=>part.text).join("");
    const index=steersSent.findIndex(steer=>steer.id===item.clientId||steer.content===text);
    if(index>=0)steersEchoed.push(steersSent.splice(index,1)[0].id);
  };
  let nextSteerId=10_000;
  let unregisterSteer:(()=>void)|undefined;
  const items=new Map<string,Record<string,unknown>>();
  const steps:string[]=[];
  const metrics:TurnMetrics={iterations:0,sideEffects:false};
  const loopGuard=new ToolLoopGuard();
  const record=(text:string)=>{if(steps.at(-1)!==text)steps.push(text);input.onProgress(text);};
  const receiveMessage=(item:any,progress=true)=>{
    if(item.type!=="agentMessage" || typeof item.text!=="string" || !item.text.trim())return;
    if(item.phase==="commentary"){
      if(progress)record(p(`进展：${item.text}`, `Progress: ${item.text}`));
    } else if(item.phase==="final_answer"||item.phase==null){
      if(item.phase==null)legacyMessage=item.text; // Older models leave phase null or absent.
      else message=item.text;
      if(progress)for(const id of messageSteers.get(item.id) ?? [])steersSeen.add(id);
    }
  };
  const send=(id:number,method:string,params:unknown)=>channel.write({id,method,params});
  let modelSnapshot=input.runtimeConfig;
  const unattended=input.fullAccess&&input.permissionMode==="unattended";
  const describeModel=(snapshot:AgentRuntimeConfig)=>[snapshot.model,snapshot.reasoningEffort ? p(`推理 ${snapshot.reasoningEffort}`, `reasoning ${snapshot.reasoningEffort}`) : "",snapshot.serviceTier ? p(`服务 ${snapshot.serviceTier}`, `service ${snapshot.serviceTier}`) : ""].filter(Boolean).join(" · ");
  const baseConfig=input.isolateMemory ? {"features.memories":false,"memories.generate_memories":false,"memories.use_memories":false} : {};
  // The part ADing generates goes into developerInstructions, and this turn's input keeps only the conversation —
  // so in Codex's own UI the user sees what they said, not scaffolding assembled by ADing.
  // Both thread/start and thread/resume accept this parameter, so it can be refreshed every turn and can hold changing state.
  const threadConfig=()=>({
    ...(input.split ? {developerInstructions:input.split.app} : {}),
    cwd:input.workspacePath,approvalPolicy:unattended?"never":"on-request",approvalsReviewer:"user",sandbox:unattended?"danger-full-access":"read-only",
    ...(modelSnapshot?.model ? {model:modelSnapshot.model} : {}),
    config:{...baseConfig,...(modelSnapshot?.reasoningEffort ? {model_reasoning_effort:modelSnapshot.reasoningEffort} : {}),...(codexServiceTier(modelSnapshot) ? {service_tier:codexServiceTier(modelSnapshot)} : {})},
    // Dynamic tools can only be registered when a session is created, and resumed sessions keep them. A task's session is often created during discussion,
    // so on macOS computer-use tools are included at creation, and whether they're usable is decided per turn at call time.
    ...(!input.threadId && (input.onParallelWork || input.onKnowledgeTool || process.platform==="darwin")
      ? {dynamicTools:[{type:"namespace",name:"ading",description:p("阿钉共享工具", "ADing shared tools"),tools:[...(input.onParallelWork ? [parallelTool] : []),...(process.platform==="darwin" ? computerDynamicTools() : []),...(input.onKnowledgeTool ? knowledgeTools() : [])].map(tool=>({...tool,type:"function"}))}]}
      : {})
  });
  const beginThread=()=>send(3,input.threadId ? "thread/resume" : "thread/start",{...threadConfig(),...(input.threadId ? {threadId:input.threadId,excludeTurns:true} : {})});
  // Codex puts a write lock on each session. ADing's sessions appear in the ChatGPT / Codex desktop app lists, and once opened there the app holds the lock,
  // so resuming only gets "already has an active writer". In that case fork a copy (keeping history and dynamic tools) and continue,
  // saving the new session ID with this turn's result and resuming that one from then on.
  let forkedFrom:string|undefined;
  const forkLockedThread=(e:any)=>{
    if(e.id!==3||!input.threadId||forkedFrom||!/already has an active writer/i.test(String(e.error?.message??"")))return false;
    forkedFrom=input.threadId;
    void log("codex-thread-forked",{agent:agent.localUuid,threadId:input.threadId,reason:String(e.error.message).slice(0,300)});
    record(p("原会话正被其他程序（例如 ChatGPT 或 Codex 桌面版）占用，已复制一份会话继续", "The original session is held by another program (such as the ChatGPT or Codex desktop app); continuing in a copy of it"));
    send(3,"thread/fork",{...threadConfig(),threadId:input.threadId,excludeTurns:true});
    return true;
  };
  const exposeSteering=()=>{
    if(unregisterSteer||!registerSteer||!threadId||!turnId)return;
    unregisterSteer=registerSteer(steering=>new Promise(resolve=>{
      if(signal.aborted||!threadId||!turnId){resolve({status:"not-ready"});return;}
      const id=nextSteerId++;
      const timer=setTimeout(()=>{steerRequests.delete(id);resolve({status:"failed",error:"Codex steering response timed out"});},5_000);
      timer.unref?.();steerRequests.set(id,{resolve:result=>{
        if(result.status!=="accepted"){const index=steersSent.findIndex(steer=>steer.id===steering.clientMessageId&&steer.content===steering.content);if(index>=0)steersSent.splice(index,1);}
        resolve(result);
      },timer});
      if(steering.clientMessageId)steersSent.push({content:steering.content,id:steering.clientMessageId});
      send(id,"turn/steer",{threadId,expectedTurnId:turnId,clientUserMessageId:steering.clientMessageId,input:[{type:"text",text:steering.content,text_elements:[]}]});
    }));
  };
  const steerInternally=(content:string)=>{
    if(signal.aborted||!threadId||!turnId)return;
    const id=nextSteerId++;
    const timer=setTimeout(()=>{steerRequests.delete(id);},5_000);
    timer.unref?.();steerRequests.set(id,{resolve:()=>undefined,timer});
    send(id,"turn/steer",{threadId,expectedTurnId:turnId,input:[{type:"text",text:content,text_elements:[]}]});
  };
  const parallel=async(event:{id:string|number;params:Record<string,any>})=> {
    const p=event.params;
    if(p.namespace!==undefined && p.namespace!=="ading") {
      channel.write({id:event.id,error:{code:-32602,message:"Unsupported dynamic tool namespace"}});return;
    }
    const knowledgeOwner=!!threadId&&p.threadId===threadId ? (!turnId||p.turnId===turnId) : nativeChildren.has(p.threadId)&&typeof p.turnId==="string"&&nativeChildTurns.get(p.threadId)===p.turnId;
    if(isKnowledgeTool(p.tool) && knowledgeOwner) {
      let result:unknown,success=true;
      const childSignal=nativeChildControllers.get(p.threadId)?.signal;
      const requestSignal=childSignal ? AbortSignal.any([signal,childSignal]) : signal;
      try {result=await runKnowledgeTool(input,p.tool,p.arguments,requestSignal);}
      catch(cause){success=false;result={error:String(cause)};}
      if(!signal.aborted)channel.write({id:event.id,result:{success,contentItems:[{type:"inputText",text:JSON.stringify(result)}]}});
      return;
    }
    if(isComputerTool(p.tool) && p.threadId===threadId && (!turnId || p.turnId===turnId)) {
      const result=computerToolsEnabled(input)
        ? await runComputerTool(p.tool,p.arguments,signal)
        : {isError:true,content:[{type:"text" as const,text:localized("本轮是讨论、只沟通或只读核查，不能操作其他应用的界面；需要操作时请在执行轮次里进行。", "This turn is discussion, communication only or a read-only check, so other apps' interfaces can't be operated; do that in an execution turn when needed.")}]};
      if(!signal.aborted)channel.write({id:event.id,result:{success:!result.isError,contentItems:toCodexContent(result)}});
      return;
    }
    if(!input.onParallelWork || p.tool!==parallelTool.name || p.threadId!==threadId || (turnId&&p.turnId!==turnId)) {
      channel.write({id:event.id,error:{code:-32602,message:"Parallel work is unavailable or belongs to a different turn"}});return;
    }
    let result:unknown,success=true;
    try {result=await input.onParallelWork(p.arguments,signal);}
    catch(cause){success=false;result={error:String(cause)};}
    if(!signal.aborted)channel.write({id:event.id,result:{success,contentItems:[{type:"inputText",text:JSON.stringify(result)}]}});
  };
  const approve=async(event:{id:string|number;method:string;params:Record<string,any>})=>{
    const controller=new AbortController();pending.set(String(event.id),controller);
    const requestSignal=AbortSignal.any([signal,controller.signal]);
    approvalCount++;channel.waitingForApproval(true);
    try {
      const p=event.params;
      if (p.threadId!==threadId || (turnId && p.turnId && p.turnId!==turnId)) {
        channel.write({id:event.id,error:{code:-32602,message:"Approval belongs to a different turn"}});return;
      }
      const fileChange=event.method==="item/fileChange/requestApproval";
      const permissions=event.method==="item/permissions/requestApproval";
      const command=event.method==="item/commandExecution/requestApproval";
      if (!fileChange&&!permissions&&!command) {
        channel.write({id:event.id,error:{code:-32601,message:"Unsupported client request"}});return;
      }
      // Include the proposed diff, not just a root directory, when asking about file changes.
      const changes=fileChange ? items.get(p.itemId)?.changes : undefined;
      const allowed=unattended || (input.fullAccess && !!input.onPermission && (!fileChange || Array.isArray(changes)) && await input.onPermission({
        requestId:`codex:${threadId}:${event.id}`,toolName:permissions ? "RequestPermissions" : fileChange ? "Edit" : "Bash",
        input:permissions ? {permissions:p.permissions,cwd:p.cwd} : fileChange ? {changes,grantRoot:p.grantRoot} : {command:p.command,cwd:p.cwd,network:p.networkApprovalContext},
        reason:p.reason,blockedPath:fileChange ? p.grantRoot : undefined,workspacePath:input.workspacePath,signal:requestSignal
      }).catch(()=>false));
      if (requestSignal.aborted) return;
      channel.write({id:event.id,result:permissions ? {permissions:allowed ? p.permissions : {},scope:"turn"} : {decision:allowed ? "accept" : "decline"}});
    } finally {pending.delete(String(event.id));approvalCount--;channel.waitingForApproval(approvalCount>0);}
  };
  record(p("正在连接 Codex 审批通道", "Connecting to the Codex approval channel"));
  const run=await runner.run(agent.localUuid,{
    executablePath:agent.executablePath,args:["app-server","--stdio"],cwd:input.workspacePath,env,label:"Codex",signal:input.signal,timeoutMs:input.timeoutMs,hasPendingWork:input.hasPendingWork,
    // Protocol events are consumed in place; never retain reasoning, images or tool output.
    retainLine:()=>undefined,
    onStart:c=>{channel=c;send(1,"initialize",{clientInfo:clientInfo(),capabilities:{experimentalApi:true}});},
    onLine:line=>{
      let e:any;try{e=JSON.parse(line);}catch{return;}
      recordNativeChildren(e);
      if (e.id!==undefined && e.method) {void (e.method==="item/tool/call" ? parallel(e) : approve(e)).catch(cause=>{error=String(cause);channel.end();});return;}
      if(typeof e.id==="number"&&steerRequests.has(e.id)){
        const request=steerRequests.get(e.id)!;steerRequests.delete(e.id);clearTimeout(request.timer);
        if(e.error)request.resolve({status:"failed",error:e.error.message??"Codex could not steer the active turn"});
        else {turnId=e.result?.turnId??turnId;request.resolve({status:"accepted"});}
        return;
      }
      // Best effort: a build without this request still runs the turn, which memories.* already keep out of memory.
      if(e.id===5){if(e.error)void log("codex-memory-mode-failed",{threadId,error:String(e.error.message).slice(0,300)});return;}
      if (e.error && forkLockedThread(e)) return;
      if (e.error && e.id!==undefined) {error=e.error.message ?? p("Codex 审批通道请求失败", "Codex approval channel request failed");channel.end();return;}
      if(e.id===1){
        channel.write({method:"initialized",params:{}});
        if(modelSnapshot?.model || !input.onRuntimeConfig){if(modelSnapshot)record(p(`Codex 配置：${describeModel(modelSnapshot)}`, `Codex configuration: ${describeModel(modelSnapshot)}`));beginThread();}
        else send(2,"config/read",{cwd:input.workspacePath,includeLayers:false});
      }
      if(e.id===2){
        const resolved=e.result?.config ?? {};
        modelSnapshot={...codexRuntimeConfig(resolved),...modelSnapshot};
        input.onRuntimeConfig?.(modelSnapshot);
        record(p(`Codex 配置：${describeModel(modelSnapshot)||"使用默认配置"}`, `Codex configuration: ${describeModel(modelSnapshot)||"using the default configuration"}`));
        beginThread();
      }
      if(e.id===3){threadId=e.result?.thread?.id;
        // A session from before sharing stays eligible for Codex's background memory extraction unless told otherwise.
        if(input.isolateMemory&&input.threadId&&threadId)send(5,"thread/memoryMode/set",{threadId,mode:"disabled"});
        if(forkedFrom&&threadId)void log("codex-thread-fork-ready",{from:forkedFrom,threadId});if(!threadId){error=p("Codex 未返回会话 ID", "Codex didn't return a session ID");channel.end();return;}record(p("已连接到 Codex", "Connected to Codex"));send(4,"turn/start",{threadId,cwd:input.workspacePath,approvalPolicy:unattended?"never":"on-request",approvalsReviewer:"user",input:[{type:"text",text:input.split?.dialogue || input.prompt,text_elements:[]}]});}
      // Native child threads share this stream. Filter ownership before updating
      // the active turn, or a child's turn/started prevents the parent from ending.
      if(e.params?.threadId && threadId && e.params.threadId!==threadId)return;
      if(e.id===4){turnId=e.result?.turn?.id;exposeSteering();}
      if(e.method==="turn/started"){turnId=e.params?.turn?.id;exposeSteering();}
      if(e.params?.turnId && turnId && e.params.turnId!==turnId)return;
      if(e.method==="serverRequest/resolved")pending.get(String(e.params?.requestId))?.abort();
      if(e.method==="item/started" || e.method==="item/completed"){
        const item=e.params?.item;if(!item)return;
        // Only visible messages and tool metadata; never inspect reasoning content.
        if(item.type==="reasoning")return;
        receiveUserItem(item);
        if(item.type==="agentMessage" && e.method==="item/started" && steersEchoed.length)messageSteers.set(item.id,[...steersEchoed]);
        if(item.type==="agentMessage" && e.method==="item/completed"){
          receiveMessage(item);
        } else if(item.type!=="agentMessage"&&item.type!=="userMessage"){
          if(e.method==="item/started"){
            metrics.iterations++;
            const loopNotice=loopGuard.observe(item.type,item);
            if(loopNotice){record(p("检测到重复工具循环，已在当前会话内调整方向", "Detected a repeated tool loop; adjusted direction within the current session"));steerInternally(loopNotice);}
            if(["commandExecution","fileChange","mcpToolCall","imageGeneration"].includes(item.type))metrics.sideEffects=true;
            if(item.type==="fileChange")items.set(item.id,{changes:item.changes});
            record(item.type==="commandExecution" ? p(`正在执行命令：${String(item.command).slice(0,160)}`, `Running command: ${String(item.command).slice(0,160)}`) : item.type==="fileChange" ? p("正在修改文件", "Modifying files") : p(`正在调用工具：${item.type}`, `Calling tool: ${item.type}`));
          } else items.delete(item.id);
          input.onAudit?.({id:item.id,kind:item.type,phase:e.method,failed:item.type==="error"||item.status==="failed"||item.status==="declined"});
        }
      }
      if(e.method==="error")error=e.params?.error?.message ?? p("Codex 连接失败", "Codex connection failed");
      if(e.method==="rawResponse/completed")recordTokenUsage(metrics,e.params?.usage);
      if(e.method==="thread/tokenUsage/updated")setTokenUsage(metrics,e.params?.tokenUsage?.total);
      if(e.method==="turn/completed"){
        if(turnId&&e.params?.turn?.id&&e.params.turn.id!==turnId)return;
        // The snapshot replays earlier items out of stream order, so it never confirms a steer.
        for(const item of e.params?.turn?.items ?? [])receiveMessage(item,false);
        completed=e.params?.turn?.status==="completed";
        if(completed && input.hasPendingWork?.()){completed=false;error=p("父会话提前结束，仍有并行工作未交付；已有文件保留，请核对后继续未完成项", "The parent session ended early with parallel work still undelivered; existing files are kept. Check them, then continue the unfinished items");}
        if(completed)error="";
        else error=e.params?.turn?.error?.message ?? (error || p("Codex 本轮未完成", "Codex didn't finish this turn"));
        scope.abort();channel.end();
      }
    }
  });
  unregisterSteer?.();
  for(const request of steerRequests.values()){clearTimeout(request.timer);request.resolve({status:"failed",error:"Codex turn ended before steering completed"});}
  steerRequests.clear();
  scope.abort();
  // Some protocol versions deliver messages only in the completed turn snapshot.
  message ||= legacyMessage;
  if(input.signal?.aborted || run.cancelled)return {ok:false,threadId,error:p("任务已停止", "The task was stopped"),cancelled:true,steps,metrics,partialMessage:message||undefined};
  if(completed&&message&&threadId)return {ok:true,threadId,message,steps,metrics,...(steersSeen.size ? {steersSeen:[...steersSeen]} : {})};
  return {ok:false,threadId,error:p(`Codex 回复失败：${error||run.failure||"返回的数据不完整"}`, `Codex reply failed: ${error||run.failure||"the returned data is incomplete"}`),cancelled:false,steps,metrics,partialMessage:message||undefined};
}
