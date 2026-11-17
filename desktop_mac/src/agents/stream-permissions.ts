import { randomUUID } from "node:crypto";
import type { ProcessChannel } from "./process-runner";
import type { TurnInput } from "./types";
import { p } from "../prompt-language";
import {knowledgeMutation} from "../knowledge/tools";

export interface StreamPermissionOptions {
  initialize?: Record<string, unknown>;
  readableTools?: readonly string[];
}

/** Bidirectional control protocol for Claude / Qoder. An approval applies only to the original call; vendor permission config is not written. */
export class StreamPermissions {
  private channel?: ProcessChannel;
  private readonly initId = randomUUID();
  private readonly requests = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private initTimer?: NodeJS.Timeout;
  private closed = false;
  private initialized = false;
  // A turn is in flight until its result arrives. Messages delivered mid-turn are
  // folded into that turn by the CLI and never produce a result of their own, so
  // counting every send as its own expected result leaves stdin open forever.
  private awaitingResults=0;
  private readonly deniedCalls = new Set<string>();
  // The CLI echoes a mid-turn message as a top-level user event when it folds it
  // into the model input (Claude Code only with --replay-user-messages). One that
  // arrives after the final answer is not folded: the CLI queues it and runs a
  // follow-up turn of its own right after this turn's result, even with stdin
  // already closed, and exits only once that turn has a result too.
  private readonly steersSent:{content:string;id:string}[]=[];
  private readonly steersEchoed:string[]=[];
  // Steers still unanswered when a result arrived, so the CLI's own follow-up turn
  // is the one that handles them; that turn's successful result confirms them.
  private readonly steersQueued:string[]=[];
  private repliedSinceResult=false;
  /** Steers the model answered: echoed into the turn and followed by more model
   * output, or queued past a result and answered by the CLI's follow-up turn. */
  readonly steersSeen:string[]=[];
  error?: string;
  denied = false;
  constructor(private input: TurnInput, private fail: () => void, private options: StreamPermissionOptions = {}) {}

  start(channel: ProcessChannel): void {
    this.channel = channel;
    channel.write({type:"control_request",request_id:this.initId,request:{subtype:"initialize",hooks:{},...this.options.initialize}});
    this.initTimer = setTimeout(() => {
      this.error = p("权限控制通道初始化超时，本轮未执行", "Permission control channel initialization timed out; this turn didn't run");
      this.fail();
    }, 30_000);
  }

