const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
app.on('window-all-closed',()=>{});
(async()=>{
  const root=await mkdtemp(join(tmpdir(),'ading-math-ui-'));app.setPath('userData',join(root,'profile'));await app.whenReady();
  const windows=[];const remote=[];
  const win=new BrowserWindow({show:false,width:1050,height:900,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-math'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});windows.push(win);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>{remote.push(details.url);done({cancel:true});});
  const run=code=>win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(join(__dirname,'../src/index.html'));await run('document.fonts.ready');
    // Wait for the actual chat loader, without relying on a machine-specific startup delay.
    for(let i=0;i<40&&!await run(`!!document.querySelector('[data-scroll-key="math-agent"] .katex')`);i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(await run(`document.querySelectorAll('[data-scroll-key="math-agent"] .katex').length`),2);
    assert.equal(await run(`document.querySelectorAll('[data-scroll-key="math-user"] .katex').length`),2,'human and Agent equations both render');
    assert.equal(await run(`document.querySelectorAll('[data-scroll-key="math-code"] .katex').length`),0,'code and malformed formulas remain literal');
    assert.equal(await run(`document.querySelectorAll('.bubble img').length`),0,'message HTML is text');
    assert.equal(await run(`!!document.querySelector('.katex .mtable')`),true,'reported aligned derivation is typeset');
    assert.equal(await run(`document.querySelector('.math-fallback').textContent`),String.raw`\[\notARealCommand{x}\]`);
    const screenshot=process.env.ADING_MATH_SCREENSHOT;
    if(screenshot)await writeFile(screenshot+'-desktop.png',(await win.webContents.capturePage()).toPNG());
    const phone=new BrowserWindow({show:false,width:360,height:640,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});windows.push(phone);
    await phone.loadFile(join(__dirname,'../src/assets/math/math.html'));
    const fixture=String.raw`正确写法：
\[
\begin{aligned}3^{n+2}-2^{n+2}+3^n-2^n&=10\cdot3^n-5\cdot2^n\\&=10(3^n-2^{n-1}).\end{aligned}
\]
因为 **\(n\)** 是正整数。`;
    for(const dark of [false,true]) {
      await phone.webContents.executeJavaScript(`window.updateMessage(${JSON.stringify(fixture)},[],{foreground:${JSON.stringify(dark?'#ffffff':'#101010')},link:'#007aff',mentionSelf:'#ff0000',size:17,language:'zh'},1);document.body.style.padding='12px';document.body.style.background=${JSON.stringify(dark?'#202020':'#ffffff')};document.fonts.ready`);
      const result=await phone.webContents.executeJavaScript(`({count:document.querySelectorAll('.katex').length,bold:!!document.querySelector('strong .katex'),fits:document.documentElement.scrollWidth<=window.innerWidth,fonts:document.fonts.check('17px KaTeX_Main')})`);
      assert.equal(result.count,2);assert.equal(result.bold,true);assert.equal(result.fits,true);assert.equal(result.fonts,true);
      if(screenshot)await writeFile(screenshot+(dark?'-phone-dark.png':'-phone-light.png'),(await phone.webContents.capturePage()).toPNG());
    }
    await phone.webContents.executeJavaScript(`window.updateMessage(${JSON.stringify('<img src=x onerror="window.mathXss=true"> '+String.raw`\(\htmlClass{unsafe}{x}\)`+' `$z$`')},[],{foreground:'#000',link:'#00f',mentionSelf:'#f00',size:17,language:'en'},2)`);
    assert.equal(await phone.webContents.executeJavaScript(`!window.mathXss&&!document.querySelector('img,.unsafe')&&document.querySelector('code').textContent==='$z$'`),true);
    await phone.webContents.executeJavaScript(`window.updateMessage(${JSON.stringify('*italic* **$x$** '+String.raw`\(\def\a{\a}\a\)`)},[],{foreground:'#000',link:'#00f',mentionSelf:'#f00',size:17,language:'en'},3)`);
    assert.equal(await phone.webContents.executeJavaScript(`document.querySelector('em').textContent==='italic'&&!!document.querySelector('strong .katex')&&!!document.querySelector('.math-fallback')`),true,'emphasis is preserved and recursive macros fall back without hanging');
    assert.deepEqual(remote,[],'all formulas and fonts load offline');
    console.log('message math UI: actual chat, reported aligned formula, human/Agent inline/display, code, invalid fallback, offline fonts, phone-width light/dark, bold math and HTML safety passed');
  }finally {for(const window of windows)window.destroy();}
  app.exit(0);
})().catch(error=>{console.error(error);app.exit(1)});
