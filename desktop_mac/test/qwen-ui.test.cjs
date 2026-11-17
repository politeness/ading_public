const {app,BrowserWindow}=require('electron');
const {mkdtemp,rm,readFile,writeFile}=require('node:fs/promises');
const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
(async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'ading-qwen-ui-'));let win;
 try {
  app.setPath('userData',path.join(root,'profile'));await app.whenReady();
  const fixture=(await readFile(path.join(__dirname,'ui-preload.cjs'),'utf8'))
   .replace('const catalog = contacts.map',"for(const [kind,name] of [['qwen-code','小qw'],['kiro','小k'],['copilot','小cp'],['antigravity','小a']])contacts.push({userId:'test-'+kind,displayName:name,isAgent:true,kind,enabled:true});\nconst catalog = contacts.map")
   .replace('const recovery=',"for(const [kind,label] of [['qwen-code','Qwen Code'],['kiro','Kiro'],['copilot','GitHub Copilot'],['antigravity','Antigravity']])Object.assign(catalog.find(a=>a.kind===kind),{label,version:'fixture',readiness:'unauthorized',loginHint:'Sign in',docsUrl:'https://example.invalid'});\nconst recovery=")
   .replace("loginKinds.push(kind);", "loginKinds.push(kind); if(kind==='antigravity')return {kind,action:'login',ok:false,requiresUserAction:true,unsupported:true,message:localStorage.getItem('ading.language')==='en'?'Run agy in Terminal to sign in, then return to ADing and click Check.':'请在终端运行 agy 完成登录，再回到阿钉点击检测。'}; if(kind==='qwen-code')return {kind,action:'login',ok:false,requiresUserAction:true,awaitingUserAction:true,message:localStorage.getItem('ading.language')==='en'?'Qwen Code Desktop is open. Configure a provider, then return and click Check.':'已打开 Qwen Code Desktop，请配置模型服务后返回检测。'};");
  const preload=path.join(root,'preload.cjs');await writeFile(preload,fixture);
  win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message)});
  await win.loadFile(path.join(__dirname,'../src/index.html'));
  const run=s=>win.webContents.executeJavaScript(s);
  const until=async s=>{for(let n=0;n<50;n++){if(await run(s))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out '+s)};
  const row="Array.from(document.querySelectorAll('.agent-row')).find(r=>r.querySelector('.agent-user')?.textContent === 'qwen-code')";
  for(const lang of ['zh-CN','en']){
   if(lang==='en'){await run("localStorage.setItem('ading.language','en')");await win.reload();await new Promise(r=>win.webContents.once('did-finish-load',r));}
   await until(`${row} !== undefined`);
   await new Promise(r=>setTimeout(r,150));
   if(!await run("document.querySelector('#agents-entry').classList.contains('active')"))await run("document.querySelector('#agents-entry').click()");
   await until("document.querySelector('#agents-entry').classList.contains('active')");
   await until(`${row} !== undefined && ${row}.checkVisibility({opacityProperty:true,visibilityProperty:true})`);
   await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   for(const [kind,zh,en] of [['qwen-code','小qw','Gwen'],['kiro','小k','Kira'],['copilot','小cp','Cooper'],['antigravity','小a','Ava']]){
    const item=row.replace('qwen-code',kind);assert.match(await run(`${item}.textContent`),lang==='en'?/Signed out/i:/未登录/);assert.ok((await run(`${item}.textContent`)).includes(lang==='en'?en:zh));
    assert.equal(await run(`${item}.querySelector('img').complete && ${item}.querySelector('img').naturalWidth > 0`),true);
   }
   assert.match(await run(`${row}.textContent`),lang==='en'?/Signed out/i:/未登录/);
   assert.equal(await run(`${row}.querySelector('img').complete && ${row}.querySelector('img').naturalWidth > 0`),true);
   await run(`${row.replace('qwen-code','antigravity')}.scrollIntoView({block:'nearest'})`);
   await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   if(process.env.QWEN_UI_SCREENSHOTS)await writeFile(path.join(process.env.QWEN_UI_SCREENSHOTS,`qwen-ui-${lang}.png`),(await win.webContents.capturePage()).toPNG());
   await run(`${row}.querySelector('.agent-right .pri').click()`);
   await until("document.querySelector('#app-toast').textContent.includes('Qwen Code Desktop')");
   assert.equal(await run("document.querySelector('#app-toast').classList.contains('error')"),false,'native app setup is a handoff, not a failed login');
   assert.match(await run(`${row}.textContent`),lang==='en'?/Signed out/i:/未登录/,'opening the app does not claim successful authentication');
   await run(`${row.replace('qwen-code','antigravity')}.querySelector('.agent-right .pri').click()`);
   await until("document.querySelector('#app-toast').textContent.includes('agy')");
   assert.equal(await run("document.querySelector('#app-toast').classList.contains('error')"),false,'terminal sign-in guidance is not a failure');
   const copilot=row.replace('qwen-code','copilot');
   await run(`${copilot}.querySelector('.agent-right .pri').click()`);
   await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'copilot',action:'login',text:${JSON.stringify(lang==='en'?'Enter code ABCD-1234 at https://github.com/login/device':'请在 https://github.com/login/device 输入设备码 ABCD-1234')}})`);
   await until(`${copilot}.querySelector('.agent-login-code').textContent.includes('ABCD-1234')`);
   await run(`${copilot}.scrollIntoView({block:'center'})`);
   await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   assert.equal(await run(`${copilot}.querySelector('.agent-login-link').hidden`),false,'device page stays reachable next to the code');
   assert.equal(await run(`${copilot}.scrollWidth <= ${copilot}.clientWidth + 1`),true,'login guidance must fit the card');
   if(process.env.QWEN_UI_SCREENSHOTS)await writeFile(path.join(process.env.QWEN_UI_SCREENSHOTS,`agent-login-${lang}.png`),(await win.webContents.capturePage()).toPNG());
   await run(`window.adingTest.finishLogin('cancelled')`);
   await until(`!${copilot}.textContent.includes('ABCD-1234')`);
   // Kiro's device flow prints only the verification URL; it must stay usable.
   const kiro=row.replace('qwen-code','kiro');
   await run(`${kiro}.querySelector('.agent-right .pri').click()`);
   await run(`window.adingTest.emit('onAgentLifecycleProgress',{kind:'kiro',action:'login',text:'Open this URL: https://view.awsapps.com/start/#/device?user_code=WXYZ-ABCD'})`);
   await until(`!${kiro}.querySelector('.agent-login-link').hidden`);
   assert.equal(await run(`${kiro}.scrollWidth <= ${kiro}.clientWidth + 1`),true,'sign-in link must fit the card');
   await run(`window.adingTest.finishLogin('cancelled')`);
   await until(`${kiro}.querySelector('.agent-login-link').hidden`);

  }
  assert.deepEqual(errors,[]);console.log('agent-catalog-ui: Qwen, Kiro, Copilot and Antigravity names/icons/auth states passed in Chinese and English');
 }finally{win?.destroy();await rm(root,{recursive:true,force:true});}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1)});
