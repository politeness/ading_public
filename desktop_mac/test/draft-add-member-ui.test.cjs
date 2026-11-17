const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-draft-add-member-'));app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 try{
  await win.loadFile(join(__dirname,'../src/index.html'));
  const run=s=>win.webContents.executeJavaScript(s),wait=()=>run('new Promise(r=>setTimeout(r,300))');
  const click=s=>run(`document.querySelector(${JSON.stringify(s)}).click()`);
  const type=text=>run(`(()=>{const input=document.querySelector('#message-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input'));})()`);
  const composer=()=>run(`({text:document.querySelector('#message-input').value,attachments:document.querySelectorAll('#composer-attachments .composer-attachment').length})`);
  const backToDirect=async()=>{await click('[data-conversation-id="test-direct"] .conversation-list-button');await wait();};
  async function contactDraftThenAddQ(text,pick){
   await click('#conversation-switcher-button');await click('#conversation-switcher-menu .conversation-switcher-new');await wait();
   await type(text);
   await run(`window.adingTest.setAttachmentPickCount(${pick})`);await click('#attach-button');await wait();
   assert.deepEqual(await composer(),{text,attachments:pick},'contact draft holds the typed text and attachments');
   await run(`document.querySelector('#conversation-add-member-menu').hidden&&document.querySelector('#conversation-add-member-button').click()`);await wait();
   await click('#conversation-add-member-list [data-user-id="test-q"] input');await wait();
   await run(`document.querySelector('#conversation-add-member-menu').hidden||document.querySelector('#conversation-add-member-button').click()`);
  }
  await wait();await backToDirect();

  // Adding a member in a direct-chat draft: text and attachments move to the group draft
  await contactDraftThenAddQ('先写好的需求',2);
  assert.deepEqual(await composer(),{text:'先写好的需求',attachments:2},'adding a member to a draft keeps text and attachments');

  // Back in the original direct chat, open another direct-chat draft and add the same person: the new combination already has a draft, so the two merge, current first, attachments deduplicated and none lost
  await backToDirect();
  await contactDraftThenAddQ('第二段',1);
  assert.deepEqual(await composer(),{text:'第二段\n\n先写好的需求',attachments:3},'merging into an existing draft keeps both texts and all attachments');

  // After sending, the input clears and no draft lingers under the old combination
  await run(`document.querySelector('#composer').requestSubmit()`);await wait();
  assert.deepEqual(await composer(),{text:'',attachments:0},'submitting the merged draft clears the composer');
  await backToDirect();
  await click('#conversation-switcher-button');await click('#conversation-switcher-menu .conversation-switcher-new');await wait();
  assert.deepEqual(await composer(),{text:'',attachments:0},'the old contact-draft key keeps no stale copy');
  console.log('draft-add-member: text and attachments survive adding members, merge into an existing draft and leave no stale copy');
 }finally{win.destroy();}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
