import { p } from "../prompt-language";
/** Optional UI metadata: never required for accepting the actual reply. */
/**
 * Task naming.
 *
 * Previously the prompt asked the Agent to output <task-title>name</task-title> on its own line at the start of a normal reply,
 * and ADing stripped it before display. The problem is vendors' own apps don't know this convention and show that line to the user verbatim.
 * Now it's asked separately: through each vendor's "one-shot, no tools, session not persisted" channel, staying out of the user's conversation record.
 */
export function conversationNamingAsk(message: string): string {
  return p(`根据下面这条消息的语义，拟一个简短、具体的会话名称（建议 4–18 字），概括要做的事。不要截取开头，不要使用"新任务"。只输出名称本身，不要输出任何其他内容。\n\n消息：${message}`,
    `Based on the meaning of the message below, come up with a short, specific task name (about 2–8 words) that summarizes what's to be done. Don't just cut off the beginning and don't use "New task". Output only the name itself, nothing else.\n\nMessage: ${message}`);
}

/**
 * The line returned by the naming call. The model occasionally adds quotes or punctuation; clean them before use.
 *
 * Placeholder names must be rejected: storing "新任务" (New task) as the name would also turn off autoTitle,
 * and the conversation would be called "新任务" forever and never be renamed again.
 */
export function cleanConversationName(text: string): string | undefined {
  const line = text.trim().split("\n").map(part => part.trim()).filter(Boolean)[0] ?? "";
  const name = line.replace(/^[「"'`\[【]+/, "").replace(/[」"'`\]】。.]+$/, "").trim();
  if (!name || name.length > 40) return undefined;
  return !isPlaceholderTitle(name) ? name : undefined;
}

/** A tag on its own line. One embedded in a sentence (e.g. an Agent explaining the tag) doesn't count and is kept as-is. */
const TITLE_LINE = /^[ \t]*<task-title>\s*([^<>\r\n]{0,80}?)\s*<\/task-title>[ \t]*(?:\r?\n|$)/gim;

/**
 * Extracts the title and removes the tag line from visible content. The tag line isn't necessarily at the start: Agents sometimes write it mid-text,
 * and recognizing only the start would leave the title never settled, asking for it every turn and showing the tag to the user.
 */
export function parseConversationTitle(raw: string): { visible: string; title?: string } {
  const titles = [...raw.matchAll(TITLE_LINE)].map((match) => match[1].trim());
  if (titles.length === 0) return { visible: raw };
  const visible = raw.replace(TITLE_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
  // A metadata-only response is not a completed conversational turn.
  if (!visible) return { visible: raw };
  const title = titles.find((candidate) => candidate && !isPlaceholderTitle(candidate));
  return title ? { visible, title } : { visible };
}

/** Placeholder names not yet titled; "新任务" / New task from before the rename to "会话" (conversation) are also recognized */
function isPlaceholderTitle(name: string): boolean {
  return ["新会话", "新任务"].includes(name) || ["new conversation", "new task"].includes(name.toLowerCase());
}
