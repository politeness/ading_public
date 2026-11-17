/** One @ in the input box: the displayed text and the member it points to. userId is the identity; the text is only used to locate it in the body. */
export interface MentionOption {
  label: string;
  userId: string;
}

/** Placeholder userId for "@all people" in the input box; on send it expands to every human in the conversation except yourself. Neither the backend nor the scheduler knows about it */
export const ALL_PEOPLE_MENTION = "__all_people__";
/** Recognize both the Chinese and English forms: a message stays in the language it was sent in, and the reader may use the other one */
export const ALL_PEOPLE_LABELS = ["所有真人", "all people"];

const MENTION_END = /[\s,，。!！?？:：]/;

/**
 * Resolve the @s in the body to userIds. Each @ maps to exactly one member: take the longest matching name,
 * so when both "Qoder" and "Qoder CN" exist, @Qoder CN does not also count as @Qoder.
 */
export function resolveMentions(content: string, options: MentionOption[]): string[] {
  const longestFirst = [...options].sort((a, b) => b.label.length - a.label.length);
  const found = new Set<string>();
  let at = content.indexOf("@");
  while (at >= 0) {
    let next = at + 1;
    const match = longestFirst.find(({ label }) => {
      if (!content.startsWith(label, at + 1)) return false;
      const after = content[at + 1 + label.length];
      return after === undefined || MENTION_END.test(after);
    });
    if (match) {
      found.add(match.userId);
      next = at + 1 + match.label.length;
    }
    at = content.indexOf("@", next);
  }
  return [...found];
}

/** Mark the @s in the body. userId isn't in the body, so we can only search by name; old messages whose member was renamed are left as-is if not found. */
export function highlightMentions(root: HTMLElement, mentions: Array<{ label: string; mine: boolean }>): void {
  if (!mentions.length) return;
  const byLabel = new Map(mentions.map(item => [item.label, item.mine]));
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // An @ for members with the same name carries "(computer name) #index"; include it in the highlight
  const pattern = new RegExp(`@(${labels.join("|")})(?: \\([^)\\n]*\\)(?: #\\d+)?)?(?=$|${MENTION_END.source})`, "g");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) if (!(walker.currentNode.parentElement?.closest("code, pre, a, .message-math"))) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    const parts: Array<string | HTMLElement> = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      const span = document.createElement("span");
      span.className = byLabel.get(match[1]) ? "mention mention-me" : "mention";
      span.textContent = match[0];
      parts.push(span);
      last = match.index + match[0].length;
    }
    if (!parts.length) continue;
    if (last < text.length) parts.push(text.slice(last));
    node.replaceWith(...parts);
  }
}
