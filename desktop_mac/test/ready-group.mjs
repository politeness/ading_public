// Focused execution/recovery tests begin after the shared planning phase.
// Fresh-group planning itself is exercised by brainstorm.test.mjs.
export async function readyGroup(store, input) {
  const conversation = await store.createConversation(input);
  if(conversation.type!=="GROUP")return conversation;
  return store.updateConversation(conversation.conversationId, {brainstorm: {
    phase:'ready', revision:1, round:1, probes:0, attempts:0, inputSeq:0,
    leaderId:conversation.members.find(member=>member.role==='LEADER').userId,
    participants:[], responses:{}, turnDurationsMs:{}, evidenceReady:true
  }});
}
