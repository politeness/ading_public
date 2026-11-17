import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {PermissionGrants} from '../dist/permissions/grants.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'ading-grants-'));
try {
 const file=path.join(dir,'grants.json');const grants=new PermissionGrants(file);
 const conversation={conversationId:'conversation',workspaceId:'workspace'},agent={userId:'cc',localUuid:'claude@node',kind:'claude-code'};
 const req={toolName:'Read',input:{file_path:'/fixture/a',offset:1}};
 const key=grants.key(conversation,agent,req);
 assert.equal(await grants.has(conversation.conversationId,key),false);
 await grants.grant(conversation.conversationId,key,grants.revision(conversation.conversationId));
 const reopened=new PermissionGrants(file);assert.equal(await reopened.has(conversation.conversationId,key),true,'restart retains explicit grant');
 assert.equal(key,reopened.key(conversation,agent,{...req,input:{offset:1,file_path:'/fixture/a'}}),'argument key order irrelevant');
 assert.equal(await reopened.has('other-conversation',key),false);
 for(const other of [reopened.key(conversation,{...agent,userId:'other'},req),reopened.key(conversation,agent,{...req,toolName:'Write'}),reopened.key(conversation,agent,{...req,input:{file_path:'/fixture/b',offset:1}})])assert.equal(await reopened.has(conversation.conversationId,other),false);
 const old=reopened.revision(conversation.conversationId);await reopened.clearConversation(conversation.conversationId);
 await reopened.grant(conversation.conversationId,key,old);assert.equal(await reopened.has(conversation.conversationId,key),false,'clear invalidates pending old approval');
 assert.equal(await new PermissionGrants(file).has(conversation.conversationId,key),false,'clear is durable');
 console.log('permission-grants: persistence, exact scope, isolation and revocation passed');
}finally{await rm(dir,{recursive:true,force:true});}
