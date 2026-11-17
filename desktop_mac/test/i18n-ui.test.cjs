// Switch the UI to English: after a full reload both static and dynamic text become English, then switch back to Chinese.
const {mkdtemp}=require('./tmp.cjs');
const { app, BrowserWindow } = require('electron');
const {writeFile}=require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

// Content that is Chinese in the test data itself (names, conversation names, messages) does not count as missing translation
const DATA = ['测试用户', '小q-cn', '小cc', '小c', '小q', '产品设计讨论', '待继续的设计', '第二条单聊', '单聊', '我们可以先确定讨论目标，再逐步完善细节。', '中文'];
const leftovers = `(() => {
  const data = ${JSON.stringify(DATA)};
  const strip = (s) => data.reduce((acc, d) => acc.split(d).join(''), s || '');
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest('script,style,.message-body,.message-content')) continue;
    if (/[\\u4e00-\\u9fff]/.test(strip(n.textContent))) found.push((p.id || p.className || p.tagName) + ': ' + n.textContent.trim().slice(0, 60));
  }
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[data-tooltip],[alt]')) {
    for (const a of ['title', 'aria-label', 'placeholder', 'data-tooltip', 'alt']) {
      const v = el.getAttribute(a);
      if (v && /[\\u4e00-\\u9fff]/.test(strip(v))) found.push((el.id || el.tagName) + '@' + a + ': ' + v.slice(0, 60));
    }
  }
  return found;
})()`;

