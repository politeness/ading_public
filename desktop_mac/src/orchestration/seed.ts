import type { Store } from "../store/store";
import { p } from "../prompt-language";

/**
 * Task sheet (seed).
 *
 * The problem it solves: I can figure out who should do what, where the boundaries are, and what counts as done,
 * but there's no channel to hand that arrangement to agents — every time someone has to open the app and retype what I said.
 * The task sheet is that channel: write the arrangement into a JSON file in the repo, and on startup the app reads it,
 * creates workspaces, configures personas and roles, opens conversations, and sends the first message.
 *
 * The first message is sent **as the person**, so it triggers the orchestrator normally —
 * agents get to work without anyone typing again.
 *
 * Three hard constraints:
 *   1. Idempotent. Running the same task sheet ten times creates things only once, deduplicated by Task.seedKey, not by name.
 *   2. Never override people. Existing workspaces and conversations already changed by people are left untouched.
 *   3. Failure doesn't block startup. A malformed task sheet at worst doesn't take effect; it must not stop the app from starting.
 */

export interface SeedAgent {
  kind: AgentKind;
  displayName?: string;
  persona?: string;
}

export interface SeedConversation {
  /** Stable identifier; renaming doesn't affect deduplication */
  key: string;
  /** Points to workspaces[].key; empty falls into "quick" */
  workspace?: string;
  name: string;
  charter?: Charter;
  members: Array<{ kind: AgentKind; role?: MemberRole }>;
  /** Opening message. Sending it triggers the @-mentioned agents */
  opening?: string;
}

export interface SeedDoc {
  version: number;
  workspaces?: Array<{ key: string; name: string; path: string }>;
  agents?: SeedAgent[];
  conversations?: SeedConversation[];
}

export interface SeedResult {
  workspaces: string[];
  agents: string[];
  conversations: string[];
  /** Newly created conversations with an opening message. The caller uses them to trigger agents to speak */
  startedConversationIds: string[];
  skipped: string[];
  problems: string[];
}

/** Agents discovered locally: kind -> userId. Vendors not installed won't appear here */
export type AgentsByKind = Map<AgentKind, string>;

export function isSeedDoc(value: unknown): value is SeedDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SeedDoc).version === "number"
  );
}

export async function applySeed(
  store: Store,
  agents: AgentsByKind,
  doc: SeedDoc
): Promise<SeedResult> {
  const result: SeedResult = {
    workspaces: [],
    agents: [],
    conversations: [],
    startedConversationIds: [],
    skipped: [],
    problems: []
  };
  if (doc.version !== 1) {
    result.problems.push(p(`不认识的任务单版本：${doc.version}`, `Unrecognized task sheet version: ${doc.version}`));
    return result;
  }

  // ---- Workspaces: deduplicate by directory, reuse existing ones, never create duplicates ----
  const existingWorkspaces = await store.listWorkspaces();
  const byKey = new Map<string, string>();
  for (const entry of doc.workspaces ?? []) {
    const already = existingWorkspaces.find(
      (workspace) => workspace.kind === "folder" && workspace.path === entry.path
    );
    if (already) {
      byKey.set(entry.key, already.workspaceId);
      result.skipped.push(p(`工作区「${entry.name}」已存在`, `Workspace "${entry.name}" already exists`));
      continue;
    }
    try {
      const created = await store.createWorkspace({
        name: entry.name,
        path: entry.path
      });
      byKey.set(entry.key, created.workspaceId);
      result.workspaces.push(entry.name);
    } catch (error) {
      result.problems.push(p(`建工作区「${entry.name}」失败：${describe(error)}`, `Creating workspace "${entry.name}" failed: ${describe(error)}`));
    }
  }

  // ---- Personas: only change fields the task sheet specifies ----
  for (const entry of doc.agents ?? []) {
    const userId = agents.get(entry.kind);
    if (!userId) {
      result.skipped.push(p(`本机没有 ${entry.kind}，跳过`, `${entry.kind} isn't on this computer; skipped`));
      continue;
    }
    const patch: Partial<
      Pick<UserRef, "displayName" | "persona" | "enabled">
    > = {};
    if (entry.displayName) patch.displayName = entry.displayName;
    if (entry.persona) patch.persona = entry.persona;
    // The task sheet names it for use, so that's an explicit "add as contact" decision —
    // otherwise conversations created by the task sheet on a fresh machine would have members missing from contacts
    patch.enabled = true;
    try {
      const updated = await store.updateAgent(userId, patch);
      result.agents.push(updated.displayName);
    } catch (error) {
      result.problems.push(p(`设置 ${entry.kind} 失败：${describe(error)}`, `Setting up ${entry.kind} failed: ${describe(error)}`));
    }
  }

  // ---- Conversations ----
  const me = await store.currentUser();
  const existingConversations = await store.listConversations();
  for (const entry of doc.conversations ?? []) {
    if (existingConversations.some((conversation) => conversation.seedKey === entry.key)) {
      result.skipped.push(p(`会话「${entry.name}」已经建过`, `Session "${entry.name}" was already created`));
      continue;
    }

    const memberIds: string[] = [];
    const roles: Array<{ userId: string; role: MemberRole }> = [];
    const missing: AgentKind[] = [];
    for (const member of entry.members) {
      const userId = agents.get(member.kind);
      if (!userId) {
        missing.push(member.kind);
        continue;
      }
      memberIds.push(userId);
      // Those named only in tasks and not configured in the agents section are also added as contacts
      await store.updateAgent(userId, { enabled: true }).catch(() => undefined);
      if (member.role) roles.push({ userId, role: member.role });
    }
    if (!memberIds.length) {
      result.problems.push(
        p(`会话「${entry.name}」跳过：需要的 Agent 一个都没装（${missing.join("、")}）`, `Session "${entry.name}" skipped: none of the required Agents are installed (${missing.join(", ")})`)
      );
      continue;
    }
    if (missing.length) {
      result.skipped.push(
        p(`会话「${entry.name}」少了 ${missing.join("、")}，用装了的那几个先开`, `Session "${entry.name}" is missing ${missing.join(", ")}; starting with the ones that are installed`)
      );
    }

    try {
      const conversation = await store.createConversation({
        name: entry.name,
        memberIds,
        workspaceId: entry.workspace ? byKey.get(entry.workspace) : undefined,
        charter: entry.charter,
        seedKey: entry.key
      });
      // Roles must be set after creation — createConversation only knows members, not roles
      for (const { userId, role } of roles) {
        await store.setMemberRole(conversation.conversationId, userId, role).catch(() => undefined);
      }
      // The opening message is sent as the person, so the orchestrator treats it as "the boss spoke" and triggers agents
      if (entry.opening?.trim()) {
        await store.appendMessage({
          conversationId: conversation.conversationId,
          clientMessageId: `seed-${entry.key}`,
          senderId: me.userId,
          content: entry.opening.trim(),
          mentions: memberIds
        });
        result.startedConversationIds.push(conversation.conversationId);
      }
      result.conversations.push(entry.name);
    } catch (error) {
      result.problems.push(p(`建会话「${entry.name}」失败：${describe(error)}`, `Creating session "${entry.name}" failed: ${describe(error)}`));
    }
  }

  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
