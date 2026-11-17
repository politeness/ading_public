const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');const {tmpdir}=require('node:os');const {writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
const LIST='#conversation-add-member-list';
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-add-member-menu-'));app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-many-contacts'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 try{
  await win.loadFile(join(__dirname,'../src/index.html'));
  const run=s=>win.webContents.executeJavaScript(s),wait=()=>run('new Promise(r=>setTimeout(r,300))');
  const click=async s=>{try{await run(`document.querySelector(${JSON.stringify(s)}).click()`)}catch(e){throw new Error(`click ${s}: ${e.message}`)}};
  const ids=()=>run(`[...document.querySelectorAll('${LIST} [data-user-id]')].map(row=>row.dataset.userId)`);
  const box=id=>run(`(()=>{const box=document.querySelector('${LIST} input[value="${id}"]');return box&&{checked:box.checked,disabled:box.disabled}})()`);
  const toggle=async id=>{await click(`${LIST} input[value="${id}"]`);await wait();};
  const open=async()=>{await click('#conversation-add-member-button');await wait();};
  const close=async()=>{await click('#conversation-add-member-button');await wait();};
  const search=async text=>{await run(`(()=>{const input=document.querySelector('#conversation-add-member-search');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input'))})()`);await wait();};
  const select=async id=>{await click(`[data-conversation-id="${id}"] .conversation-list-button`);await wait();};
  await wait();await select('test-group');await open();

  // Members already in the conversation come first, other contacts follow; the first screen isn't rendered all at once
  let rows=await ids();
  assert.deepEqual(rows.slice(0,2).sort(),['test-c','test-q'],'members pinned to top');
  assert.deepEqual(await box('test-c'),{checked:true,disabled:false},'Agents in the group can be unchecked');
  assert.equal((await box(rows[2])).checked,false,'other contacts unchecked');
  assert.equal(rows.length,40,'first screen renders only one page');
  if(process.env.ADING_SHOT_DIR)await writeFile(join(process.env.ADING_SHOT_DIR,'add-member-menu.png'),(await win.webContents.capturePage()).toPNG());

  // Panel height is fixed and only the list scrolls; the search box doesn't scroll with the list; scrolling to the bottom loads more
  const metrics=await run(`(()=>{const list=document.querySelector('${LIST}');const menu=document.querySelector('#conversation-add-member-menu');const search=document.querySelector('#conversation-add-member-search');return {scrolls:list.scrollHeight>list.clientHeight,inside:menu.getBoundingClientRect().bottom<=innerHeight,searchTop:search.getBoundingClientRect().top}})()`);
  assert.ok(metrics.scrolls&&metrics.inside,'list scrolls and the panel stays inside the window');
  await run(`(()=>{const list=document.querySelector('${LIST}');list.scrollTop=list.scrollHeight})()`);await wait();
  assert.equal((await ids()).length,80,'scrolling to the bottom loads another page');
  assert.equal(await run(`document.querySelector('#conversation-add-member-search').getBoundingClientRect().top`),metrics.searchTop,'search box stays fixed');
  for(let i=0;i<4;i++){await run(`(()=>{const list=document.querySelector('${LIST}');list.scrollTop=list.scrollHeight})()`);await wait();}
  rows=await ids();
  assert.equal(rows.length,104,'eventually lists all contacts');
  assert.equal(new Set(rows).size,104,'no duplicate rows');

  // People without authorization or who can't share a conversation are listed too, but can't be checked, with the reason shown
  assert.deepEqual(await box('test-blocked-friend'),{checked:false,disabled:true},'unauthorized friend cannot be checked');
  assert.ok(await run(`document.querySelector('${LIST} [data-user-id="test-blocked-friend"]').dataset.tooltip`),'uncheckable rows need a hover reason');

  // Search only filters; checked ones stay at the top
  await search('小');
  assert.deepEqual((await ids()).slice(0,2).sort(),['test-c','test-q'],'members stay pinned in search results');
  assert.ok((await ids()).includes('test-qcn'),'search finds people not yet added');

  // Checking really adds, unchecking really removes; rows don't jump while the panel is open
  const before=await ids();
  await toggle('test-qcn');
  assert.deepEqual(await box('test-qcn'),{checked:true,disabled:false},'added after checking');
  assert.deepEqual(await ids(),before,'order unchanged after checking');
  await toggle('test-qcn');
  assert.deepEqual(await box('test-qcn'),{checked:false,disabled:false},'removed after unchecking');
  await toggle('test-q');
  assert.equal((await box('test-q')).checked,false,'original members can be unchecked too');
  await close();await open();
  assert.equal((await ids())[0],'test-c','removed people are no longer pinned after reopening');
  assert.notEqual((await ids())[1],'test-q','removed people are no longer pinned after reopening');
  await search('小');await toggle('test-q');await close();

  // Direct chat: the other party is locked; adding someone turns it into a group chat draft; unchecking returns to the original direct chat
  await select('test-direct');await open();
  assert.deepEqual(await box('test-c'),{checked:true,disabled:true},'other party locked in direct chat');
  assert.ok(await run(`document.querySelector('${LIST} [data-user-id="test-c"]').dataset.tooltip`),'locked rows need a hover reason');
  await search('小');await toggle('test-q');
  assert.equal(await run(`document.querySelector('.conversation-list-button.active')`),null,'enters group chat draft');
  assert.deepEqual(await box('test-c'),{checked:true,disabled:false},'both people can be unchecked in the draft');
  await toggle('test-qcn');
  await toggle('test-qcn');
  assert.equal(await run(`document.querySelector('.conversation-list-button.active')`),null,'still a draft with two people left');
  await run(`(()=>{const input=document.querySelector('#message-input');input.value='草稿内容';input.dispatchEvent(new Event('input'))})()`);
  await toggle('test-q');
  assert.equal(await run(`document.querySelector('.conversation-list-button.active')?.closest('[data-conversation-id]')?.dataset.conversationId`),'test-direct','returns to the original direct chat');
  assert.equal(await run(`document.querySelector('#message-input').value`),'草稿内容','typed content comes back');
  assert.equal(await run(`document.querySelector('#conversation-add-member-menu').hidden`),false,'panel stays open');
  await close();

  // A draft with only one person can't remove the last one
  await click('#conversation-switcher-button');await click('#conversation-switcher-menu .conversation-switcher-new');await wait();
  await open();
  assert.deepEqual(await box('test-c'),{checked:true,disabled:true},'the last person cannot be unchecked');
  console.log('add-member-menu: lists every contact, pins members, loads while scrolling, searches, toggles and restores the direct chat');
 }finally{win.destroy();}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
