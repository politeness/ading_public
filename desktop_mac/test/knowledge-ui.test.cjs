const {app,BrowserWindow}=require('electron');
const {mkdtemp,readFile,writeFile,rm,mkdir}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
(async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ading-knowledge-ui-'));let win;
 try {
  app.setPath('userData',join(dir,'profile'));await app.whenReady();
  const seed=await readFile(join(__dirname,'ui-preload.cjs'),'utf8');
  const overrides=`
const knowledgeCalls=[];const skills=[];const memories=[];let retrySynced=false,retryReject=false,retryPending=false,writeFailure=false;
const retryFailures=[{category:'skills',agents:['claude-code'],detail:"EACCES: permission denied, open '/Users/fixture/.claude/skills/x/SKILL.md'"}];
bridge.listSkills=async refs=>skills.filter(skill=>!refs||refs.some(ref=>ref.scope===skill.scope&&ref.ownerId===skill.ownerId));
bridge.createSkill=async input=>{if(writeFailure)throw Error('central save failed');knowledgeCalls.push(['createSkill',input]);const skill={...input,skillId:'skill-'+skills.length,authorKind:'human',useCount:0,createdAt:base.createdAt};skills.push(skill);return skill;};
bridge.updateSkill=async(id,patch)=>{knowledgeCalls.push(['updateSkill',id,patch]);const skill=skills.find(skill=>skill.skillId===id);Object.assign(skill,patch);return skill;};
bridge.deleteSkill=async id=>{knowledgeCalls.push(['deleteSkill',id]);skills.splice(skills.findIndex(skill=>skill.skillId===id),1);};
bridge.importSkill=async input=>{knowledgeCalls.push(['importSkill',input]);const skill={...input,skillId:'import-'+skills.length,name:'Imported package',description:'Assets and scripts',content:'complete package',authorKind:'human',useCount:0,createdAt:base.createdAt};skills.push(skill);return skill;};
bridge.listMemories=async(scope,ownerId)=>memories.filter(entry=>entry.scope===scope&&entry.ownerId===ownerId);
bridge.appendMemory=async input=>{knowledgeCalls.push(['appendMemory',input]);const entry={...input,memoryId:'memory-'+memories.length,authorKind:'human',createdAt:base.createdAt};memories.push(entry);return entry;};
bridge.updateMemory=async(id,patch)=>{knowledgeCalls.push(['updateMemory',id,patch]);const entry=memories.find(entry=>entry.memoryId===id);Object.assign(entry,patch);return entry;};
bridge.deleteMemory=async id=>{knowledgeCalls.push(['deleteMemory',id]);memories.splice(memories.findIndex(entry=>entry.memoryId===id),1);};
bridge.retryKnowledgeSync=async()=>{knowledgeCalls.push(['retryKnowledgeSync']);if(retryReject)throw Error("Error invoking remote method 'skills:retry-sync': Error: store closed");return retryPending?{synced:false,failures:[]}:retrySynced?{synced:true,failures:[]}:{synced:false,failures:retryFailures};};
bridge.knowledgeSyncState=async()=>({failures:[{category:'memories',agents:['codex'],detail:'startup fixture failure'}]});
bridge.onKnowledgeSyncState=callback=>{listeners.onKnowledgeSyncState=callback;};
`;
  const preload=join(dir,'preload.cjs');
  await writeFile(preload,seed.replace("contextBridge.exposeInMainWorld('ading', bridge);",overrides+"contextBridge.exposeInMainWorld('ading', bridge);").replace("setAttachmentPickCount: count =>", "setKnowledgeRetryPending:value=>{retryPending=value;},setKnowledgeRetryResult:value=>{retrySynced=value;},setKnowledgeRetryReject:value=>{retryReject=value;},setKnowledgeWriteFailure:value=>{writeFailure=value;},knowledgeCalls:()=>knowledgeCalls, setAttachmentPickCount: count =>"));
  win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
  const run=source=>win.webContents.executeJavaScript(source).catch(error=>{throw Error(source.slice(0,160)+' -> '+error.message+'; renderer: '+errors.join('; '));});
  const wait=async()=>run('new Promise(resolve=>setTimeout(resolve,60))');
  const click=async selector=>{await run(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait();};
  const scope=async text=>{await run(`Array.from(document.querySelectorAll('#scope-list .contact-button')).find(button=>button.querySelector('.contact-name').textContent===${JSON.stringify(text)}).click()`);await wait();};
  const fill=async value=>{await run(`document.querySelector('#knowledge-editor-text').value=${JSON.stringify(value)};document.querySelector('.knowledge-editor-dialog form').requestSubmit()`);await wait();};
  const chatNotice=()=>run(`document.querySelector('#discovery-status').hidden?'':document.querySelector('#discovery-status-text').textContent`);
  const paneNotice=()=>run(`document.querySelector('#knowledge-sync-notice').hidden?'':document.querySelector('#knowledge-sync-text').textContent`);
  const emitState=failures=>run(`window.adingTest.emit('onKnowledgeSyncState',${JSON.stringify({failures})})`).then(wait);
  // Failures pushed from the main process must say which Agent and which kind of knowledge; long errors do not break the layout; the same failure does not reappear after being closed; dismissed on recovery
  // Cloud sync failures are unrelated to specific Agents, so the copy must not call them native directories; when coexisting with Agent failures both are mentioned; dismissed on recovery
  const checkCloudNotice=async(lang)=>{
   const zh=lang==='zh',cloud={category:'cloud',agents:[],detail:'/api/v1/knowledge/skill/objects: server 500'};
   await emitState([cloud]);
   assert.match(await chatNotice(),zh?/技能和记忆没能同步到云端/:/couldn't sync with the cloud/);
   assert.doesNotMatch(await chatNotice(),zh?/原生目录/:/native folders/);
   assert.match(await paneNotice(),/server 500/,'the pane keeps the reason');
   await emitState([{category:'skills',agents:['codex'],detail:'fixture'},cloud]);
   assert.match(await chatNotice(),zh?/Codex 的技能[\s\S]*同步到云端/:/skills for Codex[\s\S]*with the cloud/);
   assert.match(await paneNotice(),/Codex[\s\S]*server 500/);
   await emitState([cloud]);await emitState([]);
   assert.equal(await chatNotice(),'','recovery drops the chat notice');
   assert.equal(await paneNotice(),'','recovery drops the pane notice');
  };
  const checkPermissionNotice=async lang=>{
    const zh=lang==='zh',directory='/Users/fixture/.qoder/skills';
    const failure={category:'skills',agents:['qoder'],detail:"EPERM: operation not permitted, open '/Users/fixture/.qoder/skills/.ading-candidate-fixture/agents/openai.yaml'",permission:{code:'EPERM',directory,path:directory+'/.ading-candidate-fixture/agents/openai.yaml',directoryWritable:true,platform:'darwin'}};
    for(const size of [[1220,820],[940,620]]){
      win.setSize(...size);await wait();await click('#tab-conversations');await emitState([]);await emitState([failure,failure]);
      const text=await chatNotice();assert.ok(text.includes(directory));
      assert.match(text,zh?/可写检查通过，但系统仍拒绝访问/:/passes the write-access check, but the system still denies access/);
      assert.match(text,zh?/Agent 从中央库自动补同步/:/Agent to sync from the central library automatically/);
      assert.equal(text.split(directory).length,2,'repeated candidate errors produce one actionable directory hint');
      assert.equal(await run(`document.querySelector('#knowledge-directory-access')`),null);
      if(process.env.ADING_KNOWLEDGE_QA_DIR&&size[0]===940){await mkdir(process.env.ADING_KNOWLEDGE_QA_DIR,{recursive:true});await writeFile(join(process.env.ADING_KNOWLEDGE_QA_DIR,zh?'权限提示.png':'e权限提示.png'),(await win.webContents.capturePage()).toPNG());}
    }
    await emitState([]);assert.equal(await chatNotice(),'');win.setSize(1220,820);await wait();
  };
  const checkFallbackNotice=async lang=>{
    const zh=lang==='zh';
    for(const status of ['waiting','running','repairing']) {
      await run(`window.adingTest.emit('onKnowledgeSyncState',${JSON.stringify({failures:[],pending:[{agents:['qoder'],status}]})})`);await wait();
      assert.equal(await chatNotice(),'','background sync does not interrupt the conversation');
      assert.equal(await paneNotice(),'','background sync does not show a progress notice');
    }
    const file='/Users/fixture/.qoder/skills/example/agents/openai.yaml';
    const failure={category:'skills',agents:['qoder'],detail:`EACCES: read denied (${file})`,sync:{stage:'verification',code:'EACCES',path:file},permission:{code:'EACCES',path:file,directory:'/Users/fixture/.qoder/skills',directoryWritable:true,platform:'darwin'}};
    await emitState([failure]);
    assert.match(await chatNotice(),zh?/阿钉无法读取补同步后的文件进行核验/:/ADing cannot read the synced file for verification/);
    assert.match(await chatNotice(),/openai.yaml/);assert.match(await chatNotice(),/EACCES/);
    assert.doesNotMatch(await chatNotice(),zh?/会通知该 Agent/:/will ask this Agent/,'final failure does not promise that the completed fallback is still queued');
    if(process.env.ADING_KNOWLEDGE_QA_DIR)await writeFile(join(process.env.ADING_KNOWLEDGE_QA_DIR,zh?'补同步核验失败.png':'e补同步核验失败.png'),(await win.webContents.capturePage()).toPNG());
    await emitState([]);assert.equal(await chatNotice(),'');assert.equal(await paneNotice(),'');
  };
  const checkSyncNotice=async(lang)=>{
   const zh=lang==='zh';
   const failures=[
    {category:'skills',agents:['claude-code'],detail:"EACCES: permission denied, open '/Users/fixture/.claude/skills/review/"+'x'.repeat(260)+"'"},
    {category:'memories',agents:['codex','qoder'],detail:'ENOSPC: no space left on device'},
    {category:'removal',agents:['qoder-cn'],detail:'fixture withdrawal failure'}
   ];
   for(const [width,height] of [[1220,820],[940,620]]) {
    win.setSize(width,height);await wait();
    await click('#tab-conversations');
    await emitState([]);
    await emitState(failures);
    const chat=await chatNotice();
    assert.match(chat,zh?/知识同步失败：Claude Code 的技能；Codex、Qoder 的记忆；Qoder CN 的已删除工作区或会话的旧副本撤回没能同步/:/Knowledge sync failed: skills for Claude Code; memories for Codex, Qoder; withdrawal of old copies from deleted workspaces or conversations for Qoder CN couldn't be copied/);
    assert.equal(await run(`document.querySelector('#discovery-status').classList.contains('error')`),true);
    assert.equal(await run(`(()=>{const bar=document.querySelector('#discovery-status').getBoundingClientRect(),close=document.querySelector('#discovery-status-close').getBoundingClientRect();return close.width>0&&close.right<=bar.right+0.5&&bar.right<=window.innerWidth;})()`),true,'the notice and its close button stay inside the window');
    await click('#discovery-status-close');
    await emitState(failures);
    assert.equal(await chatNotice(),'','the same failure list does not reappear after the user closed it');
    await click('#tab-knowledge');
    const pane=await paneNotice();
    assert.match(pane,zh?/Claude Code · 技能：EACCES/:/Claude Code · skills: EACCES/);
    assert.match(pane,zh?/Codex、Qoder · 记忆：ENOSPC/:/Codex, Qoder · memories: ENOSPC/);
    assert.equal(await run(`(()=>{const notice=document.querySelector('#knowledge-sync-notice').getBoundingClientRect(),pane=document.querySelector('#knowledge-pane').getBoundingClientRect(),text=document.querySelector('#knowledge-sync-text');return notice.right<=pane.right+0.5&&notice.height<=260&&text.scrollWidth<=text.clientWidth+1;})()`),true,'long details wrap and scroll inside the knowledge pane');
    await emitState([]);
    assert.equal(await paneNotice(),'','recovery drops the sync failure from the knowledge pane');
    await click('#tab-conversations');
    await emitState(failures);await emitState([]);
    assert.equal(await chatNotice(),'','recovery drops the chat notice');
   }
   win.setSize(1220,820);await wait();
  };
  await win.loadFile(join(__dirname,'../src/index.html'));await wait();await wait();
  assert.match(await chatNotice(),/知识同步失败：Codex 的记忆没能同步到 Agent 原生目录/,'a failure from before the window opened is shown at startup');
  await click('#tab-knowledge');
  assert.match(await paneNotice(),/Codex · 记忆：startup fixture failure/);
  await emitState([]);
  await scope('通用技能');
  for(const id of ['knowledge-create-skill','knowledge-import-zip','knowledge-import-directory'])assert.equal(await run(`document.getElementById('${id}').hidden`),false);
  await click('#knowledge-create-skill');await fill('UI skill');await fill('Use this fixture');await fill('# Rule\n\nBody');
  assert.equal(await run(`document.querySelector('#knowledge-body .k-name').textContent`),'UI skill');
  assert.equal((await run(`window.adingTest.knowledgeCalls()`))[0][1].scope,'global');
  await click('#knowledge-body .k-actions button');await fill('Edited skill');await fill('Updated use');await fill('# Updated body');
  assert.equal(await run(`document.querySelector('#knowledge-body .k-name').textContent`),'Edited skill');
  await click('#knowledge-import-zip');await click('#knowledge-import-directory');
  const imports=(await run(`window.adingTest.knowledgeCalls()`)).filter(call=>call[0]==='importSkill');assert.deepEqual(imports.map(call=>call[1].sourceKind),['zip','directory']);
  await scope('关于我');assert.equal(await run(`document.querySelector('#knowledge-import-zip').hidden`),true);
  await click('#knowledge-add');await fill('Original memory');
  await click('#knowledge-body .k-actions button');await fill('Edited memory');
  assert.equal(await run(`document.querySelector('#knowledge-body .k-body').textContent`),'Edited memory');
  assert.ok((await run(`window.adingTest.knowledgeCalls()`)).some(call=>call[0]==='updateMemory'&&call[2].content==='Edited memory'));
  await checkPermissionNotice('zh');
  await checkFallbackNotice('zh');
  await checkSyncNotice('zh');
  await checkCloudNotice('zh');
  await click('#tab-knowledge');await scope('通用技能');
  if(process.env.ADING_KNOWLEDGE_QA_DIR){await mkdir(process.env.ADING_KNOWLEDGE_QA_DIR,{recursive:true});await writeFile(join(process.env.ADING_KNOWLEDGE_QA_DIR,'knowledge-ui-zh.png'),(await win.webContents.capturePage()).toPNG());}
  await click('#knowledge-retry-sync');assert.ok((await run(`window.adingTest.knowledgeCalls()`)).some(call=>call[0]==='retryKnowledgeSync'));
  assert.match(await paneNotice(),/重试同步[\s\S]*Claude Code · 技能：EACCES/,'a failed retry says which Agent still failed');
  await click('#knowledge-sync-close');await click('#knowledge-retry-sync');
  assert.match(await paneNotice(),/Claude Code · 技能/,'retrying again with the same failure still answers');
  await run(`window.adingTest.setKnowledgeRetryReject(true)`);await click('#knowledge-retry-sync');
  assert.equal(await paneNotice(),'重试同步失败：store closed','a rejected retry shows the reason without IPC noise');
  assert.equal(await run(`document.querySelector('#knowledge-retry-sync').disabled`),false);
  await run(`window.adingTest.setKnowledgeRetryReject(false)`);
  await run(`window.adingTest.setKnowledgeRetryPending(true)`);await click('#knowledge-retry-sync');
  assert.equal(await paneNotice(),'正在后台同步');
  assert.equal(await run(`document.querySelector('#knowledge-sync-notice').classList.contains('error')`),false,'queued fallback is not an error');
  await run(`window.adingTest.setKnowledgeRetryPending(false)`);
  await run(`window.adingTest.setKnowledgeRetryResult(true)`);await click('#knowledge-retry-sync');
  assert.match(await run(`document.querySelector('#knowledge-sync-notice').textContent`),/已保存并同步/);
  await run(`window.adingTest.setKnowledgeWriteFailure(true)`);
  await click('#knowledge-create-skill');await fill('Failing save');await fill('fixture');await fill('body');
  assert.match(await run(`document.querySelector('#knowledge-sync-notice').textContent`),/central save failed/,'real central write failures stay visible');
  await run(`window.adingTest.setKnowledgeWriteFailure(false)`);

  await run(`localStorage.setItem('ading.language','en')`);const reloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.reload();await reloaded;await wait();
  await click('#tab-knowledge');await scope('General skills');
  assert.equal(await run(`document.querySelector('#knowledge-create-skill').textContent`),'Create skill');
  assert.equal(await run(`document.querySelector('#knowledge-import-directory').textContent`),'Import folder');
  await checkPermissionNotice('en');
  await checkFallbackNotice('en');
  await checkSyncNotice('en');
  await checkCloudNotice('en');
  await click('#tab-knowledge');await scope('General skills');
  await run(`window.adingTest.setKnowledgeRetryPending(true)`);await click('#knowledge-retry-sync');assert.equal(await paneNotice(),'Syncing in the background');
  await run(`window.adingTest.setKnowledgeRetryPending(false)`);await click('#knowledge-retry-sync');
  assert.match(await paneNotice(),/Retry sync:\nClaude Code · skills: EACCES/);
  if(process.env.ADING_KNOWLEDGE_QA_DIR)await writeFile(join(process.env.ADING_KNOWLEDGE_QA_DIR,'knowledge-ui-en.png'),(await win.webContents.capturePage()).toPNG());
  await click('#knowledge-create-skill');assert.equal(await run(`document.querySelector('.knowledge-editor-dialog h2').textContent`),'Skill name');
  await run(`document.querySelector('.knowledge-editor-dialog button[type=button]').click()`);await wait();
  assert.ok(!errors.some(error=>/prompt\(\)|TypeError|ReferenceError/.test(error)),errors.join('\n'));
  console.log('knowledge UI: central CRUD, per-Agent sync failure notices, retry feedback, actual save errors and bilingual controls passed');
 }finally{win?.destroy();await rm(dir,{recursive:true,force:true});}
})().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);});
