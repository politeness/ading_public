const { contextBridge } = require('electron');
const me = { userId: 'test-me', displayName: '测试用户', isAgent: false };
const contacts = [
  { userId: 'test-c', displayName: '小c', isAgent: true, kind: 'codex', enabled: true },
  { userId: 'test-q', displayName: '小q', isAgent: true, kind: 'qoder', enabled: true },
  { userId: 'test-qcn', displayName: '小q-cn', isAgent: true, kind: 'qoder-cn', enabled: true }
];
const workspaces = [{ workspaceId: 'test-inbox', name: '无工作区', kind: 'inbox' }];
let updateInstalls = 0;
let trackReadReceipts = false;

const base = { creator: me.userId, owner: me.userId, workspaceId: 'test-inbox', lastSeq: 1, status: 'ACTIVE', createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };
const members = [{ userId: me.userId, role: 'ENGINEER', lastReadSeq: 0 }, { userId: 'test-c', role: 'LEADER', lastReadSeq: 0 }, { userId: 'test-q', role: 'ENGINEER', lastReadSeq: 0 }];
const conversations = [
  { ...base, conversationId: 'test-group', name: '产品设计讨论', type: 'GROUP', members: members.map(m=>({...m})), paused: false },
  { ...base, conversationId: 'test-paused', name: '待继续的设计', type: 'GROUP', members: members.map(m=>({...m})), paused: true, updatedAt: '2026-09-05T01:00:00Z' },
  { ...base, conversationId: 'test-direct', name: '单聊', type: 'DIRECT', members: members.slice(0, 2), paused: false },
  // A second direct chat with the same contact, created later than the one above: with no focus chosen yet, it should land on this one
  { ...base, conversationId: 'test-solo-conversation', name: '第二条单聊', type: 'DIRECT', members: members.slice(0, 2), paused: false, createdAt: '2026-09-05T00:20:00Z', updatedAt: '2026-09-05T00:30:00Z' }
];
const listPageRequests = [];
if (process.argv.includes('--ading-test-infinite-lists')) {
 for(let i=0;i<225;i++) {
  contacts.push({userId:`paged-contact-${i}`,displayName:`Paged ${String(i).padStart(3,'0')}`,isAgent:false,friend:true});
  conversations.push({...base,conversationId:`paged-conversation-${i}`,name:`Paged ${i}`,type:'DIRECT',members:members.slice(0,2),updatedAt:`2026-09-03T00:00:00Z`});
 }
}
if (process.argv.includes('--ading-test-empty')) conversations.splice(0);
// No Agent added yet: the entry for starting a conversation should be disabled
if (process.argv.includes('--ading-test-no-agents')) { contacts.splice(0); conversations.splice(0); }
const catalog = contacts.map((a, i) => ({ kind: a.kind, displayName: a.displayName, installed: true, added: true, readiness: i ? 'service_error' : 'ready', status: i ? 'error' : 'ready', version: 'test' }));
const recovery={action:'login',label:'同步账号',statusText:'模型未同步',message:'请登录与原应用相同的账号，阿钉会自动重新检测所选模型。'};
if(process.argv.includes('--ading-test-mentions')){
 contacts.push({userId:'test-friend-a',displayName:'Alice',isAgent:false,friend:true},{userId:'test-friend-b',displayName:'Bob',isAgent:false,friend:true});
 conversations.push({...base,conversationId:'test-people',name:'和朋友的群',type:'GROUP',lastSeq:60,members:[{userId:me.userId,role:'ENGINEER',lastReadSeq:0,firstUnreadMentionSeq:3},{userId:'test-c',role:'LEADER',lastReadSeq:0},{userId:'test-friend-a',role:'ENGINEER',lastReadSeq:0},{userId:'test-friend-b',role:'ENGINEER',lastReadSeq:0}],paused:false,updatedAt:'2026-09-04T00:00:00Z'});
}
if(process.argv.includes('--ading-test-shared-members')) {
 conversations.push({...base,conversationId:'test-readonly-people',name:'只读真人会话',owner:'test-shared-a',type:'DIRECT',members:[{userId:'test-shared-a',role:'ENGINEER',lastReadSeq:0}],paused:false});
 contacts[0].owner=me.userId;
 conversations.push({...base,conversationId:'test-owner-view',name:'共享查看',owner:'test-shared-a',type:'DIRECT',members:[{userId:'test-shared-a',role:'ENGINEER',lastReadSeq:0},{userId:'test-c',role:'ENGINEER',lastReadSeq:0}],paused:false});
 contacts.push({userId:'test-shared-owner',displayName:'Owner',isAgent:false,friend:true},{userId:'test-shared-a',displayName:'Alice',isAgent:false,friend:true},{userId:'test-shared-b',displayName:'Bob',isAgent:false,friend:true},
  {userId:'test-shared-qwen',displayName:'Shared Qwen',isAgent:true,kind:'qwen-code',enabled:true,owner:'test-shared-owner',sharedWith:[me.userId,'test-shared-a'],remote:{computerId:'remote-owner',computerName:'Owner Mac',online:true,readiness:'ready'}});
 conversations.push({...base,conversationId:'test-shared-group',name:'共享 Agent 群',type:'GROUP',members:[me.userId,'test-shared-a','test-shared-b'].map(userId=>({userId,role:'ENGINEER',lastReadSeq:0})),paused:false});
}
if(process.argv.includes('--ading-test-many-contacts')){for(let i=0;i<100;i++)contacts.push({userId:`test-many-${i}`,displayName:`批量 Agent ${String(i).padStart(3,'0')}`,isAgent:true,kind:'codex',enabled:true});contacts.push({userId:'test-blocked-friend',displayName:'未授权好友',isAgent:false,friend:true});}
if(process.argv.includes('--ading-test-share-hints')){
 const people=[['test-hint-alice','Alice'],['test-hint-bob','Bob'],['test-hint-carol','Carol'],['test-hint-dan','Dan'],['test-hint-oscar','Oscar']];
 for(const [userId,displayName] of people)contacts.push({userId,displayName,isAgent:false,friend:true});
 contacts.push({userId:'test-hint-own',displayName:'小a',isAgent:true,kind:'codex',enabled:true,owner:me.userId,sharedWith:[]},
  {userId:'test-hint-oscar-agent',displayName:'小o',isAgent:true,kind:'codex',enabled:true,owner:'test-hint-oscar',sharedWith:[me.userId]},
  {userId:'test-hint-unknown-owner',displayName:'小u',isAgent:true,kind:'codex',enabled:true,owner:'test-hint-gone',sharedWith:[me.userId]},
  {userId:'test-hint-ok',displayName:'小绝',isAgent:true,kind:'codex',enabled:true,owner:me.userId,sharedWith:['test-hint-alice','test-hint-bob','test-hint-carol','test-hint-dan']});
 const group=(conversationId,type,ids)=>conversations.push({...base,conversationId,name:conversationId,type,members:[me.userId,...ids].map(userId=>({userId,role:'ENGINEER',lastReadSeq:0})),paused:false});
 group('test-hint-direct','DIRECT',['test-hint-alice']);
 group('test-hint-pair','GROUP',['test-hint-alice','test-hint-bob']);
 group('test-hint-crowd','GROUP',['test-hint-alice','test-hint-bob','test-hint-carol','test-hint-dan']);
 group('test-hint-agent-group','GROUP',['test-hint-own']);
}
if(process.argv.includes('--ading-test-recovery'))Object.assign(catalog[1],{label:'Qoder',readiness:'error',recovery});
if(process.argv.includes('--ading-test-copilot-access'))catalog.push({kind:'copilot',label:'GitHub Copilot',installed:true,added:false,readiness:'unauthorized',detail:'Authentication required'});
// CLI not installed: Qoder CN desktop App present, CLI absent; after install this one must be auto-detected
const installResolutions=new Map();let verifyResolution;
if(process.argv.includes('--ading-test-install-progress'))for(const [kind,label] of [['kiro','Kiro'],['antigravity','Antigravity']])catalog.push({kind,label,installed:false,added:false,readiness:'missing'});
if(process.argv.includes('--ading-test-install'))Object.assign(catalog[2],{label:'Qoder CN',installed:false,readiness:'missing',cliMissing:true,version:undefined});
const loginKinds=[];
let loginResolution,loginOutcome='ready';
let lastCreatedInput;
const passwordChanges = [];
let createdConversations = 0;
const reportedConversationIds = [];
const stoppedConversationIds = [];
const verifiedKinds = [];
const refreshedAgentIds = [];
let permissionMode='unattended';
let keepAwake=true;
let accountUser = process.argv.includes("--ading-test-onboarding") ? {userId:"test-account",username:"tester",displayName:"tester"} : null;
let pendingFriendRequests=[];const sharingCalls=[];
let canAddFriend = true;
let accountProfileEdits = {};
let localProfileEdits = 0;
let pickedAttachments = 0;
let attachmentPickCount = 1;
let attachmentRejected = [];
const savedAttachments = [];
let attachmentSaveOutcome = 'saved';
const openedAttachments = [];
const openedLinks = [];
const revealedArtifacts = [];
const sentMessages = [];
let deferSend = false; const pendingSends = [];
let deferLoad = false; const pendingLoads = [];
let testModelCatalog = { supported: false, models: [] };
const testModelCalls = [];
const bridgeUserFor = async (userId) => ({ userId });
const bridge = {
  loginAgent: async(kind,confirmed)=>{
    if(!confirmed)throw Error('explicit action required');
    loginKinds.push(kind);
    listeners.onAgentLifecycleProgress?.({kind,action:'login',text:localStorage.getItem('ading.language')==='en'?'Complete sign-in in your browser':'请在浏览器完成登录'});
    await new Promise(resolve=>{loginResolution=resolve;});
    const status=catalog.find(item=>item.kind===kind);
    if(loginOutcome==='throw')throw Error('fixture login transport failed');
    if(loginOutcome==='cancelled')return{kind,action:'login',ok:false,message:'登录已取消'};
    if(kind==='copilot' && loginOutcome==='access-denied'){
      Object.assign(status,{readiness:'error',recovery:undefined,detail:'403 "unauthorized: not authorized to use this Copilot feature"'});
      return{kind,action:'login',ok:true,verification:status,message:'Signed in successfully'};
    }
    Object.assign(status,{readiness:loginOutcome==='ready'?'ready':'error',recovery:loginOutcome==='ready'?undefined:recovery,detail:loginOutcome==='ready'?'OK':'所选模型仍未同步'});
    return{kind,action:'login',ok:true,verification:status,message:'登录完成'};
  },
  installAgent: async(kind,confirmed)=>{
    if(!confirmed)throw Error('explicit action required');
    await new Promise(resolve=>{installResolutions.set(kind,resolve);});
    Object.assign(catalog.find(item=>item.kind===kind),{installed:true,readiness:'found',cliMissing:false,version:'9.9.9'});
    return{kind,action:'install',ok:true,message:'安装完成'};
  },
  cancelAgentLifecycle:async()=>{loginOutcome='cancelled';loginResolution?.();return true;},
  reportConversation: async conversationId => { reportedConversationIds.push(conversationId); return {}; },
  createConversation: async input => {
    lastCreatedInput=input;
    const conversation={...base,conversationId:`test-created-${++createdConversations}`,name:input.name,autoTitle:input.autoTitle,type:input.memberIds.length===1?"DIRECT":"GROUP",members:[{userId:me.userId,role:"ENGINEER"},...input.memberIds.map((userId,i)=>({userId,role:i?"ENGINEER":"LEADER"}))],paused:false};
    conversations.push(conversation); return conversation;
  },
  bootstrap: async () => ({ mode: 'local', me, contacts, workspaces, conversations, runtime: { revision: 5, agents: [{ agentUserId: 'test-c', conversationId: 'test-group', busy: true }] } }),
  accountComputer:async()=>null,
  onboardingProgress: async (mask) => {
    if (localStorage.getItem('test-onboarding-fail') === 'true') return {ok:false};
    const key = 'test-server.onboarding.' + accountUser.userId;
    let steps = Number(localStorage.getItem(key) || 0);
    if(mask !== undefined) { steps |= mask; localStorage.setItem(key,String(steps)); }
    return {ok:true,data:{version:1,completedSteps:steps}};
  },
  accountStatus: async () => (accountUser ? { signedIn: true, user: accountUser, canAddFriend, onboardingEligible: process.argv.includes("--ading-test-onboarding") } : { signedIn: false }),
  accountLogin: async username => { accountUser = { userId: 'test-account', username, displayName: username }; return { ok: true, status: { signedIn: true, user: accountUser, canAddFriend } }; },
  accountRegister: async () => ({ ok: true, status: { signedIn: false } }),
  accountLogout: async () => { accountUser = null; return { signedIn: false }; },
  changeAccountPassword: async (current, next) => { passwordChanges.push([current, next]); return true; },
  syncPending: async () => 0,
  updateContact: async (userId, patch) => { if (userId === me.userId) localProfileEdits++; return { ...(userId === me.userId ? me : contacts.find(c => c.userId === userId)), ...patch }; },
  accountProfile: async () => (accountUser ? { ...accountUser, ...accountProfileEdits } : null),
  updateAccountProfile: async patch => { accountProfileEdits = { ...accountProfileEdits, displayName: patch.displayName, avatarUrl: patch.avatarUrl || undefined, phone: patch.phone || undefined, email: patch.email || undefined }; return { ...accountUser, ...accountProfileEdits }; },
  setLanguage: async language=>language,
  getPermissionMode: async()=>permissionMode,
  setPermissionMode: async mode=>(permissionMode=mode),
  getKeepAwake: async()=>keepAwake,
  setKeepAwake: async enabled=>(keepAwake=enabled!==false),
  checkPermissions: async()=>({accessibility:true,screenRecording:false,screenRecordingRequested:true,automation:[{bundleId:'com.apple.systemevents',name:'System Events',status:'granted'},{bundleId:'com.apple.finder',name:'Finder',status:'notDetermined'}]}),
  grantPermission: async()=>null, openPermissionSettings: async()=>null,
  listPage: async (kind, ids) => { listPageRequests.push({kind,size:ids.length}); return ids.slice(0, kind === "switcher" ? 10 : 100).flatMap(id => { const item = (kind === "contacts" ? contacts : conversations).find(item => (kind === "contacts" ? item.userId : item.conversationId) === id); return item ? [item] : []; }); },
  listContacts: async () => contacts, listConversations: async () => conversations,
  updateConversation: async (id, patch) => { const conversation = conversations.find(item => item.conversationId === id); Object.assign(conversation, patch); return conversation; },
  listFriendRequests: async () => pendingFriendRequests,
  shareAgent:async(agentId,recipientId,shared)=>{sharingCalls.push({agentId,recipientId,shared});const agent=contacts.find(c=>c.userId===agentId);const ids=new Set(agent.sharedWith??[]);if(shared)ids.add(recipientId);else ids.delete(recipientId);agent.sharedWith=[...ids];listeners.onStoreEvent?.({type:"contacts"});}, searchPeople: async () => [], requestFriend: async () => 'OUTGOING', acceptFriend: async () => {}, dismissFriendRequest: async () => {},
  getConversation: async id => conversations.find(t => t.conversationId === id),
  listWorkspaces: async () => workspaces,
  listMessages: async id => { if(process.argv.includes('--ading-test-math'))return [
    {messageId:'math-agent',conversationId:id,seq:1,senderId:'test-c',type:'USER',content:'明白，按打叉的题选错题。\n\n问号标在第 14 题：**题目结论成立，但证明中提取公因式那一步有误。**正确写法是：\n\n'+String.raw`\[
\begin{aligned}
3^{n+2}-2^{n+2}+3^n-2^n
&=(9+1)3^n-(4+1)2^n\\
&=10\cdot3^n-5\cdot2^n\\
&=10(3^n-2^{n-1}).
\end{aligned}
\]`+'\n\n因为 '+String.raw`\(n\)`+' 是正整数，所以原式是 10 的倍数。',createdAt:base.createdAt},
    {messageId:'math-user',conversationId:id,seq:2,senderId:me.userId,type:'USER',content:String.raw`行内 $x^2$，独立 $$\frac{1}{2}$$`,createdAt:base.createdAt},
    {messageId:'math-code',conversationId:id,seq:3,senderId:'test-c',type:'USER',content:'```tex\n$x$\n```\n`$y$`\n$5 and $10\n'+String.raw`\[\notARealCommand{x}\]`+'\n<img src=x onerror="window.mathXss=true">',createdAt:base.createdAt}
  ]; if (process.argv.includes('--ading-test-links')) return [
    {messageId:'links-agent',conversationId:id,seq:1,senderId:'test-c',type:'USER',content:'按[Example skill](</Users/example/Library/Application Support/ADing/SKILL.md>) 查看。\n[检查报告](review-report.txt) [相对目录](<./reports/check report.txt>) [安全](javascript:alert) \n`https://code.example.com/`',createdAt:base.createdAt},
    {messageId:'links-user',conversationId:id,seq:2,senderId:me.userId,type:'USER',content:'网页 https://mp.weixin.qq.com/s/example。 https://mp.weixin.qq.com/s/example https://unavailable.example/page.',createdAt:base.createdAt},
    {messageId:'links-private',conversationId:id,seq:3,senderId:'test-c',type:'USER',content:'The [sample notebook](https://www.yuque.com/example/notebook/sample-page) contains three exercises.',createdAt:base.createdAt}
  ]; if (id==='test-people') return Array.from({length:60},(_,i)=>({messageId:`people-${i+1}`,conversationId:id,seq:i+1,senderId:'test-friend-a',type:'USER',content:i===2?`@${me.displayName} 帮忙看一下，也 @Bob 一下`:`第 ${i+1} 条`,mentions:i===2?[me.userId,'test-friend-b']:[],status:'SENT',createdAt:base.createdAt})); if (deferLoad) { deferLoad=false; await new Promise((resolve,reject)=>pendingLoads.push({resolve,reject})); } return [{ messageId: `${id}-1`, conversationId: id, seq: 1, senderId: 'test-c', type: 'USER', content: '我们可以先确定讨论目标，再逐步完善细节。', createdAt: base.createdAt,
    ...(process.argv.includes('--ading-test-images') ? {attachments:[
      {attachmentId:'f_image_1',name:'image-one.png',mimeType:'image/png',size:2048,kind:'image'},
      {attachmentId:'f_image_2',name:'image-two.png',mimeType:'image/png',size:2048,kind:'image'},
      {attachmentId:'f_document',name:'document.pdf',mimeType:'application/pdf',size:2048,kind:'file'}
    ]} : {}) }]; },
  setAgentAdded: async (kind,added) => { const status=catalog.find(a=>a.kind===kind);status.added=added;const contact=contacts.find(a=>a.kind===kind);if(contact)contact.enabled=added;return catalog; },
  listProposals: async () => [], agentCatalog: async () => catalog, verifyAgent: async kind => { verifiedKinds.push(kind); if(process.argv.includes('--ading-test-install-progress')){const status=catalog.find(item=>item.kind===kind);if(status?.installed)status.readiness='ready';} if (process.argv.includes('--ading-test-install') && kind === 'qoder-cn') { const status = catalog.find(item => item.kind === kind); if (status.installed) { await new Promise(resolve => { verifyResolution = resolve; }); status.readiness = 'ready'; } } if (process.argv.includes('--ading-test-slow-verify')) await new Promise(r => setTimeout(r, 2500)); return catalog; }, refreshAgentStatus: async userId => { refreshedAgentIds.push(userId); return { requested: false, catalog }; }, markRead: async (id, seq) => {
    if (!trackReadReceipts) return;
    const member = conversations.find(item => item.conversationId === id)?.members.find(item => item.userId === me.userId);
    if (member) member.lastReadSeq = Math.max(member.lastReadSeq, seq);
  },
  captureSupportScreenshot: async () => null,
  appInfo: async () => ({ version: '0.4.0-2026.9.16-231949-dev', channel: 'develop' }),
  updateState: async () => ({ phase: 'idle' }), checkForUpdates: async () => ({ phase: 'up-to-date', checkedAt: '2026-09-16T00:00:00Z' }), openUpdatePackage: async () => {}, installUpdate: async () => { updateInstalls++; return { started: false }; },
  submitSupportReport: async () => ({ reportId: 'report_test_1', status: 'pending-upload', filePath: '/tmp/x.json', backgroundUpload: true }),
  agentModelCatalog: async () => JSON.parse(JSON.stringify(testModelCatalog)),
  setAgentModel: async (userId, modelId) => { testModelCalls.push([userId, modelId]); return (await bridgeUserFor(userId)); },
  contactDeveloper: async () => ({ contactId: 'contact_test_1', status: 'pending-send', filePath: '/tmp/y.json', backgroundUpload: true }),
  setAgentPaused: async () => { throw new Error('Unavailable Agent must not resume'); },
  stopConversation: async id => {
    stoppedConversationIds.push(id);
    const c = conversations.find(c => c.conversationId === id);
    if (c && !c.members.some(m => m.userId === me.userId)) for (const member of c.members) if (contacts.find(u => u.userId === member.userId)?.owner === me.userId) member.ownerPaused = true;
    return 1;
  },
  listStoppedConversations: async () => [...new Set(stoppedConversationIds)],
  resumeConversation: async id => { const c = conversations.find(c => c.conversationId === id); if(c) for(const member of c.members) member.ownerPaused = false; for (let i = stoppedConversationIds.indexOf(id); i >= 0; i = stoppedConversationIds.indexOf(id)) stoppedConversationIds.splice(i, 1); },
  setMemberRole: async (id, userId, role) => {
    const conversation=conversations.find(t=>t.conversationId===id);
    conversation.members.forEach(m=> { if(m.userId===userId) m.role=role; else if(role==='LEADER' && m.role==='LEADER') m.role='ENGINEER'; });
    return conversation;
  },
  addMember: async (id,userId,role) => {
    const conversation=conversations.find(t=>t.conversationId===id);
    if(conversation.members.some(m=>m.userId===userId)) throw Error('重复成员');
    conversation.members.push({userId,role,lastReadSeq:0}); return conversation;
  },
  removeMember: async (id,userId) => {
    const conversation=conversations.find(t=>t.conversationId===id);
    if(userId===conversation.owner) throw Error('不能移除拥有者');
    conversation.members=conversation.members.filter(m=>m.userId!==userId); return conversation;
  },
  pickAttachments: async () => ({ attachments: Array.from({ length: attachmentPickCount }, () => ({ attachmentId: `f_test_${++pickedAttachments}`, name: `截图${pickedAttachments}.png`, mimeType: 'image/png', size: 2048, kind: 'image' })), rejected: attachmentRejected }),
  deleteConversation: async id => { const index = conversations.findIndex(item => item.conversationId === id); if (index >= 0) conversations.splice(index, 1); },
  importAttachmentPaths: async paths => ({ attachments: paths.map((p, i) => ({ attachmentId: `f_drop_${i}`, name: p.split('/').pop(), mimeType: 'application/pdf', size: 10, kind: 'file' })), rejected: [] }),
  importAttachmentData: async (name, mimeType, bytes) => ({ attachmentId: 'f_paste', name, mimeType, size: bytes.byteLength, kind: 'image' }),
  openExternal: async url => { openedLinks.push(url); },
  revealArtifact: async (target, conversationId) => { revealedArtifacts.push(target.startsWith("/") ? target : {target,conversationId}); },
  linkPreview: async url => url.includes("unavailable") ? null : ({title:url.includes("yuque") ? "语雀" : "网页标题 / Web title",description:url.includes("yuque") ? "" : "网页摘要 / Web summary <script>never execute</script>",siteName:url.includes("yuque") ? "www.yuque.com" : "微信 / WeChat",image:process.argv.find(arg=>arg.startsWith("--ading-preview-image="))?.slice("--ading-preview-image=".length) ?? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}),
  openAttachment: async (conversationId, attachment) => { openedAttachments.push([conversationId, attachment.attachmentId]); },
  saveAttachment: async (conversationId, attachment) => { savedAttachments.push([conversationId, attachment.attachmentId]); if(attachmentSaveOutcome==='error') throw Error('disk unavailable'); return attachmentSaveOutcome!=='cancelled'; },
  pathForFile: file => `/tmp/${file.name}`,
  sendMessage: async input => {
    sentMessages.push(input);
    if (deferSend) { deferSend = false; await new Promise((resolve,reject)=>pendingSends.push({resolve,reject})); }
    const conversation = conversations.find(t => t.conversationId === input.conversationId);
    const message = { ...input, messageId: input.clientMessageId, seq: ++conversation.lastSeq, senderId: me.userId, type: 'USER', createdAt: base.createdAt };
    listeners.onStoreEvent?.({type:'message',conversationId:conversation.conversationId,message});
    conversation.paused = false;
    listeners.onStoreEvent?.({type:'conversation',conversationId:conversation.conversationId});
    return message;
  }
};
const listeners = {};
for (const name of ['onStoreEvent', 'onAgentProgress', 'onAgentBusy', 'onAgentQueue', 'onAgentLifecycleProgress', 'onSupportUploadResult', 'onAccountChanged', 'onDataSwitching', 'onDataSwitched', 'onUpdateState', 'onComputerPermissionMissing', 'onWindowActive', 'onOpenConversation']) bridge[name] = callback => { listeners[name] = callback; };
contextBridge.exposeInMainWorld('ading', bridge);
contextBridge.exposeInMainWorld('adingTest', {
  setAgentFailure: (kind, detail) => { Object.assign(catalog.find(item=>item.kind===kind),{readiness:detail?'error':'ready',detail,recovery:undefined});listeners.onStoreEvent?.({type:'agents'}); },
  setModelCatalog: (catalog) => { testModelCatalog = catalog; },
  modelCalls: () => testModelCalls.splice(0),
  setContactRemote: (userId, remote) => { const contact = contacts.find(c => c.userId === userId); if (remote) contact.remote = remote; else delete contact.remote; listeners.onStoreEvent?.({ type: 'contacts' }); },
  setupSharing:()=>{
    for(const contact of contacts)if(contact.isAgent){contact.owner=me.userId;contact.sharedWith=[];}
    if(!contacts.some(c=>c.userId==='test-friend'))contacts.push({userId:'test-friend',displayName:'Friend',isAgent:false,friend:true});
    accountUser={...me,username:'tester'};canAddFriend=true;
    pendingFriendRequests=[{userId:'incoming-friend',displayName:'New friend',relation:'INCOMING'}];
    listeners.onAccountChanged?.({signedIn:true,user:accountUser,canAddFriend});listeners.onStoreEvent?.({type:'contacts'});listeners.onStoreEvent?.({type:'friends'});
  },
  setSharedMemberRecipients:ids=>{contacts.find(c=>c.userId==='test-shared-qwen').sharedWith=ids;listeners.onStoreEvent?.({type:'contacts'});},
  sharingCalls:()=>sharingCalls,
  clearFriendRequests:()=>{pendingFriendRequests=[];listeners.onStoreEvent?.({type:"friends"});},

  setWindowActive:active=>listeners.onWindowActive?.(active),
  openNotification:id=>listeners.onOpenConversation?.(id),
  readPosition:id=>conversations.find(item=>item.conversationId===id)?.members.find(item=>item.userId===me.userId)?.lastReadSeq,
  incomingMessage:id=>{
    trackReadReceipts=true;
    const conversation=conversations.find(item=>item.conversationId===id);
    const message={messageId:'incoming-'+(++conversation.lastSeq),conversationId:id,seq:conversation.lastSeq,senderId:'test-c',type:'USER',content:'Unread incoming',createdAt:new Date().toISOString()};
    conversation.lastMessage=message;listeners.onStoreEvent?.({type:'message',conversationId:id,message});
    return message.seq;
  },
  setUnreadConversations: entries => {
    trackReadReceipts = true;
    for (const conversation of conversations) {
      conversation.members = conversation.members.map(member => ({...member, lastReadSeq: conversation.lastSeq}));
      const entry = entries.find(item => item.id === conversation.conversationId);
      if (entry) {
        conversation.lastSeq++;
        conversation.updatedAt = entry.time;
        conversation.lastMessage = {messageId:`unread-${conversation.conversationId}-${conversation.lastSeq}`, conversationId:conversation.conversationId, seq:conversation.lastSeq, senderId:'test-c', type:'USER', content:'Unread test message', createdAt:entry.time};
      }
    }
    listeners.onStoreEvent?.({type:'conversation',conversationId:'test-direct'});
  },
  setAttachmentPickCount: count => { attachmentPickCount = count; },
  setAttachmentRejected: list => { attachmentRejected = list; },
  // The direct-chat peer is not in contacts or user profiles (e.g. deleted): "New conversation" in the switch menu has no one available
  addOrphanDirect: () => {
    conversations.push({ ...base, conversationId: 'test-orphan', name: '失联单聊', type: 'DIRECT', members: [{ userId: me.userId, role: 'ENGINEER', lastReadSeq: 0 }, { userId: 'test-gone', role: 'LEADER', lastReadSeq: 0 }], paused: false });
    listeners.onStoreEvent?.({ type: 'conversation', conversationId: 'test-orphan' });
  },
  savedAttachments: () => savedAttachments,
  setAttachmentSaveOutcome: outcome => { attachmentSaveOutcome = outcome; },
  setOnboardingAccount: (userId, eligible) => {
    accountUser = {userId, username:userId, displayName:userId};
    listeners.onAccountChanged?.({signedIn:true,user:accountUser,canAddFriend,onboardingEligible:eligible});
  },
  setFriendPermission: allowed => {
    canAddFriend = allowed;
    accountUser ??= { userId: 'test-account', username: 'tester', displayName: 'tester' };
    listeners.onAccountChanged?.({ signedIn: true, user: accountUser, canAddFriend });
  },
  loginKinds:()=>loginKinds,
  finishInstall:(kind='qoder-cn')=>{installResolutions.get(kind)?.();installResolutions.delete(kind);},
  finishVerify:()=>verifyResolution?.(),
  finishLogin:outcome=>{loginOutcome=outcome;loginResolution?.();},
  requireModelSync:()=>{Object.assign(catalog[1],{readiness:'error',recovery});},
  localProfileEdits: () => localProfileEdits,
  passwordChanges: () => passwordChanges,
  createdInput: () => lastCreatedInput,
  sentMessages: () => sentMessages,
  deferLoad: () => { deferLoad = true; },
  failLoad: () => { pendingLoads.shift().reject(Error("load unavailable")); },
  pendingLoads: () => pendingLoads.length,
  deferSend: () => { deferSend = true; },
  failSend: () => { pendingSends.shift().reject(Error('origin unavailable')); },
  pendingSends: () => pendingSends.length,
  openedAttachments: () => openedAttachments,
  openedLinks: () => openedLinks,
  revealedArtifacts: () => revealedArtifacts,
  reportedConversationIds: () => reportedConversationIds,
  stoppedConversationIds: () => stoppedConversationIds,
  verifiedKinds: () => verifiedKinds,
  refreshedAgentIds: () => refreshedAgentIds,
  clearConversations:()=>{conversations.splice(0);listeners.onStoreEvent?.({type:'conversation',conversationId:'removed'});},
  manyMembers: () => {
    for(let i=0;i<30;i++) {
      const user={userId:`extra-${i}`,displayName:`测试成员 ${i}`,isAgent:i%2===0};
      contacts.push(user); conversations[0].members.push({userId:user.userId,role:'ENGINEER',lastReadSeq:0});
    }
    listeners.onStoreEvent?.({type:'conversation',conversationId:conversations[0].conversationId});
  },
  emit: (name, payload) => listeners[name]?.(payload),
  updateInstalls: () => updateInstalls,
  bumpConversation: () => { conversations[2].updatedAt = '2026-09-05T02:00:00Z'; listeners.onStoreEvent?.({type:'conversation',conversationId:conversations[2].conversationId}); },
  unavailable: () => { catalog[0].readiness = 'error'; listeners.onStoreEvent?.({ type: 'agents' }); }
});

contextBridge.exposeInMainWorld("adingListTest", {requests: () => listPageRequests});
