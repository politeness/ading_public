const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {writeFile}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-chat-scroll-'));
 app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});
 await win.loadFile(join(__dirname,'../src/index.html'));
 const run=s=>win.webContents.executeJavaScript(s).catch(e=>{console.error(s,errors);throw e;});
 const wait=()=>run('new Promise(r=>setTimeout(r,120))');await wait();
 const append=async(seq,conversation='test-paused')=>run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:${JSON.stringify(conversation)},message:{messageId:${JSON.stringify(conversation+'-history-'+seq)},conversationId:${JSON.stringify(conversation)},seq:${seq},senderId:'test-c',type:'USER',content:'历史消息 ${seq}：阅读这段内容时，新消息不能把视图拉到底部。\\n\\n这里是第二段内容，用于模拟真实会话中的长回复。',createdAt:'2026-09-05T13:00:00Z'}})`);
 const position=()=>run(`(()=>{const p=document.querySelector('#messages'),edge=p.getBoundingClientRect().top,a=[...p.children].find(c=>c.getBoundingClientRect().bottom>edge);return {top:p.scrollTop,bottom:p.scrollHeight-p.clientHeight-p.scrollTop,anchor:a?.dataset.scrollKey,offset:a?.getBoundingClientRect().top-edge}})()`);
 for(let i=2;i<=32;i++)await append(i);
 await wait();assert.ok((await position()).bottom<2,'bottom follows incoming messages');
 await run(`document.querySelector('#messages').scrollTop=800`);await wait();
 const reading=await position();assert.ok(reading.bottom>1000);
 await writeFile(join(output,'history-before.png'),(await win.webContents.capturePage()).toPNG());
 for(let i=33;i<=37;i++)await append(i);
 await wait();const after=await position();
 assert.equal(await run(`document.querySelector('#latest-jump').hidden`),false,'arrivals while reading keep latest button available');
 assert.equal(after.anchor,reading.anchor);assert.ok(Math.abs(after.offset-reading.offset)<2);assert.ok(Math.abs(after.top-reading.top)<2,'new messages retain history scroll');
 await writeFile(join(output,'history-after.png'),(await win.webContents.capturePage()).toPNG());
 await run(`window.adingTest.emit('onAgentBusy',{conversationId:'test-paused',agentUserId:'test-c',busy:true,revision:20});window.adingTest.emit('onAgentProgress',{conversationId:'test-paused',agentUserId:'test-c',text:'新进度',revision:21});window.adingTest.emit('onAgentBusy',{conversationId:'test-paused',agentUserId:'test-c',busy:false,revision:22})`);
 await wait();assert.ok(Math.abs((await position()).top-reading.top)<2,'busy/progress refresh retains position');
 await append(38,'test-direct');assert.ok(Math.abs((await position()).top-reading.top)<2,'other tasks do not affect reading');
 await run(`document.querySelector('[data-conversation-id="test-direct"] .conversation-list-button').click()`);await wait();
 await run(`document.querySelector('[data-conversation-id="test-paused"] .conversation-list-button').click()`);await wait();
 assert.equal((await position()).anchor,reading.anchor,'return to task restores visible message');
 assert.ok(Math.abs((await position()).offset-reading.offset)<2);
 await run(`document.querySelector('#latest-jump').click()`);await wait();
 assert.equal(await run(`document.querySelector('#latest-jump').hidden`),true,'latest button hides after jumping');
 await append(38);await wait();assert.ok((await position()).bottom<2,'scrolling back to bottom resumes following');
 await run(`document.querySelector('#messages').scrollTop=0`);await append(39);await wait();assert.ok((await position()).top<2,'top of history stays at top');
 // Directly exercise anchor restoration when older messages are inserted above the viewport.
 await run(`(async()=>{window.scrollModule=await import('../dist/ui/scroll-position.js');window.anchorPane=document.createElement('div');anchorPane.style.cssText='position:fixed;left:0;top:0;height:200px;width:300px;overflow:auto';document.body.append(anchorPane);for(let i=0;i<15;i++){const c=document.createElement('div');c.dataset.scrollKey='row'+i;c.style.height='80px';c.textContent='row'+i;anchorPane.append(c);}window.anchorState=new scrollModule.ScrollPosition(anchorPane);anchorState.beforeRender('test')();anchorPane.scrollTop=405;window.restoreAnchor=anchorState.beforeRender('test');const extra=document.createElement('div');extra.style.height='120px';anchorPane.prepend(extra);restoreAnchor();})()`);
 assert.equal(await run('anchorPane.scrollTop'),525,'insertions above keep the same message at the same visual offset');
 await run('anchorPane.remove()');
 await writeFile(join(output,'control-message-visibility.png'),(await win.webContents.capturePage()).toPNG());
 // Coordination metadata allows stripping only application wrappers, including older inline receipts.
 for (const [phase,content,body] of [
  ['accepted','小c 已同意方案，进入执行：\n同意，先检查原图。','同意，先检查原图。'],
  ['accepted','小c 已同意方案，开始执行：我会保存报告。','我会保存报告。'],
  ['revision','小c 提出分工问题，待 Leader 讨论：\n建议先确认输入路径。','建议先确认输入路径。'],
  ['revision','小c 提出分工异议：当前方案有缺陷。','当前方案有缺陷。'],
  ['proposal','请 小c 评估并确认工作 crop：逐题裁图，保留题干。','逐题裁图，保留题干。'],
  ['proposal','Leader 开始承担工作 crop：我来核查结果。','我来核查结果。']
 ]) {
  const id='receipt-'+Math.random();
  const m={messageId:id,conversationId:'test-paused',seq:60,senderId:'test-c',type:'TASK',content,coordination:{id:'assignment',assigneeId:'test-c',workId:'crop',phase,brief:'范围'},createdAt:'2026-09-05T13:00:00Z'};
  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-paused',message:${JSON.stringify(m)}})`);
  assert.equal(await run(`document.querySelector('[data-scroll-key="${id}"] .bubble').textContent`),body);
  assert.equal(await run(`document.querySelector('[data-conversation-id="test-paused"] .contact-meta').textContent`),'小c：'+body.slice(0,22));
 }
 const literal='小c 已同意方案，进入执行：这是一句真实正文。';
 await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-paused',message:{messageId:'literal-wrapper',conversationId:'test-paused',seq:61,senderId:'test-c',type:'USER',content:${JSON.stringify(literal)},createdAt:'2026-09-05T13:00:00Z'}})`);
 assert.equal(await run(`document.querySelector('[data-scroll-key="literal-wrapper"] .bubble').textContent`),literal,'plain speech is not stripped by prefix');
 assert.deepEqual(errors,[]);console.log(`chat-scroll: history, arrivals, runtime updates, task switching, bottom follow and prepend anchors passed. Screenshots: ${output}`);
 win.destroy();app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
