const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const LIST='#conversation-add-member-list',PICK='#group-member-list';
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-member-lock-hint-'));app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-many-contacts','--ading-test-share-hints'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 try{
  await win.loadFile(join(__dirname,'../src/index.html'));
  const run=s=>win.webContents.executeJavaScript(s),wait=(ms=250)=>run(`new Promise(r=>setTimeout(r,${ms}))`);
  const click=async s=>{await run(`document.querySelector(${JSON.stringify(s)}).click()`);await wait();};
  const select=id=>click(`[data-conversation-id="${id}"] .conversation-list-button`);
  const toggleMenu=()=>click('#conversation-add-member-button');
  const search=async text=>{await run(`(()=>{const input=document.querySelector('#conversation-add-member-search');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input'))})()`);await wait();};
  // Real pointer movement: synthetic events cannot catch hit-testing issues or disabled checkboxes swallowing events
  const leave=async()=>{win.webContents.sendInputEvent({type:'mouseMove',x:2,y:2});await wait(120);};
  const hover=async selector=>{
   await leave();
   await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
   // Scroll events dismiss the bubble (by design), so wait for it to settle before moving the pointer
   await wait(120);
   const box=await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width}})()`);
   assert.ok(box.w>0,`${selector} visible`);
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(box.x),y:Math.round(box.y)});
   await wait(320);
   return run(`(()=>{const t=document.querySelector('#icon-tooltip');return t.matches(':popover-open')?t.textContent:''})()`);
  };
  const row=(list,id)=>`${list} [data-user-id="${id}"]`;
  const expectRow=async(list,id,text,parts)=>{
   assert.equal(await run(`document.querySelector('${row(list,id)}').getAttribute('aria-disabled')`),'true',`${id} marked unavailable`);
   for(const part of parts)assert.equal(await hover(part?`${row(list,id)} ${part}`:row(list,id)),text,`${id} hover ${part||'row'}`);
  };
  const MENU_PARTS=['','.conversation-agent-menu-avatar','.conversation-agent-readiness','.conversation-agent-menu-name','input[type="checkbox"]'];
  await wait();

  // Scenario from the feedback: direct chat, your own Agent not shared with the other person
  await select('test-hint-direct');await toggleMenu();await search('小a');
  await expectRow(LIST,'test-hint-own','先把 小a 分享给 Alice',MENU_PARTS);
  // While the bubble takes over, native title attributes in the row must not remain, otherwise one hover shows two tooltips; restore them after leaving
  await hover(`${row(LIST,'test-hint-own')} .conversation-agent-readiness`);
  assert.equal(await run(`document.querySelectorAll('${row(LIST,'test-hint-own')} [title]').length`),0,'Child title attributes are removed during takeover');
  await leave();
  assert.equal(await run(`document.querySelector('${row(LIST,'test-hint-own')} .conversation-agent-readiness').hasAttribute('title')`),true,'title is restored after leaving');
  assert.equal(await run(`document.querySelector('#icon-tooltip').matches(':popover-open')`),false,'Bubble disappears after leaving');
  // Pointer did not move but the whole menu re-rendered (Agent status changes do this); the bubble must not disappear with it
  await hover(row(LIST,'test-hint-own'));
  await run(`document.querySelector('#conversation-add-member-search').dispatchEvent(new Event('input'))`);await wait(60);
  assert.equal(await run(`(()=>{const t=document.querySelector('#icon-tooltip');return t.matches(':popover-open')?t.textContent:''})()`),'先把 小a 分享给 Alice','Bubble still there after re-render');
  await leave();
  // Grey rows still cannot be checked
  await run(`document.querySelector('${row(LIST,'test-hint-own')}').click()`);await wait();
  assert.deepEqual(await run(`(()=>{const b=document.querySelector('${LIST} input[value="test-hint-own"]');return {checked:b.checked,disabled:b.disabled}})()`),{checked:false,disabled:true},'Clicking a grey row does not check it');
  // The existing hint for the locked direct-chat partner also pops up
  await search('Alice');
  assert.equal(await hover(row(LIST,'test-hint-alice')),'单聊的对方不能移除','Lock reason for the direct-chat partner pops up');
  await toggleMenu();

  // Someone else's Agent; with two people they are simply listed; the owner does not count as lacking authorization
  await select('test-hint-pair');await toggleMenu();await search('小o');
  await expectRow(LIST,'test-hint-oscar-agent','需要 Oscar 把 小o 分享给 Alice和Bob',MENU_PARTS);
  // When the owner is not in contacts we cannot say who it is, so fall back to generic copy instead of exposing an id
  await search('小u');
  await expectRow(LIST,'test-hint-unknown-owner','所有真人都需获得 Agent 分享授权',['']);
  await toggleMenu();

  // With more than three people only two are listed
  await select('test-hint-crowd');await toggleMenu();await search('小a');
  await expectRow(LIST,'test-hint-own','先把 小a 分享给 Alice、Bob 和另外 2 人',['']);
  // Ordinary row: 小绝 is shared with everyone, not grey, and the green dot and avatar tooltips work as usual
  await search('小绝');
  assert.equal(await run(`document.querySelector('${row(LIST,'test-hint-ok')}').hasAttribute('aria-disabled')`),false,'Ordinary rows are not marked unavailable');
  const okLight=await run(`document.querySelector('${row(LIST,'test-hint-ok')} .conversation-agent-readiness').getAttribute('aria-label')`);
  assert.equal(await hover(`${row(LIST,'test-hint-ok')} .conversation-agent-readiness`),okLight,'Ordinary row green-dot tooltip works');
  assert.equal(await hover(`${row(LIST,'test-hint-ok')} .conversation-agent-menu-avatar`),'小绝','Ordinary row avatar tooltip works');
  await toggleMenu();

  // Greyed-out friend row: existing copy unchanged
  await select('test-hint-agent-group');await toggleMenu();await search('未授权');
  await expectRow(LIST,'test-blocked-friend','该好友尚未获全部 Agent 授权',['','.conversation-agent-menu-avatar','input[type="checkbox"]']);
  await toggleMenu();

  // New group chat member picker: the dialog is in the top layer, so the bubble must cover it too; after unlocking, the hint and marker are removed together
  await click('#new-group');
  await run(`document.querySelector('${PICK} input[value="test-hint-alice"]').click()`);await wait();
  await expectRow(PICK,'test-hint-own','先把 小a 分享给 Alice',['','.member-pick-choice span','.conversation-agent-readiness','.conversation-agent-leader']);
  await expectRow(PICK,'test-hint-oscar-agent','需要 Oscar 把 小o 分享给 Alice',['']);
  assert.equal(await hover(`${row(PICK,'test-hint-ok')} .conversation-agent-readiness`),await run(`document.querySelector('${row(PICK,'test-hint-ok')} .conversation-agent-readiness').getAttribute('aria-label')`),'Member picker ordinary row green dot works');
  await run(`document.querySelector('${PICK} input[value="test-hint-alice"]').click()`);await wait();
  assert.equal(await run(`(()=>{const r=document.querySelector('${row(PICK,'test-hint-own')}');return r.hasAttribute('aria-disabled')||'tooltip' in r.dataset})()`),false,'Marker and hint removed after unlocking');
  await run(`document.querySelector('${PICK} input[value="test-hint-own"]').click()`);await wait();
  await expectRow(PICK,'test-blocked-friend','该好友尚未获全部 Agent 授权',['']);
  await run(`document.querySelector('#group-dialog').close()`);await wait();

  // Rows like renderer.ts:friendRequestsRow: aria-disabled when disabled, and the tooltip pops up
  await click('#tab-contacts');
  await run(`window.adingTest.setupSharing()`);await wait();
  await run(`window.adingTest.setFriendPermission(false)`);await wait();
  assert.equal(await hover('.friend-requests-row'),'不支持的地区','Friend requests row shows tooltip when disabled');

  // English copy in sync
  await run(`localStorage.setItem('ading.language','en');0`);
  await win.loadFile(join(__dirname,'../src/index.html'));await wait(500);
  await select('test-hint-pair');await toggleMenu();await search('小a');
  await expectRow(LIST,'test-hint-own','Share 小a with Alice and Bob first',['','.conversation-agent-readiness']);
  await search('小o');
  await expectRow(LIST,'test-hint-oscar-agent','Oscar needs to share 小o with Alice and Bob',['']);
  await toggleMenu();await select('test-hint-crowd');await toggleMenu();await search('小a');
  await expectRow(LIST,'test-hint-own','Share 小a with Alice, Bob and 2 more first',['']);
  console.log('member-lock-hint: locked rows pop the share hint on row, avatar, light and name; normal rows keep their own tooltips');
 }finally{win.destroy();}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
