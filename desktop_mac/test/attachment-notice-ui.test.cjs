const { mkdtemp } = require('./tmp.cjs');
const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'ading-attachment-notice-'));
  app.setPath('userData', join(root, 'profile'));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1220, height: 820, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const run = source => win.webContents.executeJavaScript(source);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const visible = () => run(`!document.querySelector('#discovery-status').hidden`);
  async function selectBatch() {
    await run(`(() => { if(document.querySelectorAll('#composer-attachments .composer-attachment').length===9) document.querySelector('.composer-attachment-remove').click(); })()`);
    await run(`window.adingTest.setAttachmentPickCount(12)`);
    await click('#attach-button');
    await wait(100);
  }
  await win.loadFile(join(__dirname, '../src/index.html'));
  await wait(300);
  await click('[data-conversation-id="test-direct"] .conversation-list-button');
  await wait(100);
  await selectBatch();
  assert.equal(await visible(), true);
  assert.equal(await run(`document.querySelector('#discovery-status-text').textContent`), '一条消息最多带 9 个附件');
  assert.equal(await run(`document.querySelectorAll('#composer-attachments .composer-attachment').length`), 9);
  const layout = await run(`(() => { const n=document.querySelector('#discovery-status-close'), r=n.getBoundingClientRect(), b=document.querySelector('#discovery-status').getBoundingClientRect(); return {label:n.getAttribute('aria-label'),tip:n.dataset.tooltip,icon:n.querySelector('svg').dataset.icon,visible:!n.hidden,inside:r.width>0 && r.left>=b.left && r.right<=b.right && r.bottom<=b.bottom}; })()`);
  assert.deepEqual(layout, { label: '关闭', tip: '关闭', icon: 'close', visible: true, inside: true });
  await click('#discovery-status-close');
  assert.equal(await visible(), false, 'the close button dismisses the warning');
  assert.equal(await run(`document.querySelectorAll('#composer-attachments .composer-attachment').length`), 9, 'dismissing a notice keeps the selected attachments');

  await selectBatch();
  await wait(9000);
  assert.equal(await visible(), true, 'the warning remains readable before ten seconds');
  await selectBatch();
  await wait(1500);
  assert.equal(await visible(), true, 'an old timer cannot dismiss a newer warning');
  await wait(8700);
  assert.equal(await visible(), false, 'the new warning automatically dismisses after ten seconds');

  await run(`localStorage.setItem('ading.language','en')`);
  await win.loadFile(join(__dirname, '../src/index.html'));
  await wait(300);
  await selectBatch();
  assert.equal(await run(`document.querySelector('#discovery-status-text').textContent`), 'A message can have at most 9 attachments');
  assert.equal(await run(`document.querySelector('#discovery-status-close').getAttribute('aria-label')`), 'Close');
  assert.equal(await run(`document.querySelector('#discovery-status-close').dataset.tooltip`), 'Close');
  await click('#discovery-status-close');
  assert.equal(await visible(), false);
  // Multiple attachment issues shown together: English uses "; " as the separator and must not contain the Chinese semicolon
  await run(`window.adingTest.setAttachmentRejected([{ name: 'huge.mov', reason: 'File is larger than 100 MB' }])`);
  await selectBatch();
  const combined = await run(`document.querySelector('#discovery-status-text').textContent`);
  assert.equal(combined, 'huge.mov: File is larger than 100 MB; A message can have at most 9 attachments');
  assert.equal(combined.includes('；'), false, 'English attachment notices never use the Chinese semicolon');
  await click('#discovery-status-close');
  await run(`localStorage.setItem('ading.language','zh-CN')`);
  await win.loadFile(join(__dirname, '../src/index.html'));
  await wait(300);
  await run(`window.adingTest.setAttachmentRejected([{ name: 'huge.mov', reason: 'File is larger than 100 MB' }])`);
  await selectBatch();
  assert.equal(await run(`document.querySelector('#discovery-status-text').textContent`), 'huge.mov：File is larger than 100 MB；一条消息最多带 9 个附件', 'Chinese keeps the Chinese separator');
  await run(`window.adingTest.setAttachmentRejected([])`);
  win.destroy();
  console.log('attachment-notice UI: close, ten-second timeout, timer replacement, retained attachments and English passed');
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
