const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-agent-model-ui-'));app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs')}});
 try {
  await win.loadFile(join(__dirname,'../src/index.html'));
  const run=s=>win.webContents.executeJavaScript(s);
  const wait=()=>run('new Promise(r=>setTimeout(r,200))');
  await wait();
  const field=()=>run(`document.querySelector('#contact-agent-model-field').hidden`);
  const options=()=>run(`Array.from(document.querySelector('#contact-detail-model').options).map(o=>[o.value,o.textContent])`);
  const open=async()=>{
   await run(`document.querySelector('#contact-detail-dialog').open&&document.querySelector('#contact-detail-dialog').close()`);await wait();
   await run(`document.querySelector('.contact-list-item[data-user-id="test-c"] .avatar').click()`);await wait();
  };
  await run(`document.querySelector('#tab-contacts').click()`);await wait();
  await open();
  assert.equal(await field(),true,'Agents without a model list show no entry');
  await run(`window.adingTest.setModelCatalog({supported:true,selected:'gone',nativeModel:'a',models:[{id:'a',label:'Model A',description:'说明'},{id:'b',label:'Model B'}]})`);
  await open();
  if(process.env.ADING_TEST_SCREENSHOT)require('node:fs').writeFileSync(process.env.ADING_TEST_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
  assert.equal(await field(),false);
  assert.deepEqual(await options(),[['','默认（当前 Model A）'],['a','Model A'],['b','Model B'],['gone','gone（不在当前列表）']]);
  assert.equal(await run(`document.querySelector('#contact-detail-model').value`),'gone');
  assert.equal(await run(`document.querySelector('#contact-detail-model').disabled`),false);
  assert.equal(await run(`document.querySelector('#contact-detail-model-hint').textContent`),'','no extra hint');
  await run(`document.querySelector('#contact-detail-model').value='b';document.querySelector('#contact-detail-save').click()`);await wait();
  assert.deepEqual(await run(`window.adingTest.modelCalls()`),[['test-c','b']]);
  // No call when nothing changed; reverting to follow passes null
  await run(`window.adingTest.setModelCatalog({supported:true,selected:'b',models:[{id:'b',label:'Model B'}]})`);
  await open();
  assert.deepEqual(await options(),[['','默认'],['b','Model B']]);
  await run(`document.querySelector('#contact-detail-save').click()`);await wait();
  assert.deepEqual(await run(`window.adingTest.modelCalls()`),[]);
  await open();
  await run(`document.querySelector('#contact-detail-model').value='';document.querySelector('#contact-detail-save').click()`);await wait();
  assert.deepEqual(await run(`window.adingTest.modelCalls()`),[['test-c',null]]);
  // List can't be read: the entry stays but can't be changed, and the reason is shown
  await run(`window.adingTest.setModelCatalog({supported:true,selected:'b',models:[],error:'未登录'})`);
  await open();
  assert.equal(await run(`document.querySelector('#contact-detail-model').disabled`),true);
  assert.ok(await run(`document.querySelector('#contact-detail-model-hint').textContent.includes('未登录')`));
  // Agent on another computer that is online: the list can be viewed and changed via the same setAgentModel
  const computer={computerId:'d_other',computerName:'M5',readiness:'ready'};
  await run(`window.adingTest.setContactRemote('test-c',${JSON.stringify({...computer,online:true,model:{selected:'b',selectedLabel:'Model B'}})})`);await wait();
  await run(`window.adingTest.setModelCatalog({supported:true,selected:'b',models:[{id:'a',label:'Model A'},{id:'b',label:'Model B'}]})`);
  await open();
  assert.equal(await field(),false,'Agent on an online computer has an entry');
  assert.equal(await run(`document.querySelector('#contact-detail-model').disabled`),false);
  await run(`document.querySelector('#contact-detail-model').value='a';document.querySelector('#contact-detail-save').click()`);await wait();
  assert.deepEqual(await run(`window.adingTest.modelCalls()`),[['test-c','a']]);
  // That computer is offline: show the current value, no changes, no extra explanation, tooltip on hover
  await run(`window.adingTest.setContactRemote('test-c',${JSON.stringify({...computer,online:false,model:{selected:'b',selectedLabel:'Model B',nativeModel:'Model A'}})})`);await wait();
  await run(`window.adingTest.setModelCatalog({supported:true,models:[],readOnly:true,selected:'b',selectedLabel:'Model B',nativeModel:'Model A'})`);
  await open();
  assert.equal(await field(),false);
  assert.deepEqual(await options(),[['','默认（当前 Model A）'],['b','Model B']]);
  assert.equal(await run(`document.querySelector('#contact-detail-model').value`),'b');
  assert.equal(await run(`document.querySelector('#contact-detail-model').disabled`),true);
  assert.equal(await run(`document.querySelector('#contact-detail-model-hint').textContent`),'');
  assert.equal(await run(`document.querySelector('#contact-detail-model').title`),'所在电脑离线');
  await run(`document.querySelector('#contact-detail-save').click()`);await wait();
  assert.deepEqual(await run(`window.adingTest.modelCalls()`),[]);
  // Agents on old clients and borrowed Agents have no model state: no entry shown
  await run(`window.adingTest.setContactRemote('test-c',${JSON.stringify({...computer,online:true})})`);await wait();
  await open();
  assert.equal(await field(),true);
  await run(`window.adingTest.setContactRemote('test-c',null)`);await wait();
  console.log('agent-model ui: entry visibility, options, saving, follow, list failure, remote computers passed');
 } finally {win.destroy();}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
