const {app,BrowserWindow,screen}=require('electron');
const {mkdtemp}=require('./tmp.cjs');
const {rm,writeFile}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
const {PermissionDialogs}=require('../dist/permissions/dialog.js');const {PermissionGrants}=require('../dist/permissions/grants.js');
const {setMainLanguage}=require('../dist/i18n.js');
(async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'ading-dialog-test-'));app.setPath('userData',path.join(dir,'profile'));
 await app.whenReady();const w=new BrowserWindow({show:false});
 const file=path.join(dir,'grants.json');
 try{
  let count=0,choice=2,language='zh-CN',onOpen;
  app.on('browser-window-created',(_event,child)=>{
   count++;
   child.webContents.once('did-finish-load',()=>{void(async()=>{
    const view=await child.webContents.executeJavaScript(`(()=>{const p=document.querySelector('pre');return {buttons:[...document.querySelectorAll('button')].map(b=>b.textContent),defaultButton:document.activeElement.dataset.response,scroll:p.scrollHeight>p.clientHeight,detail:p.textContent,bodyOverflow:document.body.scrollHeight>innerHeight,buttonsVisible:[...document.querySelectorAll('button')].every(b=>b.getBoundingClientRect().bottom<=innerHeight),injected:!!document.querySelector('script,img')}})()`);
    assert.deepEqual(view.buttons,language==='en'?['Deny','Allow once','Always allow']:['拒绝','允许本次','始终允许']);
    assert.equal(view.defaultButton,'0');assert.equal(view.bodyOverflow,false);assert.equal(view.buttonsVisible,true);assert.equal(view.injected,false);
    const area=screen.getDisplayMatching(w.getBounds()).workArea;assert.ok(child.getBounds().height<=area.height-48);
    if(onOpen){const check=onOpen;onOpen=undefined;await check(child,view);}
    if(!child.isDestroyed())await child.webContents.executeJavaScript(`document.querySelector('[data-response="${choice}"]').click()`);
   })().catch(e=>{console.error(e);app.exit(1);});});
  });
  const boxes=new PermissionDialogs(new PermissionGrants(file));
  const conversation={conversationId:'conversation',name:'测试会话'},agent={userId:'cc',displayName:'小cc',kind:'claude-code'};
  const request={toolName:'Read',input:{file_path:'/fixture/a'},signal:new AbortController().signal};
  assert.equal(await boxes.request(conversation,agent,request),true);assert.equal(count,1);
  const reopened=new PermissionDialogs(new PermissionGrants(file));
  assert.equal(await reopened.request(conversation,agent,request),true);assert.equal(count,1,'saved approval skips future prompts');
  await reopened.clearConversation(conversation.conversationId);choice=1;
  assert.equal(await reopened.request(conversation,agent,request),true);assert.equal(count,2);
  choice=0;assert.equal(await reopened.request(conversation,agent,request),false);assert.equal(count,3,'allow once is not remembered');
  const cancelled=new AbortController();cancelled.abort();assert.equal(await reopened.request(conversation,agent,{...request,signal:cancelled.signal}),false);assert.equal(count,3);
  for(const lang of ['zh-CN','en']){
   language=lang;setMainLanguage(lang);
   const input={file_path:'/fixture/long.txt',content:'line of content\n'.repeat(650)+'<script>alert(1)</script><img src=x>END'};
   onOpen=async(child,view)=>{
    assert.equal(view.scroll,true,'long parameters scroll inside the bounded window');
    assert.ok(view.detail.endsWith(JSON.stringify(input,null,2)),'all parameters are preserved as text');
    await child.webContents.executeJavaScript(`const p=document.querySelector('pre');p.scrollTop=p.scrollHeight`);
    assert.ok(await child.webContents.executeJavaScript(`document.querySelector('pre').scrollTop>0`));
    if(process.env.ADING_PERMISSION_QA_DIR)await writeFile(path.join(process.env.ADING_PERMISSION_QA_DIR,`permission-${lang}.png`),(await child.webContents.capturePage()).toPNG());
   };
   assert.equal(await reopened.request(conversation,agent,{...request,toolName:'Write',input}),false);
  }
  const abort=new AbortController();onOpen=async()=>abort.abort();
  assert.equal(await reopened.request(conversation,agent,{...request,signal:abort.signal}),false,'aborting an open approval denies and closes it');
  onOpen=async child=>child.close();assert.equal(await reopened.request(conversation,agent,request),false,'window close denies');
  console.log('permission-dialog: bounded long content, full text, visible buttons, languages, always/once/deny, restart, clear and cancellation passed');
 }finally{await rm(dir,{recursive:true,force:true});w.destroy();}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
