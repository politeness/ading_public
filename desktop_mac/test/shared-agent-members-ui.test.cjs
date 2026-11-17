const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-shared-members-ui-'));app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-shared-members'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 try {
  await win.loadFile(join(__dirname,'../src/index.html'));
  const run=s=>win.webContents.executeJavaScript(s);
  const wait=()=>run('new Promise(r=>setTimeout(r,200))');
  const click=async selector=>{await run(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait();};
  const hasCandidate=()=>run(`!!document.querySelector('#member-editor [data-user-id="test-shared-qwen"] .add')`);
  const headerBox=()=>run(`(()=>{const b=document.querySelector('#conversation-add-member-list input[value="test-shared-qwen"]');return b&&{disabled:b.disabled,checked:b.checked}})()`);
  await wait();await click('[data-conversation-id="test-shared-group"] .conversation-list-button');
  await click('#conversation-add-member-button');
  assert.deepEqual(await headerBox(),{disabled:true,checked:false},'stale grant list cannot authorize adding the Agent');
  await click('#conversation-add-member-button');
  await click('[data-conversation-id="test-shared-group"] .conversation-item-settings');
  await click('#settings-add-members');
  assert.equal(await hasCandidate(),false,'settings hides the Agent while the local list lacks Bob');
  // FRIENDS_CHANGED refreshes contacts and the complete recipient list after Bob receives a grant.
  await run(`window.adingTest.setSharedMemberRecipients(['test-me','test-shared-a','test-shared-b'])`);await wait();
  assert.equal(await hasCandidate(),true,'an open settings list gains the shared Agent after refreshing all grants');
  await click('#member-editor [data-user-id="test-shared-qwen"] .add');
  await click('#settings-add-members');
  assert.equal(await run(`!!document.querySelector('#member-editor [data-user-id="test-shared-qwen"] .remove')`),true,'settings can actually add the Agent');
  await click('#member-editor [data-user-id="test-shared-qwen"] .remove');
  await run(`document.querySelector('#settings-dialog').close()`);await wait();
  await click('#conversation-add-member-button');
  assert.deepEqual(await headerBox(),{disabled:false,checked:false},'header offers the fully shared Agent too');
  await click('#conversation-add-member-list input[value="test-shared-qwen"]');
  assert.deepEqual(await headerBox(),{disabled:false,checked:true},'header can actually add the shared Agent');
  await click('#conversation-add-member-list input[value="test-shared-qwen"]');
  await run(`window.adingTest.setSharedMemberRecipients(['test-me','test-shared-a'])`);await wait();
  assert.deepEqual(await headerBox(),{disabled:true,checked:false},'revoking Bob refreshes an open header menu');
  await click('#conversation-add-member-button');
  await click('[data-conversation-id="test-shared-group"] .conversation-item-settings');
  await click('#settings-add-members');
  assert.equal(await hasCandidate(),false,'settings respects revoked access too');
  await run(`document.querySelector('#settings-dialog').close()`);await wait();
  await click('[data-conversation-id="test-readonly-people"] .conversation-list-button');
  assert.equal(await run(`document.querySelector('#message-input').disabled`),true);
  assert.match(await run(`document.querySelector('#message-input').placeholder`),/成员列表/);
  await click('[data-conversation-id="test-owner-view"] .conversation-list-button');
  assert.match(await run(`document.querySelector('#message-input').placeholder`),/正在使用你的 Agent/);
  assert.equal(await run(`document.querySelector('#stop-button').hidden`),false,'owner can control shared work');
  assert.equal(await run(`document.querySelector('[data-conversation-id="test-owner-view"] .conversation-item-settings').hidden`),true);
  await run(`window.adingTest.emit('onAgentBusy',{conversationId:'test-owner-view',agentUserId:'test-c',busy:true,revision:30})`);await wait();
  assert.equal(await run(`!!document.querySelector('#conversation-identity .ikkyu-thinking')`),true,'owner sees activity even when recipient is first member');
  await click('#stop-button');
  assert.equal(await run(`document.querySelector('#message-input').disabled`),true,'control does not enable writing');
  await run(`window.adingTest.emit('onAgentBusy',{conversationId:'test-owner-view',agentUserId:'test-c',busy:false,revision:31})`);await wait();
  assert.equal(await run(`document.querySelector('#composer-stop-icon').dataset.icon`),'play');
  await click('#stop-button');
  assert.equal(await run(`document.querySelector('#composer-stop-icon').dataset.icon`),'pause');
  await click('#shared-only');
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('.conversation-list-item')).map(x=>x.dataset.conversationId)`),['test-owner-view']);
  assert.match(await run(`document.querySelector('.conversation-category').getAttribute('aria-label')`),/分享/);
  assert.equal(await run(`document.querySelector('.conversation-category').textContent`),'','category uses an icon without visible text');
  if(process.env.ADING_SHARING_SCREENSHOT) {
    require('node:fs').writeFileSync(process.env.ADING_SHARING_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
  }
  await click('#shared-only');
  await click('#new-group');
  await click('#group-member-list input[value="test-shared-qwen"]');
  assert.deepEqual(await run(`(()=>{const b=document.querySelector('#group-member-list input[value="test-shared-owner"]');return {checked:b.checked,disabled:b.disabled}})()`),{checked:true,disabled:true},'selecting the shared Agent requires its owner');
  await click('#group-member-list input[value="test-shared-qwen"]');
  assert.equal(await run(`document.querySelector('#group-member-list input[value="test-shared-owner"]').disabled`),false,'owner unlocks after removing Agent');
  await click('#group-close');
  await run(`localStorage.setItem('ading.language','en');localStorage.setItem('ading.sharedOnly','true')`);
  const en=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-shared-members'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  try {
    await en.loadFile(join(__dirname,'../src/index.html'));
    await en.webContents.executeJavaScript('new Promise(r=>setTimeout(r,200))');
    assert.deepEqual(await en.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.conversation-filters button')).map(x=>x.getAttribute('aria-label'))`),['Permanent','Shared']);
    assert.equal(await en.webContents.executeJavaScript(`document.querySelector('.conversation-category').getAttribute('aria-label')`),'Shared');
    await en.webContents.executeJavaScript(`document.querySelector('[data-conversation-id="test-owner-view"] .conversation-list-button').click()`);
    await en.webContents.executeJavaScript('new Promise(r=>setTimeout(r,200))');
    assert.match(await en.webContents.executeJavaScript(`document.querySelector('#message-input').placeholder`),/read-only/);
    assert.equal(await en.webContents.executeJavaScript(`document.querySelector('#stop-button').hidden`),false);
    assert.equal(await en.webContents.executeJavaScript(`(()=>{const buttons=[...document.querySelectorAll('.conversation-filters button')];return buttons[0].getBoundingClientRect().top===buttons[1].getBoundingClientRect().top})()`),true);

    if(process.env.ADING_SHARING_SCREENSHOT) require('node:fs').writeFileSync(process.env.ADING_SHARING_SCREENSHOT.replace('.png','-en.png'),(await en.webContents.capturePage()).toPNG());
  } finally { en.destroy(); }
  console.log('shared-agent-members UI: refreshed complete grants allow adding in both menus; revoked access blocks both again');
 } finally {win.destroy();}
 app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
