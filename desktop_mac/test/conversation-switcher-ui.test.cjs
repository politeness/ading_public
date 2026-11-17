const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-switcher-'));app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 await win.loadFile(join(__dirname,'../src/index.html'));
 const run=s=>win.webContents.executeJavaScript(s),wait=()=>run('new Promise(r=>setTimeout(r,300))');
 const click=s=>run(`document.querySelector(${JSON.stringify(s)}).click()`);
 const old='#conversation-switcher-menu [data-conversation-id="test-direct"]';
 await wait();await click('[data-conversation-id="test-direct"] .conversation-list-button');await wait();
 for(const tab of ['conversations','contacts']){
  if(tab==='contacts'){await click('#tab-contacts');await click('.contact-list-item[data-user-id="test-c"] .contact-button');await wait();}
  await click('#conversation-switcher-button');await click('#conversation-switcher-menu .conversation-switcher-new');await wait();
  for(let i=0;i<2;i++){
   await click('#conversation-switcher-button');await wait();
   assert.ok(await run(`!!document.querySelector(${JSON.stringify(old)})`),`${tab}: unsent contact draft lists original conversation on every reopen`);
   await click('#conversation-switcher-button');await wait();
  }
  await click('#conversation-switcher-button');await click(old);await wait();
  assert.equal(await run(`document.querySelector('#conversation-name-center').textContent`),'单聊','can return to original before sending');
 }
 await click('#tab-conversations');await click('#conversation-switcher-button');await click('#conversation-switcher-menu .conversation-switcher-new');await wait();
 await run(`const input=document.querySelector('#message-input');input.value='new conversation';input.dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit()`);await wait();
 await click('#conversation-switcher-button');await wait();assert.ok(await run(`!!document.querySelector(${JSON.stringify(old)})`),'created conversation still lists original');
 await click(old);await wait();assert.ok(await run(`!!document.querySelector('[data-conversation-id="test-direct"] .conversation-list-button.active')`),'can return after first message');
 // The direct-chat contact no longer exists (e.g. deleted): "New conversation" is disabled, and hover and screen readers explain why
 await run(`window.adingTest.addOrphanDirect()`);await wait();
 await click('[data-conversation-id="test-orphan"] .conversation-list-button');await wait();
 await click('#conversation-switcher-button');await wait();
 const orphan='#conversation-switcher-menu .conversation-switcher-new';
 assert.deepEqual(await run(`(()=>{const b=document.querySelector(${JSON.stringify(orphan)});return {disabled:b.disabled,aria:b.getAttribute('aria-disabled'),tip:b.dataset.tooltip,label:b.getAttribute('aria-label')};})()`),{disabled:true,aria:'true',tip:'找不到这位联系人（可能已删除），无法新建会话',label:'新建会话（找不到这位联系人（可能已删除），无法新建会话）'});
 await run(`document.querySelector(${JSON.stringify(orphan)}).dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))`);await wait();
 assert.equal(await run(`document.querySelector('#icon-tooltip').matches(':popover-open')?document.querySelector('#icon-tooltip').textContent:''`),'找不到这位联系人（可能已删除），无法新建会话','the disabled item explains why on hover');
 await run(`document.querySelector(${JSON.stringify(orphan)}).dispatchEvent(new PointerEvent('pointerout',{bubbles:true}))`);
 await click('#conversation-switcher-button');await wait();
 // Successful conversation deletion must give feedback
 await run(`document.querySelector('[data-conversation-id="test-orphan"] .conversation-item-delete').click()`);await wait();
 await click('#delete-confirm-action');await wait();
 assert.equal(await run(`document.querySelector('[data-conversation-id="test-orphan"] .conversation-list-button')`),null,'the deleted conversation leaves the list');
 assert.equal(await run(`document.querySelector('#discovery-status').hidden?'':document.querySelector('#discovery-status-text').textContent`),'会话已删除','deleting a conversation confirms it');
 win.destroy();console.log('conversation-switcher: unsent drafts, repeated opens, both tabs and created conversations passed');app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
