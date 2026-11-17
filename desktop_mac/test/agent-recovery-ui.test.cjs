const {app,BrowserWindow}=require('electron');
const {mkdtemp,rm}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
(async()=>{
 const root=await mkdtemp(join(tmpdir(),'ading-recovery-ui-'));
 let win;try {
 app.setPath('userData',join(root,'profile'));await app.whenReady();
 win=new BrowserWindow({show:false,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-recovery'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
 await win.loadFile(join(__dirname,'../src/index.html'));
 const run=async source=>{try{return await win.webContents.executeJavaScript(source);}catch(error){console.error({source,errors,rows:await win.webContents.executeJavaScript("document.querySelector('#agent-rows').innerHTML")});throw error;}};
 const wait=()=>run('new Promise(r=>setTimeout(r,100))');
 const until=async source=>{for(let n=0;n<50;n++){if(await run(source))return;await wait();}throw Error('Timed out: '+source);};
 const button=label=>`document.querySelector('.agent-row button[aria-label="${label}"]')`;
 const row=`Array.from(document.querySelectorAll('.agent-row')).find(row=>row.querySelector('.agent-user').textContent==='qoder')`;
 await wait();await run(`document.querySelector('#agents-entry').click()`);await wait();
 await until(`!document.querySelector('#agent-recheck').disabled`);
 assert.ok((await run(`${row}.textContent`)).includes('模型未同步'));
 assert.deepEqual(await run('window.adingTest.loginKinds()'),[],'automatic discovery does not open a sign-in page');
 await run(`${button('同步账号')}.click()`);await wait();
 assert.deepEqual(await run('window.adingTest.loginKinds()'),['qoder']);
 assert.ok((await run(`${row}.textContent`)).includes('登录中'));
 assert.ok(await run(`!!${button('取消登录')}`));
 await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'qoder',action:'login',text:'Starting browser login... https://qoder.cn/device/selectAccounts?challenge=secret-token'});`);
 assert.equal(await run(`${row}.textContent.includes('secret-token') || ${row}.textContent.includes('Starting browser')`),false,'raw login output and long links are absent');
 assert.equal(await run(`${row}.querySelector('.agent-login-progress')`),null,'no log panel');

 await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'qoder',action:'login',text:'Use code ABCD-1234 at https://qoder.com/device'});`);
 assert.match(await run(`${row}.querySelector('.agent-login-code').textContent`),/ABCD-1234/);
 assert.equal(await run(`document.querySelector('#app-toast').textContent.includes('ABCD-1234')`),false,'device code belongs to its agent row');
 const link=`${row}.querySelector('.agent-login-link')`;
 assert.equal(await run(`${link}.hidden`),false,'official sign-in page stays reachable');
 assert.equal(await run(`${row}.textContent.includes('https://')`),false,'the link is a button, not raw URL text');
 // The button text has no domain: the hover tooltip must still appear so you can see which site will open before clicking
 await run(`${link}.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))`);await wait();await wait();
 assert.equal(await run(`document.querySelector('#icon-tooltip').matches(':popover-open')`),true,'the sign-in button shows its tooltip although it has its own text');
 assert.equal(await run(`document.querySelector('#icon-tooltip').textContent`),'在浏览器打开 qoder.com');
 await run(`${link}.dispatchEvent(new PointerEvent('pointerout',{bubbles:true}))`);await wait();
 await run(`${link}.click()`);
 assert.deepEqual(await run('window.adingTest.openedLinks()'),['https://qoder.com/device']);
 await run(`document.querySelector('#agents-entry').click()`);await wait();
 await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'qoder',action:'login',text:'Use code EFGH-5678 at https://qoder.com/device'});`);
 await run(`document.querySelector('#agents-entry').click()`);await wait();
 assert.match(await run(`${row}.querySelector('.agent-login-code').textContent`),/EFGH-5678/,'progress survives closing the panel');
 await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'codex',action:'login',text:'foreign-code'});`);
 assert.equal(await run(`${row}.textContent.includes('foreign-code')`),false);
 await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'qoder',action:'login',text:'Go to https://qoder.com.evil.test/device or http://qoder.com/device'});`);
 await run(`${link}.click()`);
 assert.deepEqual(await run('window.adingTest.openedLinks()'),['https://qoder.com/device','https://qoder.com/device'],'untrusted or plain-http links never replace the official one');
 await run(`window.adingTest.finishLogin('ready')`);await wait();
 assert.equal(await run(`${row}.querySelector('.agent-login-code').hidden`),true,'successful verification clears the code');
 assert.equal(await run(`${link}.hidden`),true,'successful verification clears the sign-in link');
 assert.equal(await run(`${row}.classList.contains('ready')`),true);
 assert.equal(await run(`${button('同步账号')}===null`),true);
 await run(`window.adingTest.requireModelSync();document.querySelector('#agent-recheck').click()`);await wait();
 await run(`${button('同步账号')}.click()`);await run(`window.adingTest.finishLogin('still-missing')`);await wait();
 assert.equal(await run(`${row}.classList.contains('ready')`),false,'login success alone does not make the agent ready');
 assert.ok(await run(`!!${button('同步账号')}`));
 await run(`${button('同步账号')}.click()`);await wait();
 await run(`${button('取消登录')}.click()`);await wait();
 assert.equal(await run(`${row}.classList.contains('busy')`),false);
 assert.ok(await run(`!!${button('同步账号')}`),'cancel returns to the repair action');
 await run(`${button('同步账号')}.click()`);await wait();
 await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'qoder',action:'login',text:'Use code WXYZ-1234'});window.adingTest.finishLogin('throw')`);await wait();
 assert.equal(await run(`${row}.textContent.includes('WXYZ-1234')`),false,'failed login clears an expired code');
 assert.deepEqual(errors,[]);
 win.destroy();
 for(const lang of ['zh-CN','en']) {
  win=new BrowserWindow({show:false,width:1000,height:760,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-copilot-access'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(join(__dirname,'../src/index.html'));
  await run(`localStorage.setItem('ading.language',${JSON.stringify(lang)})`);
  await win.loadFile(join(__dirname,'../src/index.html'));
  await until(`document.querySelector('[data-agent-kind="copilot"]') !== null`);
  await run(`document.querySelector('#agents-entry').click()`);
  await until(`!document.querySelector('#agent-recheck').disabled`);
  const copilot=`document.querySelector('[data-agent-kind="copilot"]')`;
  const login=lang==='en'?'Sign in':'登录';
  assert.ok(await run(`!!${copilot}.querySelector('button[aria-label="${login}"]')`),'genuine authentication failure still offers sign-in');
  await run(`${copilot}.querySelector('button[aria-label="${login}"]').click()`);
  await run(`window.adingTest.finishLogin('access-denied')`);
  await until(`${copilot}.textContent.includes(${JSON.stringify(lang==='en'?'Access restricted':'访问受限')})`);
  assert.equal(await run(`${copilot}.classList.contains('ready')`),false,'successful OAuth alone does not mean the model is usable');
  assert.equal(await run(`!!${copilot}.querySelector('button[aria-label="${login}"]')`),false,'feature denial does not send the user back to login');
  assert.equal(await run(`${copilot}.textContent.includes(${JSON.stringify(lang==='en'?'Signed out':'未登录')})`),false);
  assert.deepEqual(await run('window.adingTest.loginKinds()'),['copilot']);
  const failure='Fable 5.2 requires credits. <img src=x onerror=alert(1)>';
  await run(`window.adingTest.setAgentFailure('copilot',${JSON.stringify(failure)})`);
  await until(`${copilot}.querySelector('.agent-failure-detail')?.textContent === ${JSON.stringify(failure)}`);
  assert.equal(await run(`${copilot}.querySelector('.agent-failure-detail img')`),null,'provider errors render as plain text');
  assert.equal(await run(`(()=>{const e=${copilot}.querySelector('.agent-failure-detail');return e.scrollWidth>e.clientWidth})()`),false,'full failure wraps within the row');
  assert.equal(await run(`(()=>{const e=${copilot}.querySelector('.agent-failure-detail');return e.getBoundingClientRect().bottom<=${copilot}.getBoundingClientRect().bottom})()`),true,'failure stays inside its expanded row');
  if(process.env.ADING_UI_CAPTURE_DIR) {
   for(let n=0;n<12;n++){await run(`document.querySelector('#onboarding-card:popover-open button')?.click()`);await wait();}
   await wait();await wait();
   await require('node:fs/promises').writeFile(join(process.env.ADING_UI_CAPTURE_DIR,`agent-failure-${lang}.png`),(await win.webContents.capturePage()).toPNG());
  }
  await run(`window.adingTest.setAgentFailure('copilot','')`);
  await until(`${copilot}.querySelector('.agent-failure-detail') === null`);
  assert.equal(await run(`(()=>{const e=${copilot}.querySelector('.agent-signal');return e.scrollWidth>e.clientWidth})()`),false,'localized status fits');
  win.destroy();
 }
 } finally {win?.destroy();await rm(root,{recursive:true,force:true});}
 console.log('agent-recovery-ui: mismatch label, explicit sync, login progress, verified ready, unresolved model and cancellation passed');app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
