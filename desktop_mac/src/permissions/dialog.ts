import { BrowserWindow } from "electron";
import { tm } from "../i18n";
import { showPermissionWindow } from "./window";
import { PermissionGrants } from "./grants";
import type { ToolPermissionRequest } from "../agents/types";

/** Approval windows are queued so concurrent agents cannot hide each other's approval. */
export class PermissionDialogs {
  constructor(private grants = new PermissionGrants()) {}
  clearConversation(conversationId: string): Promise<void> { return this.grants.clearConversation(conversationId); }
  private queue: Promise<unknown> = Promise.resolve();
  request(conversation: Conversation, agent: UserRef, request: ToolPermissionRequest): Promise<boolean> {
    const show = async (): Promise<boolean> => {
      if (request.signal.aborted) return false;
      const revision = this.grants.revision(conversation.conversationId);
      const key = this.grants.key(conversation,agent,request);
      if (await this.grants.has(conversation.conversationId,key)) return !request.signal.aborted && revision === this.grants.revision(conversation.conversationId);
      if (request.signal.aborted) return false;
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      if (!parent) return false;
      const serialized = JSON.stringify(request.input, null, 2);
      // Never approve a truncated operation whose true scope cannot be reviewed.
      if (serialized.length > 16_000) return false;
      const response = await showPermissionWindow(parent, {
        title:tm("main.permission.title"),
        message:tm("main.permission.message",{agent:agent.displayName,tool:request.toolName}),
        detail:`${tm("main.permission.conversation",{name:String(conversation.name)})}\n${request.reason ? `${tm("main.permission.reason",{reason:request.reason})}\n` : ""}${request.blockedPath ? `${tm("main.permission.path",{path:request.blockedPath})}\n` : ""}${tm("main.permission.params")}\n${serialized}`,
        footer:tm("main.permission.footer"),
        buttons:[tm("main.permission.deny"), tm("main.permission.allowOnce"), tm("main.permission.allowAlways")],signal:request.signal
      });
      if (request.signal.aborted || revision !== this.grants.revision(conversation.conversationId)) return false;
      if (response === 2) await this.grants.grant(conversation.conversationId,key,revision);
      return !request.signal.aborted && revision === this.grants.revision(conversation.conversationId) && (response === 1 || response === 2);
    };
    const result = this.queue.then(show, show);
    this.queue = result.catch(() => false);
    return result;
  }
}