(async () => {
  const output = await mkdtemp(join(tmpdir(), 'ading-i18n-ui-test-'));
  app.setPath('userData', join(output, 'profile'));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1220, height: 820, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  await win.loadFile(join(__dirname, '../src/index.html'));
  const run = source => win.webContents.executeJavaScript(source).catch(error => { throw new Error(`run failed: ${source.slice(0, 120)} (${error.message})`); });
  const wait = (ms = 300) => run(`new Promise(r => setTimeout(r, ${ms}))`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const reloaded = () => new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await wait();
  assert.equal(await run(`document.documentElement.lang`), 'zh-CN', 'Chinese by default');
  assert.equal(await run(`document.querySelector('#tab-contacts').textContent.trim()`).then(Boolean), true);
  const zhTitle = await run(`document.title`);

  await click('#app-settings-entry'); await wait();
  await click('[data-settings-tab="language"]'); await wait();
  let loaded = reloaded();
  await click('input[name="app-language"][value="en"]');
  await loaded; await wait(600);
  assert.equal(await run(`localStorage.getItem('ading.language')`), 'en', 'Language choice is saved');
  assert.equal(await run(`document.documentElement.lang`), 'en');
  assert.equal(await run(`document.title`), 'ADing');
  assert.equal(await run(`document.querySelector('#app-settings-dialog').open`), true, 'Returns to the settings language page after reload');
  assert.equal(await run(`document.querySelector('input[name="app-language"]:checked').value`), 'en');
  await writeFile(join(output, 'en-settings.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(await run(leftovers), [], 'No untranslated text on the settings page');
  await click('[data-settings-tab="about"]'); await wait();
  assert.match(await run(`document.querySelector('#settings-about-version').textContent`), /^Version /);
  await run(`document.querySelector('#app-settings-dialog').close()`); await wait();

  // Main UI: conversation list, chat, contacts, support
  assert.deepEqual(await run(leftovers), [], 'No untranslated text on the conversation page');
  // The top bar "Explore Silicon Folks" is longer in English: shown fully on one line, not truncated, and not overlapping the update or account entries
  for (const [width, height] of [[1220, 820], [940, 620]]) {
    win.setSize(width, height); await wait();
    const entry = await run(`(() => {
      const button = document.querySelector('#agents-entry'), label = button.querySelector('[data-i18n="html.nav.explore"]');
      const box = button.getBoundingClientRect(), text = label.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || parseFloat(getComputedStyle(label).fontSize) * 1.5;
      const others = ['#app-settings-entry', '#update-entry', '.window-account'].map(s => document.querySelector(s)).filter(n => n && !n.hidden && n.getBoundingClientRect().width > 0);
      const overlaps = others.some(n => { const r = n.getBoundingClientRect(); return r.left < box.right - 0.5 && r.right > box.left + 0.5 && r.top < box.bottom && r.bottom > box.top; });
      return { text: label.textContent, aria: button.getAttribute('aria-label'), whole: label.scrollWidth <= label.clientWidth + 1 && text.right <= box.right + 0.5, oneLine: text.height <= lineHeight * 1.2, inside: box.left >= 0 && box.right <= window.innerWidth, overlaps };
    })()`);
    assert.deepEqual(entry, { text: 'Explore Silicon Folks', aria: 'Explore Silicon Folks', whole: true, oneLine: true, inside: true, overlaps: false }, `English "Explore Silicon Folks" entry shows fully at ${width}px width`);
  }
  win.setSize(1220, 820); await wait();
  await writeFile(join(output, 'en-tasks.png'), (await win.webContents.capturePage()).toPNG());
  await click('#tab-contacts'); await wait();
  assert.deepEqual(await run(leftovers), [], 'No untranslated text on the contacts page');
  await writeFile(join(output, 'en-contacts.png'), (await win.webContents.capturePage()).toPNG());
  await run(`window.adingTest.setFriendPermission(false)`); await wait();
  await run(`document.querySelector('#contact-list .sidebar-add-button').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))`); await wait();
  assert.equal(await run(`document.querySelector('#icon-tooltip').textContent`), 'Unavailable region');
  assert.equal(await run(`document.querySelector('#icon-tooltip').matches(':popover-open')`), true);
  assert.deepEqual(await run(leftovers), [], 'No untranslated text in the English region restriction notice');
  await run(`document.querySelector('#contact-list .sidebar-add-button').dispatchEvent(new PointerEvent('pointerout',{bubbles:true}));window.adingTest.setFriendPermission(true)`); await wait();
  await click('#contact-list .sidebar-add-button'); await wait();
  assert.equal(await run(`document.querySelector('#friend-dialog').open`), true, 'Whitelist is open under the English UI');
  await run(`document.querySelector('#friend-dialog').close();window.ading.accountLogout().then(s=>window.adingTest.emit('onAccountChanged',s))`); await wait();
  await click('#support-entry'); await wait();
  assert.deepEqual(await run(leftovers), [], 'No untranslated text on the support page');
  await writeFile(join(output, 'en-support.png'), (await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#support-dialog').close()`); await wait();
  await click('#tab-conversations'); await wait();
  await click('#new-group'); await wait();
  assert.deepEqual(await run(leftovers), [], 'No untranslated text in new conversation');
  await writeFile(join(output, 'en-new-conversation.png'), (await win.webContents.capturePage()).toPNG());
  await run(`document.querySelectorAll('dialog[open]').forEach(d => d.close())`); await wait();

  // English tooltips on icon-only controls are at most 40 characters (bubble max width 300px)
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('[title],[data-tooltip]')).map(n=>n.dataset.tooltip||n.title).filter(t=>t && t.length>40)`), [], 'English hover tooltips are at most 40 characters');

  // Switch back to Chinese
  await click('#app-settings-entry'); await wait();
  await click('[data-settings-tab="language"]'); await wait();
  loaded = reloaded();
  await click('input[name="app-language"][value="zh-CN"]');
  await loaded; await wait(600);
  assert.equal(await run(`document.documentElement.lang`), 'zh-CN');
  assert.equal(await run(`document.title`), zhTitle);
  assert.equal(await run(`document.querySelector('#app-settings-dialog').open`), true);
  assert.equal(await run(`localStorage.getItem('ading.language')`), 'zh-CN');
  assert.deepEqual(errors, []);
  console.log(`i18n ui ok: ${output}`);
  app.quit();
})().catch(error => { console.error(error); app.exit(1); });