  line(event: any): void {
    if (this.closed) return;
    // Explicit vendor deny rules may take effect before the host callback; such a denial must not be counted as a result either.
    if (Array.isArray(event.permission_denials) && event.permission_denials.length) this.denied = true;
    if (event.type === "user" && !event.parent_tool_use_id) {
      const content = event.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : "";
      const index = this.steersSent.findIndex(steer => steer.content === text);
      if (index >= 0) this.steersEchoed.push(this.steersSent.splice(index, 1)[0].id);
    } else if (event.type === "assistant" && !event.parent_tool_use_id) {
      this.repliedSinceResult = true;
      this.steersSeen.push(...this.steersEchoed.splice(0));
    }
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block.type !== "tool_result" || !block.is_error) continue;
      const text = typeof block.content === "string" ? block.content.slice(0, 2000) :
        Array.isArray(block.content) ? block.content.filter((b: any) => b.type === "text").map((b: any) => String(b.text).slice(0, 2000)).join("\n") : "";
      if (/permission.{0,120}(denied|not allowed)|not.{0,30}allowed.{0,30}(permission|mode)|权限.{0,20}(拒绝|不足)/is.test(text)) this.denied = true;
    }
    if (event.type === "control_response" && event.response?.request_id === this.initId) {
      if (this.initialized) return;
      this.initialized = true;
      clearTimeout(this.initTimer);
      if (event.response.subtype !== "success") {
        this.error = p("当前 CLI 不支持权限审批通道，本轮未执行", "The current CLI doesn't support the permission approval channel; this turn didn't run");
        this.channel?.end();
        return;
      }
      const effort = event.response.response?.effort_status;
      if (effort?.applied === false) {
        this.error = p("厂商未应用请求的推理强度", "The provider did not apply the requested reasoning effort");
        this.channel?.end();
        return;
      }
      if(!this.sendUser(this.input.prompt)){
        this.error = p("当前 CLI 已结束，未能发送任务内容", "The current CLI has already exited; the task content couldn't be sent");
        this.fail();
      }
    } else if (event.type === "control_cancel_request") {
      this.requests.get(event.request_id)?.abort();
    } else if (event.type === "control_request" && typeof event.request_id === "string") {
      if (this.seen.has(event.request_id)) return;
      this.seen.add(event.request_id);
      void this.answer(event);
    } else if (event.type === "result" && !event.parent_tool_use_id) {
      const replied = this.repliedSinceResult || (typeof event.result === "string" && !!event.result.trim());
      if (!event.is_error && replied) this.steersSeen.push(...this.steersQueued.splice(0));
      this.steersQueued.push(...this.steersEchoed.splice(0), ...this.steersSent.splice(0).map(steer => steer.id));
      this.repliedSinceResult = false;
      // stdin still closes on the first result: the CLI drains queued steers on its
      // own, and an open stdin would hang if it chose not to run another turn.
      if(this.awaitingResults>0)this.awaitingResults--;
      if(this.awaitingResults===0)this.channel?.end();
    }
  }

  private sendUser(content:string,_clientMessageId?:string):boolean{
    if(!this.channel)return false;
    const accepted=this.channel.write({type:"user",message:{role:"user",content},parent_tool_use_id:null});
    // Only an idle send starts a new turn; a steer into a running one does not.
    if(accepted&&this.awaitingResults===0)this.awaitingResults=1;
    return accepted;
  }

  /** Streaming input keeps one Claude/Qoder process alive and queues the update in that session. */
  steer(content:string,clientMessageId?:string):boolean{
    if(this.closed||!this.initialized||!this.channel)return false;
    const accepted=this.sendUser(content,clientMessageId);
    if(accepted&&clientMessageId)this.steersSent.push({content,id:clientMessageId});
    return accepted;
  }

  private async answer(event: any): Promise<void> {
    const req = event.request;
    const id = event.request_id;
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.input.signal?.addEventListener("abort", abort, {once:true});
    if (this.input.signal?.aborted) controller.abort();
    this.requests.set(id, controller);
    this.channel?.waitingForApproval(true);
    const timer = setTimeout(abort, 5 * 60_000);
    const callKey = JSON.stringify([req?.tool_name, req?.input]);
    let allowed = false;
    try {
      const readable = (this.options.readableTools ?? ["Read", "Glob", "Grep"]).includes(req?.tool_name);
      const knowledge=!!this.input.onKnowledgeTool && ["mcp__ading__ading_skill","mcp__ading__ading_memory"].includes(req?.tool_name);
      // The shared MCP handler performs the one app-level permission request for
      // mutations; the provider gate only admits this same scoped tool channel.
      if(knowledge && req?.subtype==="can_use_tool" && req.input && typeof req.input==="object" && !Array.isArray(req.input) && !controller.signal.aborted && !this.deniedCalls.has(callKey)) {
        allowed=!knowledgeMutation(req.input) || (!!this.input.fullAccess && !this.input.discussionOnly && !this.input.communicationOnly);
      } else
      if (!this.deniedCalls.has(callKey) && !controller.signal.aborted && req?.subtype === "can_use_tool" &&
          typeof req.tool_name === "string" && req.input && typeof req.input === "object" && !Array.isArray(req.input) &&
          !this.input.discussionOnly && (this.input.fullAccess || readable)) {
        allowed = this.input.fullAccess&&this.input.permissionMode==="unattended" ? true : await Promise.race([
          this.input.onPermission?.({requestId:id,toolName:req.tool_name,input:req.input,workspacePath:this.input.workspacePath,blockedPath:typeof req.blocked_path === "string" ? req.blocked_path : undefined,signal:controller.signal}) ?? Promise.resolve(false),
          new Promise<false>(resolve => controller.signal.addEventListener("abort", () => resolve(false), {once:true}))
        ]);
      }
    } catch { allowed = false; }
    finally {
      clearTimeout(timer);
      this.input.signal?.removeEventListener("abort", abort);
      this.requests.delete(id);
      this.channel?.waitingForApproval(this.requests.size > 0);
    }
    if (this.closed || this.input.signal?.aborted) return;
    allowed = allowed && !controller.signal.aborted;
    if (!allowed) { this.denied = true; this.deniedCalls.add(callKey); }
    this.input.onAudit?.({id,kind:req?.tool_name ?? "unknown",phase:allowed ? "permission-allowed" : "permission-denied",failed:!allowed});
    this.channel?.write({type:"control_response",response:{subtype:"success",request_id:id,response:allowed
      ? {behavior:"allow",updatedInput:req.input,toolUseID:req.tool_use_id}
      : {behavior:"deny",message:p("本次操作未获授权或审批已取消。请报告受阻，不要绕过或重复申请同一操作。", "This operation wasn't authorized or the approval was cancelled. Report that you're blocked; don't bypass it or request the same operation again."),toolUseID:req?.tool_use_id}}});
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.initTimer);
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
  }
}
