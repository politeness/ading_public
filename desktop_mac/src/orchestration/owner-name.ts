/**
 * When Agents address the task initiator they use that person's name (nickname), not "主人" (owner).
 *
 * Prompts are scattered across scheduling, assignment, plan discussion, permission review, and more; editing sentence by sentence is easy to miss,
 * and can't cover sentences written in the future, so replace uniformly at the exit where prompts are sent to Agents.
 */
export function addressOwner(text: string, ownerName: string | undefined): string {
  const name = ownerName?.trim();
  // English prompts say "the task owner"; replace it with the nickname as well when there is one
  return text.replace(/主人/g, name || "会话发起人").replace(/\b[Tt]he task owner\b/g, (phrase) => name || phrase);
}
