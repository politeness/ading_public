const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {writeFile,readFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
(async()=>{
  const root=await mkdtemp(join(tmpdir(),'ading-message-links-'));
  app.setPath('userData',join(root,'profile')); await app.whenReady();
  const previewImage=process.env.ADING_TEST_LINK_IMAGE ? JSON.parse(await readFile(process.env.ADING_TEST_LINK_IMAGE,'utf8')).image : '';
  const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-links',...(previewImage ? ['--ading-preview-image='+previewImage] : [])],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const run=source=>win.webContents.executeJavaScript(source);
  const wait=()=>run('new Promise(resolve=>setTimeout(resolve,250))');
  try {
    for (const language of ['zh-CN','en']) {
      await win.loadFile(join(__dirname,'../src/index.html')); await wait();
      if(language==='en'){await run("localStorage.setItem('ading.language','en')");await win.loadFile(join(__dirname,'../src/index.html'));await wait();}
      await run(`document.querySelector('[data-conversation-id="test-group"] .conversation-list-button').click()`);await wait();
      assert.equal(await run(`document.querySelector('[data-scroll-key="links-agent"] a').textContent`),'Example skill');
      await run(`document.querySelector('[data-scroll-key="links-agent"] a').click()`);await wait();
      assert.equal((await run('window.adingTest.revealedArtifacts()')).at(-1),'/Users/example/Library/Application Support/ADing/SKILL.md','angle destinations with spaces retain the exact local path');
      assert.equal(await run(`document.querySelectorAll('[data-scroll-key="links-agent"] a').length`),3,'unsafe schemes and code are not linkified');
      await run(`document.querySelectorAll('[data-scroll-key="links-agent"] a')[1].click()`);await wait();
      assert.deepEqual((await run('window.adingTest.revealedArtifacts()')).at(-1),{target:'review-report.txt',conversationId:'test-group'});
      await run(`document.querySelectorAll('[data-scroll-key="links-agent"] a')[2].click()`);await wait();
      assert.deepEqual((await run('window.adingTest.revealedArtifacts()')).at(-1),{target:'./reports/check report.txt',conversationId:'test-group'});
      assert.equal(await run(`document.querySelectorAll('[data-scroll-key="links-user"] .link-preview').length`),2,'duplicate bare URLs produce one card');
      assert.equal(await run(`document.querySelector('.link-preview strong').textContent`),'网页标题 / Web title');
      assert.equal(await run(`document.querySelector('.link-preview-description').textContent`),'网页摘要 / Web summary <script>never execute</script>');
      assert.equal(await run(`document.querySelector('.link-preview script')`),null,'metadata is rendered as text');
      assert.equal(await run(`document.querySelectorAll('[data-scroll-key="links-user"] a:not(.link-preview)').length`),3,'human messages get clickable bare URLs');
      assert.equal(await run(`Array.from(document.querySelectorAll('[data-scroll-key="links-user"] .link-preview')).at(-1).querySelector('strong').textContent`),'unavailable.example','fetch failure keeps a working fallback card');
      assert.equal(await run(`Array.from(document.querySelectorAll('[data-scroll-key="links-user"] .link-preview')).at(-1).querySelector('.link-preview-site').textContent`),'https://unavailable.example/page','without any page metadata keep the URL, matching iOS');
      await run(`document.querySelector('.link-preview').click()`);await wait();
      assert.equal((await run('window.adingTest.openedLinks()')).at(-1),'https://mp.weixin.qq.com/s/example');
      const geometry=await run(`(()=>{const c=document.querySelector('.link-preview'),r=c.getBoundingClientRect(),s=getComputedStyle(c);return {fits:r.width<=c.parentElement.getBoundingClientRect().width,color:s.color,background:s.backgroundColor}})()`);
      assert.equal(geometry.fits,true);assert.notEqual(geometry.color,geometry.background);
      const card=await run(`(()=>{const c=document.querySelector('[data-scroll-key="links-private"] .link-preview'),img=c.querySelector('img'),r=c.getBoundingClientRect();return {title:c.querySelector('strong').textContent,site:c.querySelector('.link-preview-site').textContent,hasImage:!img.hidden&&img.naturalWidth>0,width:r.width,radius:getComputedStyle(c).borderRadius,imageWidth:img.getBoundingClientRect().width}})()`);
      assert.deepEqual(card,{title:'语雀',site:'www.yuque.com',hasImage:true,width:280,radius:'12px',imageWidth:60});
      await run(`document.querySelector('[data-scroll-key="links-private"]').scrollIntoView({block:'center'})`);await wait();
      if(process.env.ADING_TEST_SCREENSHOT)await writeFile(process.env.ADING_TEST_SCREENSHOT.replace('.png','-'+language+'.png'),(await win.webContents.capturePage()).toPNG());
      if(process.env.ADING_TEST_SCREENSHOT){const r=await run(`(()=>{const r=document.querySelector('[data-scroll-key="links-private"] .link-preview').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);await writeFile(process.env.ADING_TEST_SCREENSHOT.replace('.png','-card-'+language+'.png'),(await win.webContents.capturePage(r)).toPNG());}

      await run(`document.querySelectorAll('.link-preview').forEach(c=>{c.style.setProperty('--surface-soft','#000');c.style.setProperty('--text','#fff');c.style.setProperty('--muted','#999')})`);
      assert.equal(await run(`getComputedStyle(document.querySelector('.link-preview')).color`),'rgb(255, 255, 255)');
      if(process.env.ADING_TEST_SCREENSHOT)await writeFile(process.env.ADING_TEST_SCREENSHOT.replace('.png','-'+language+'-dark.png'),(await win.webContents.capturePage()).toPNG());

    }
    if(process.env.ADING_TEST_SCREENSHOT)await writeFile(process.env.ADING_TEST_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    console.log('message links UI: local paths, bare URLs, previews, fallback, safe text, clicks and both languages passed');
  } finally {win.destroy();}
  app.exit(0);
})().catch(error=>{console.error(error);app.exit(1)});
