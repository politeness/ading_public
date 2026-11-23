const {mkdtemp}=require('./tmp.cjs');
const { app, BrowserWindow } = require('electron');
const {writeFile}=require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const output = await mkdtemp(join(tmpdir(), 'ading-ui-test-'));
  app.setPath('userData', join(output, 'profile'));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1220, height: 820, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  await win.loadFile(join(__dirname, '../src/index.html'));
  const run = source => win.webContents.executeJavaScript(source).catch(error => { throw new Error(`run failed: ${source.slice(0, 160)} (${error.message})`); });
  const wait = () => run('new Promise(r => setTimeout(r, 300))');
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await wait();
  assert.deepEqual(await run(`window.adingTest.verifiedKinds()`),[],'no Agent connectivity check before the first screen finishes');
  assert.equal(await run(`document.querySelectorAll('svg:not([data-icon]):not([data-illustration=onboarding-pointer])').length`), 0, 'all UI SVGs use the shared semantic icons');
  assert.equal(await run(`Array.from(document.querySelectorAll('svg[data-icon]')).every(s=>s.getAttribute('stroke-width')==='1.8' && s.childElementCount>0)`), true);
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('button')).filter(b=>b.querySelector('svg,.ading-agent-symbol') && !b.title && !b.dataset.tooltip && !b.getAttribute('aria-label')).map(b=>b.id || b.outerHTML.slice(0,180))`), [], 'every icon button has a hover tooltip source');
  // Tooltips are at most 300px wide; anything longer gets truncated, which is as good as saying nothing. Long content belongs on the details page.
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('[title],[data-tooltip]')).map(n=>n.dataset.tooltip||n.title).filter(t=>t && t.length>24)`), [], 'hover tooltips are at most 24 characters');
  // A control that already shows its own text should not pop a tooltip too. The shared tooltip layer suppresses it automatically by innerText,
  // but title is the source of the browser's native tooltip, so controls with their own text must use aria-label instead.
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('[title]')).filter(n=>n.innerText.trim()).map(n=>n.id||n.innerText.trim().slice(0,20))`), [], 'controls that already show text do not use title');
  assert.equal(await run(`document.querySelector('.rail-nav button').id`), 'tab-conversations');
  assert.equal(await run(`document.querySelector('#tab-conversations').classList.contains('active')`), true);
  assert.equal(await run(`document.querySelector('.conversation-list-item').dataset.conversationId`), 'test-paused');
  assert.equal(await run(`document.querySelector('.conversation-list-button.active').closest('[data-conversation-id]').dataset.conversationId`), 'test-paused');
  assert.equal(await run(`document.activeElement.id`), 'message-input');
  assert.equal(await run(`getComputedStyle(document.querySelector('#message-input')).outlineStyle`), 'none');
  // IME confirmation belongs to the input method; only the following Enter submits.
  const imeKeys = await run(`(()=>{
    const input=document.querySelector('#message-input');
    document.querySelector('[data-send-mode=enter]').click();
    const form=document.querySelector('#composer');let submits=0;
    const capture=e=>{e.preventDefault();e.stopImmediatePropagation();submits++;};
    form.addEventListener('submit',capture,true);
    const press=options=>{const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});input.dispatchEvent(e);return {prevented:e.defaultPrevented,submits};};
    try {
      input.dispatchEvent(new CompositionEvent('compositionstart',{data:'nihao'}));
      const composing=press({isComposing:true,keyCode:229});
      input.dispatchEvent(new CompositionEvent('compositionend',{data:'nihao'}));
      const lateConfirm=press({isComposing:false,keyCode:229});
      const shift=press({shiftKey:true,keyCode:13});
      const enter=press({keyCode:13});
      return {composing,lateConfirm,shift,enter};
    } finally {form.removeEventListener('submit',capture,true);document.querySelector('[data-send-mode=command-enter]').click();}
  })()`);
  assert.deepEqual(imeKeys,{composing:{prevented:false,submits:0},lateConfirm:{prevented:false,submits:0},shift:{prevented:false,submits:0},enter:{prevented:true,submits:1}},'Enter that confirms IME composition does not send; when compositionend arrives first, the next plain Enter sends normally');
  await writeFile(join(output, 'startup-conversation-focus.png'), (await win.webContents.capturePage()).toPNG());
  // When conversations overflow the window: the list must scroll and the composer must not be pushed out of the window.
  // .sidebar is an item of the app-shell grid; without min-height:0 its content stretches it taller,
  // which lengthens the whole row, the chat column grows with it, and the composer falls below the overflow:hidden clip line.
  const crowded = await run(`(()=>{
    const scroll=document.querySelector('#contact-list .sidebar-scroll');
    const row=scroll.querySelector('.conversation-list-item');
    for(let i=0;i<30;i++) scroll.append(row.cloneNode(true));
    scroll.scrollTop=9999;
    const composer=document.querySelector('#composer').getBoundingClientRect();
    const add=document.querySelector('#new-group').getBoundingClientRect();
    return {canScroll:scroll.scrollHeight>scroll.clientHeight+10, scrolled:scroll.scrollTop>0,
            composerVisible:composer.bottom<=window.innerHeight+1,
            addVisible:add.top>=0 && add.bottom<=window.innerHeight};
  })()`);
  assert.ok(crowded.canScroll, 'list has a scrollable area when conversations exceed the height');
  assert.ok(crowded.scrolled, 'conversation list actually scrolls');
  assert.ok(crowded.composerVisible, 'no number of conversations can push the composer out of the window');
  assert.ok(crowded.addVisible, 'new conversation button stays in view when scrolled to the bottom');  await run(`(()=>{const scroll=document.querySelector('#contact-list .sidebar-scroll');scroll.scrollTop=0;
    scroll.querySelectorAll('.conversation-list-item').forEach((row,i)=>{if(i>3)row.remove();});})()`);

  await run(`window.adingTest.bumpConversation()`); await wait();
  assert.equal(await run(`document.querySelector('.conversation-list-item').dataset.conversationId`), 'test-direct');
  assert.equal(await run(`document.querySelector('.conversation-list-button.active').closest('[data-conversation-id]').dataset.conversationId`), 'test-paused', 'background updates do not steal the current conversation');
  await click('#tab-contacts'); await wait();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('.contact-list-item .contact-name')).map(el => el.textContent)`), ['小c','小q','小q-cn']);
  await run(`const search=document.querySelector('#contact-search'); search.focus(); search.value='QCN'; search.dispatchEvent(new Event('input'));`);
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('.contact-list-item .contact-name')).map(el => el.textContent)`), ['小q-cn']);
  await run(`window.adingTest.emit('onStoreEvent', {type:'contacts'})`); await wait();
  assert.equal(await run(`document.activeElement.id`), 'contact-search', 'search and background refresh must not lose focus');
  await writeFile(join(output, 'contact-search.png'), (await win.webContents.capturePage()).toPNG());
  // When there are many contacts and you scroll down, the search box must still be there: search exists precisely so you don't have to scroll
  const searchStays = await run(`(()=>{
    const scroll=document.querySelector('#contact-list .sidebar-scroll');
    const row=scroll.querySelector('.contact-list-item');
    for(let i=0;i<40;i++) scroll.append(row.cloneNode(true));
    scroll.scrollTop=9999;
    const box=document.querySelector('#contact-search').getBoundingClientRect();
    const scrolled=scroll.scrollTop>0;
    scroll.scrollTop=0;
    scroll.querySelectorAll('.contact-list-item').forEach((node,i)=>{if(i>2)node.remove();});
    return {scrolled, searchVisible:box.top>=0 && box.bottom<=window.innerHeight};
  })()`);
  assert.ok(searchStays.scrolled, 'contact list scrolls');
  assert.ok(searchStays.searchVisible, 'search box stays in view after scrolling');
  await run(`(()=>{const box=document.querySelector('#contact-search'); box.value=''; box.dispatchEvent(new Event('input'));})()`); await wait();
  await click('.contact-list-item[data-user-id="test-c"] .avatar'); await wait();
  assert.equal(await run(`document.querySelector('#contact-detail-refresh-status').hidden`), false, 'Agent details has its own status refresh entry');
  await click('#contact-detail-refresh-status'); await wait();
  assert.deepEqual(await run('window.adingTest.refreshedAgentIds()'), ['test-c'], 'only the current Agent is asked to refresh status');
  await click('#contact-detail-close'); await wait();
  // Clicking a contact lands on this Agent's focused direct chat. With no focus chosen yet it is the most recently created one.
  await click('.contact-list-item[data-user-id="test-c"] .contact-button'); await wait();
  await click('#tab-conversations'); await wait();
  const opened = () => run(`document.querySelector('.conversation-list-button.active').closest('[data-conversation-id]').dataset.conversationId`);
  assert.equal(await opened(), 'test-solo-conversation', 'with no focus chosen yet, lands on the most recently created direct chat');

  // Use "switch conversation" to move to another direct chat and it becomes the focus; clicking the contact again should return to it
  await click('#conversation-switcher-button'); await wait();
  await run(`Array.from(document.querySelectorAll('.conversation-switcher-item')).find(n=>n.textContent.includes('单聊')&&!n.textContent.includes('第二条')).click()`); await wait();
  assert.equal(await opened(), 'test-direct', 'switch conversation moved to the other direct chat');
  await click('#tab-contacts'); await wait();
  await click('.contact-list-item[data-user-id="test-c"] .contact-button'); await wait();
  await click('#tab-conversations'); await wait();
  assert.equal(await opened(), 'test-direct', 'clicking the contact returns to the direct chat just switched to');

  // The + at the top right is "add member". A direct chat cannot take more people: adding someone opens a group chat draft with the peer, leaving the original direct chat untouched
  await click('#conversation-add-member-button'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-add-member-menu').hidden`), false, 'clicking + opens the add member panel');
  assert.deepEqual(await run(`(()=>{const box=document.querySelector('#conversation-add-member-list [data-user-id="test-c"] input');return {checked:box.checked,disabled:box.disabled}})()`), {checked:true,disabled:true}, 'the direct chat peer is checked and cannot be unchecked');
  const extra = await run(`document.querySelector('#conversation-add-member-list input:not(:checked):not(:disabled)')?.value`);
  assert.ok(extra, 'panel has an Agent that can be added');
  await run(`document.querySelector('#conversation-add-member-list input[value="${extra}"]').click()`); await wait();
  assert.equal(await run(`document.querySelector('.conversation-list-button.active')`), null, 'adding someone to a direct chat enters a group chat draft');
  assert.ok(await run(`document.querySelectorAll('#conversation-avatar .member-collage-cell').length`) >= 2, 'draft is a group chat of the peer plus the new member');
  assert.equal(await run(`document.querySelector('#conversation-add-member-list input[value="${extra}"]').checked`), true, 'the newly added person becomes checked and stays in the list');
  await click('#messages'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-add-member-menu').hidden`), true, 'clicking elsewhere closes the add member panel');

  // Back to that direct chat. The first item of the "switch conversation" list is always "new conversation" and does not scroll with the conversations below
  await click('#tab-contacts'); await wait();
  await click('.contact-list-item[data-user-id="test-c"] .contact-button'); await wait();
  await click('#tab-conversations'); await wait();
  assert.equal(await opened(), 'test-direct', 'adding someone opens a draft and leaves the original direct chat untouched');
  await click('#conversation-switcher-button'); await wait();
  const switcher = await run(`(()=>{const menu=document.querySelector('#conversation-switcher-menu');const first=menu.firstElementChild;return {first:first.classList.contains('conversation-switcher-new'),scrollAfter:first.nextElementSibling.classList.contains('conversation-switcher-scroll'),items:menu.querySelectorAll('.conversation-switcher-scroll .conversation-switcher-item').length>0};})()`);
  assert.deepEqual(switcher, {first:true, scrollAfter:true, items:true}, 'new conversation is pinned as the first item, conversation entries are in the scroll area below');
  // Clicking "new conversation" opens another direct chat with this person, and the new one immediately becomes the focus
  await click('#conversation-switcher-menu .conversation-switcher-new'); await wait();
  assert.equal(await run(`document.querySelector('#group-dialog').open`), false, 'new conversation does not open the member picker dialog');
  await click('#conversation-switcher-button'); await wait();
  assert.equal(await run(`document.querySelector('.conversation-switcher-new .check')`), null, 'new conversation item in a direct chat draft shows no check mark');
  await click('#conversation-switcher-menu .conversation-switcher-new'); await wait();
  await run(`document.querySelector('#message-input').value='另开一条：把上周的会议纪要整理成周报';document.querySelector('#message-input').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit();`); await wait();
  const fromDirect = await run('window.adingTest.createdInput()');
  assert.deepEqual(fromDirect.memberIds, ['test-c'], 'the new direct chat has only this contact');
  const fresh = await opened();
  assert.notEqual(fresh, 'test-direct', 'the new direct chat becomes the current conversation');
  await click('#tab-contacts'); await wait();
  await click('.contact-list-item[data-user-id="test-c"] .contact-button'); await wait();
  await click('#tab-conversations'); await wait();
  assert.equal(await opened(), fresh, 'clicking the contact lands on the newly opened direct chat');

  // Switching to a group chat does not change the focus: clicking the contact still returns to that direct chat
  await click('#conversation-switcher-button'); await wait();
  await run(`Array.from(document.querySelectorAll('.conversation-switcher-item')).find(n=>n.textContent.includes('产品设计讨论'))?.click()`); await wait();
  await click('#tab-contacts'); await wait();
  await click('.contact-list-item[data-user-id="test-c"] .contact-button'); await wait();
  await click('#tab-conversations'); await wait();
  assert.equal(await opened(), fresh, 'switching to a group chat does not change the contact focus');
  await click('#tab-contacts'); await wait();
  await click('#tab-conversations');
  await click('[data-conversation-id="test-group"] .conversation-list-button');
  await wait();
  // The all-members view can switch too: it lists conversations with exactly the same members, and the first item "new conversation" opens another with the current members
  assert.equal(await run(`document.querySelector('#conversation-switcher-button').disabled`), false, 'the all-members view can open the switch list');
  await click('#conversation-switcher-button'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-switcher-menu .conversation-switcher-scroll [data-conversation-id="test-group"]') !== null`), true, 'the list contains the current group chat');
  // Each entry in the switch list reserves a slot in front: Ikkyu is shown while an Agent in the conversation is running, otherwise the slot stays empty but takes up space
  assert.equal(await run(`document.querySelectorAll('#conversation-switcher-menu .conversation-switcher-scroll .conversation-switcher-item').length === document.querySelectorAll('#conversation-switcher-menu .conversation-switcher-scroll .conversation-switcher-activity').length`), true, 'every conversation has an Ikkyu slot');
  assert.equal(await run(`document.querySelector('#conversation-switcher-menu [data-conversation-id="test-group"] .conversation-switcher-activity .ikkyu-thinking')?.getAttribute('aria-label') ?? ''`), '小c 思考中', 'a working conversation shows Ikkyu in front');
  for (const selector of ['#conversation-identity', '#contact-list [data-conversation-id="test-group"] .conversation-title-line']) {
    assert.equal(await run(`document.querySelectorAll('${selector} .ikkyu-thinking').length`), 1, 'group chat window and list show Ikkyu after work status is restored');
  }
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-q',conversationId:'test-group',busy:true,revision:2})`); await wait();
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-q',conversationId:'test-group',busy:false,revision:3})`); await wait();
  assert.equal(await run(`document.querySelectorAll('#conversation-switcher-menu [data-conversation-id="test-group"] .ikkyu-thinking').length`), 1, 'Ikkyu stays while an Agent is still running, without being added twice');
  for (const selector of ['#conversation-identity', '#contact-list [data-conversation-id="test-group"] .conversation-title-line']) {
    assert.equal(await run(`document.querySelectorAll('${selector} .ikkyu-thinking').length`), 1, 'after one Agent stops, Ikkyu stays once while other Agents still work');
  }
  await writeFile(join(process.env.ADING_UI_CAPTURE_DIR || output,'conversation-switcher-working.png'),(await win.webContents.capturePage()).toPNG());
  await click('#conversation-switcher-menu .conversation-switcher-new'); await wait();
  assert.equal(await run(`document.querySelector('.conversation-list-button.active')`), null, 'enters a new conversation draft with the same members');
  assert.equal(await run(`document.querySelector('#conversation-title').textContent`), '全体成员', 'draft keeps all members');
  assert.equal(await run(`document.querySelector('#conversation-switcher-button').disabled`), false, 'multi-member draft can still open the switch list');
  await click('#conversation-switcher-button'); await wait();
  assert.equal(await run(`document.querySelector('.conversation-switcher-new .check')`), null, 'new conversation item in a multi-member draft shows no check mark');
  assert.equal(await run(`document.querySelector('#conversation-switcher-menu [data-conversation-id="test-group"]') !== null`), true, 'multi-member draft lists earlier conversations with the same members');
  assert.equal(await run(`document.querySelector('#conversation-switcher-menu [data-conversation-id="test-direct"]')`), null, 'multi-member draft does not mix in direct chats with different members');
  await click('#conversation-switcher-menu .conversation-switcher-new'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-switcher-button').disabled`), false, 'repeatedly clicking new conversation can still switch');
  await click('#conversation-switcher-button'); await wait();
  await click('#conversation-switcher-menu [data-conversation-id="test-group"]'); await wait();
  assert.equal(await opened(), 'test-group', 'can switch back from a multi-member draft to an earlier conversation without sending');
  await click('[data-conversation-id="test-group"] .conversation-list-button'); await wait();
  // A message from days ago showing only the time looks like it was just sent: anything not from today must include the date
  const stamp = await run(`document.querySelector('#messages time')?.textContent ?? ''`);
  const shown = await run(`Array.from(document.querySelectorAll('#messages *')).map(n=>n.textContent.trim()).filter(t=>/^\\d{2}:\\d{2}$/.test(t))`);
  assert.deepEqual(shown, [], 'older messages must not show only the time');
  assert.ok(/9月5日|September 5/.test(stamp), `older messages include the date, actual: ${stamp}`);

  assert.equal(await run('document.querySelector("#conversation-header").classList.contains("conversation-running")'), true);
  assert.equal(await run(`document.querySelector('#conversation-queue-status').textContent`), 'AI 工作中，详情请查看“信息流”', 'group chat shows a notice while AI is running');
  for (const messageState of ['processing','waiting','handled',undefined]) {
    await run(`window.adingTest.emit('onAgentQueue', {queued:[{conversationId:'test-group',agentUserId:'test-codex',messageState:${JSON.stringify(messageState ?? null)}}]})`);
    await wait();
    assert.equal(await run(`document.querySelector('#conversation-queue-status').textContent`), 'AI 工作中，详情请查看“信息流”', 'queue status is no longer listed one by one; a single notice points to the feed');
  }
  await run(`window.adingTest.emit('onAgentQueue', {queued:[]})`);

  assert.equal(await run(`document.querySelector('#stop-button svg').dataset.icon`),'pause');
  assert.equal(await run(`document.querySelector('#stop-button').disabled`),false);
  assert.equal(await run(`document.querySelector('[data-conversation-id="test-group"] .conversation-list-button').classList.contains('busy')`),true);
  await click('#stop-button'); await wait();
  assert.deepEqual(await run('window.adingTest.stoppedConversationIds()'),['test-group']);
  assert.equal(await run(`document.querySelector('#conversation-header').classList.contains('conversation-running')`),true,'after the cancel request is sent, stays running until it actually ends');
  await writeFile(join(output,'conversation-thinking.png'),(await win.webContents.capturePage()).toPNG());
  await click('#conversation-agent-menu-button');
  await wait();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#conversation-agent-menu .conversation-agent-readiness')).map(el => el.classList.contains('ready'))`), [true, false]);
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-pause').length`), 0);
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-state.replying').length`), 1);
  const animation = await run(`(() => {
    const sprite=document.querySelector('.replying .ikkyu-status-strip');
    return { loaded:sprite.complete && sprite.naturalWidth===4224, frames:getComputedStyle(sprite).animationTimingFunction, running:sprite.getAnimations().length };
  })()`);
  assert.equal(animation.loaded, true);
  assert.equal(animation.frames, 'steps(44)');
  assert.equal(animation.running, 1);
  const before = await run(`getComputedStyle(document.querySelector('.replying .ikkyu-status-strip')).transform`);
  await wait();
  assert.notEqual(await run(`getComputedStyle(document.querySelector('.replying .ikkyu-status-strip')).transform`), before);
  assert.equal(await run(`getComputedStyle(document.querySelector('.conversation-agent-menu-state:not(.replying) .ikkyu-status-strip')).display`), 'none');
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-c',conversationId:'test-direct',busy:true,revision:6})`);
  assert.equal(await run(`document.querySelector('[data-conversation-id="test-direct"] .conversation-list-button').classList.contains('busy')`),true,'the same Agent can run in another conversation');
  assert.equal(await run(`document.querySelector('#conversation-header').classList.contains('conversation-running')`),true,'other conversations\' status does not override the current conversation');
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-q',conversationId:'test-group',busy:true,revision:6})`);
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-c',conversationId:'test-group',busy:false,revision:6})`);
  assert.equal(await run(`document.querySelector('#stop-button').disabled`),false,'another member is still running, pause stays available');
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-q',conversationId:'test-group',busy:false,revision:7})`);
  assert.equal(await run(`document.querySelector('[data-conversation-id="test-direct"] .conversation-list-button').classList.contains('busy')`),true,'ending the current conversation does not clear other conversations\' status');
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-c',conversationId:'test-direct',busy:false,revision:7})`);
  assert.equal(await run(`document.querySelector('#conversation-queue-status').hidden`),true,'no notice when no AI is running');
  await run(`window.adingTest.emit('onAgentQueue', {revision:8,queued:[{conversationId:'test-group',agentUserId:'test-c'}]})`);
  assert.equal(await run(`document.querySelector('#conversation-queue-status').hidden`),false,'queued pending work also counts as working');
  assert.equal(await run(`document.body.textContent.includes('正在安排后续处理')`),false);
  assert.equal(await run(`document.querySelector('#conversation-header').classList.contains('conversation-idle')`),true,'queued is not running');
  await run(`window.adingTest.emit('onAgentQueue', {revision:9,queued:[]})`);
  assert.equal(await run(`document.querySelector('#conversation-queue-status').hidden`),true,'disappears once everything stops');
  // Direct chat shows the same notice
  await click('[data-conversation-id="test-direct"] .conversation-list-button'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-queue-status').hidden`),true);
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-c',conversationId:'test-direct',busy:true,revision:10})`); await wait();
  assert.equal(await run(`document.querySelector('#conversation-queue-status').textContent`), 'AI 工作中，详情请查看“信息流”', 'direct chat also shows a notice while AI is running');
  await writeFile(join(output, 'ai-working-direct.png'), (await win.webContents.capturePage()).toPNG());
  await run(`window.adingTest.emit('onAgentBusy', {agentUserId:'test-c',conversationId:'test-direct',busy:false,revision:11})`); await wait();
  assert.equal(await run(`document.querySelector('#conversation-queue-status').hidden`),true,'disappears once the direct chat AI stops');
  await click('[data-conversation-id="test-group"] .conversation-list-button'); await wait();

  await run(`window.adingTest.emit('onAgentBusy', { agentUserId:'test-c',conversationId:'test-group',busy:false,revision:6 })`);
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-state.replying').length`), 0);
  assert.equal(await run(`document.querySelector('#conversation-header').classList.contains('conversation-idle')`),true);
  for (const selector of ['#conversation-identity', '#contact-list [data-conversation-id="test-group"] .conversation-title-line']) {
    assert.equal(await run(`document.querySelectorAll('${selector} .ikkyu-thinking').length`), 0, 'window and list remove Ikkyu after all Agents stop');
  }

  assert.equal(await run(`document.querySelector('#stop-button').disabled`),false,'paused and all Agents stopped: the button becomes "Continue"');
  assert.equal(await run(`document.querySelector('#stop-button svg').dataset.icon`),'play');
  assert.equal(await run(`document.querySelector('[data-conversation-id="test-group"] .conversation-list-button').classList.contains('busy')`),false);
  await click('#conversation-switcher-button'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-switcher-menu [data-conversation-id="test-group"] .ikkyu-thinking')`), null, 'all Agents stopped, the switch list removes Ikkyu');
  await click('#conversation-switcher-button'); await wait();
  await writeFile(join(output,'conversation-idle.png'),(await win.webContents.capturePage()).toPNG());

  await run(`window.adingTest.emit('onAgentProgress', { agentUserId:'test-c',conversationId:'test-group',text:'正在整理结果',revision:7 })`);
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-state.replying').length`), 1);
  await run(`window.adingTest.unavailable()`); await wait();
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-state.replying').length`), 1, 'Readiness changes must not hide in-flight activity');
  await run(`window.adingTest.emit('onAgentBusy', { agentUserId:'test-c',conversationId:'test-group',busy:false,revision:8 })`);
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-state.replying').length`), 0);
  await run(`window.adingTest.emit('onAgentProgress', { agentUserId:'test-c',conversationId:'test-group',text:'旧进度',revision:7 })`);
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-state.replying').length`), 0, 'Stale progress cannot revive a completed turn');
  await writeFile(join(output, 'agents.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#conversation-agent-menu .conversation-agent-leader')).map(b=>b.title)`), ['leader','设为 leader']);
  assert.equal(await run(`document.querySelectorAll('#conversation-agent-menu .conversation-agent-leader svg[data-icon="leader"]').length`), 2);
  await click('#conversation-agent-menu .conversation-agent-leader:not(.active)'); await wait();
  assert.equal(await run(`document.querySelectorAll('#conversation-agent-menu .conversation-agent-leader.active').length`), 1);
  assert.equal(await run(`document.querySelectorAll('#conversation-agent-menu .conversation-agent-leader')[1].title`), 'leader');
  assert.deepEqual((await run(`window.adingTest.verifiedKinds()`)).sort(),['codex','qoder','qoder-cn'],'checks once in parallel automatically after the first screen finishes');
  // Account entry: signed out shows only "sign in", sign up is reached from the sign-in dialog; signed in it becomes "sign out", and it is restored after signing out
  const accountButtons = () => run(`['#account-login','#account-logout'].map(s=>document.querySelector(s).hidden)`);
  assert.equal(await run(`document.querySelector('#account-register')`), null, 'top bar has no separate sign-up entry');
  assert.deepEqual(await accountButtons(), [false, true], 'signed out shows only sign in');
  await click('#account-login'); await wait();
  assert.equal(await run(`document.querySelector('#account-dialog').open`), true, 'clicking sign in opens the dialog');
  assert.equal(await run(`document.querySelector('#account-confirm-field').hidden`), true, 'sign in does not require password confirmation');
  await click('#account-switch'); await wait();
  assert.equal(await run(`document.querySelector('#account-confirm-field').hidden`), false, 'switching to sign up requires password confirmation');
  assert.equal(await run(`document.querySelector('#account-agents-notice').hidden`), true, 'sign up does not switch data and does not ask to stop agents');
  await run(`document.querySelector('#account-username').value='tester';document.querySelector('#account-password').value='secret-123';document.querySelector('#account-confirm').value='secret-456';document.querySelector('#account-form').requestSubmit()`); await wait();
  assert.equal(await run(`document.querySelector('#account-feedback').textContent`), '两次输入的密码不一致');
  assert.equal(await run(`document.querySelector('#account-dialog').open`), true, 'dialog stays open when passwords do not match');
  await run(`document.querySelector('#account-confirm').value='secret-123';document.querySelector('#account-form').requestSubmit()`); await wait();
  assert.equal(await run(`document.querySelector('#account-dialog').open`), true, 'dialog stays open after successful sign up');
  assert.equal(await run(`document.querySelector('#account-confirm-field').hidden`), true, 'returns to the sign-in view after successful sign up');
  assert.equal(await run(`document.querySelector('#account-username').value`), 'tester', 'username is kept when returning to sign in');
  assert.equal(await run(`document.querySelector('#account-feedback').textContent`), '注册成功，请登录');
  assert.deepEqual(await accountButtons(), [false, true], 'sign up does not sign in automatically');
  await run(`document.querySelector('#account-password').value='secret-123';document.querySelector('#account-form').requestSubmit()`); await wait();
  assert.equal(await run(`document.querySelector('#account-dialog').open`), false, 'dialog closes after successful sign in');
  assert.equal(await run(`document.querySelector('#account-password').value`), '', 'password is cleared after closing');
  assert.deepEqual(await accountButtons(), [true, false], 'signed in shows only sign out');
  assert.equal(await run(`document.querySelector('#current-user-rail-avatar').title`), 'tester', 'after sign in the navigation avatar uses the account profile');
  // Mainland China accounts stay online; only the add friend entry is disabled, keeping the shared hover tooltip.
  await click('#tab-contacts'); await wait();
  const friendAdd = '#contact-list .sidebar-add-button';
  await run(`window.adingTest.setFriendPermission(false)`); await wait();
  assert.equal(await run(`document.querySelector('${friendAdd}').getAttribute('aria-disabled')`), 'true');
  assert.equal(await run(`document.querySelector('#account-logout').hidden`), false, 'region restriction does not leave online mode');
  await click(friendAdd); await wait();
  assert.equal(await run(`document.querySelector('#friend-dialog').open`), false, 'disabled entry cannot open add friend');
  await run(`document.querySelector('${friendAdd}').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))`); await wait();
  assert.equal(await run(`document.querySelector('#icon-tooltip').textContent`), '不支持的地区');
  assert.equal(await run(`document.querySelector('#icon-tooltip').matches(':popover-open')`), true);
  assert.equal(await run(`getComputedStyle(document.querySelector('${friendAdd}')).cursor`), 'not-allowed');
  await run(`document.querySelector('${friendAdd}').dispatchEvent(new PointerEvent('pointerout',{bubbles:true}))`);
  await run(`window.adingTest.setFriendPermission(true)`); await wait();
  assert.equal(await run(`document.querySelector('${friendAdd}').getAttribute('aria-disabled')`), 'false', 'allowlisted and overseas regions are open');
  await click(friendAdd); await wait();
  assert.equal(await run(`document.querySelector('#friend-dialog').open`), true);
  await run(`window.adingTest.setFriendPermission(false)`); await wait();
  assert.equal(await run(`document.querySelector('#friend-dialog').open`), false, 'switching to a restricted region closes the open dialog');
  await run(`window.adingTest.setFriendPermission(true)`); await wait();

  await click('#tab-conversations'); await wait();
  await click('#current-user-rail-avatar'); await wait();
  assert.equal(await run(`document.querySelector('#contact-detail-username').value`), 'tester', 'profile details show the account username');
  // The password belongs to the signed-in account: only after sign in does the own profile page have this entry
  assert.equal(await run(`document.querySelector('#contact-change-password').hidden`), false, 'own profile page has change password after sign in');
  await click('#contact-change-password'); await wait();
  assert.equal(await run(`document.querySelector('#password-dialog').open`), true, 'opens the change password dialog');
  await run(`document.querySelector('#password-current').value='secret-123';document.querySelector('#password-new').value='next-456';document.querySelector('#password-confirm').value='typo-789';document.querySelector('#password-form').requestSubmit()`); await wait();
  assert.equal(await run(`document.querySelector('#password-dialog').open`), true, 'does not submit when the two new passwords differ');
  assert.equal(await run(`document.querySelector('#password-error').textContent`), '两次输入的新密码不一致');
  await run(`document.querySelector('#password-confirm').value='next-456';document.querySelector('#password-form').requestSubmit()`); await wait();
  assert.equal(await run(`document.querySelector('#password-dialog').open`), false, 'dialog closes after a successful change');
  assert.deepEqual(await run('window.adingTest.passwordChanges()'), [['secret-123','next-456']], 'old and new passwords are passed to the backend unchanged');
  await click('#current-user-rail-avatar'); await wait();
  await run(`document.querySelector('#contact-detail-name').value='老板'`);
  await click('#contact-detail-save'); await wait();
  assert.equal(await run(`document.querySelector('#current-user-rail-avatar').title`), '老板', 'profile saved while signed in takes effect immediately');
  assert.equal(await run(`window.adingTest.localProfileEdits()`), 0, 'signed in does not modify the standalone own profile');
  await click('#account-logout'); await wait();
  assert.equal(await run(`document.querySelector('#logout-confirm-dialog').open`), true, 'confirms before signing out');
  assert.ok((await run(`document.querySelector('#logout-confirm-copy').textContent`)).startsWith('确定退出登录吗？退出后会回到单机版。'));
  assert.deepEqual(await accountButtons(), [true, false], 'not signed out before confirming');
  await click('#logout-confirm-action'); await wait();
  assert.equal(await run(`document.querySelector('#logout-confirm-dialog').open`), false, 'confirmation dialog closes after confirming');
  assert.deepEqual(await accountButtons(), [false, true], 'sign in is restored after signing out');
  assert.equal(await run(`document.querySelector('#current-user-rail-avatar').title`), '测试用户', 'standalone own profile is restored after signing out');
  for (const [button, panel] of [['#conversation-agent-menu-button', '#conversation-agent-menu'], ['#toggle-process', '#process-panel'], ['#agents-entry', '#agent-pane'], ['#send-mode-button', '#send-mode-menu']]) {
    // Start closed, then verify open / close / interrupted-close / final-close.
    if (!await run(`document.querySelector('${panel}').hidden`)) { await click(button); await wait(); }
    await click(button);
    assert.equal(await run(`document.querySelector('${panel}').hidden`), false, panel);
    await wait();
    await click(button);
    await click(button);
    await wait();
    assert.equal(await run(`document.querySelector('${panel}').hidden`), false, `${panel} rapid reopen`);
    await click(button); await wait();
    assert.equal(await run(`document.querySelector('${panel}').hasAttribute('hidden')`), true, `${panel} closed`);
  }
  const checkedMode=`document.querySelector("input[name='permission-mode']:checked")?.value`;
  await run(`document.querySelector('#app-settings-entry').click()`);await wait();
  await run(`document.querySelector("[data-settings-tab='permissions']").click()`);await wait();
  assert.equal(await run(checkedMode),'unattended','unattended by default');
  assert.deepEqual(await run(`Array.from(document.querySelectorAll("input[name='permission-mode']")).map(i=>i.closest('label').querySelector('.settings-choice-text > span').textContent)`),['人工审核','agent 自动审核','无人值守']);
  for(const mode of ['manual','leader','unattended']) {
    await run(`document.querySelector("input[name='permission-mode'][value='${mode}']").click()`);await wait();
    assert.equal(await run(`window.ading.getPermissionMode()`),mode);
    await run(`document.querySelector("[data-settings-tab='language']").click()`);
    await run(`document.querySelector("[data-settings-tab='permissions']").click()`);await wait();
    assert.equal(await run(checkedMode),mode,'reopening keeps the review mode');
  }
  // Computer sleep: on by default; unchecking saves to the main process and it stays that way after reopening
  assert.equal(await run(`document.querySelector('#settings-keep-awake').checked`),true,'keeps awake while running tasks by default');
  assert.equal(await run(`document.querySelector('#settings-keep-awake').closest('label').querySelector('.settings-choice-text > span').textContent`),'执行任务时保持电脑唤醒');
  assert.match(await run(`document.querySelector('#settings-keep-awake').closest('label').querySelector('.settings-choice-hint').textContent`),/合上屏幕仍会睡眠/);
  await run(`document.querySelector('#settings-keep-awake').click()`);await wait();
  assert.equal(await run(`window.ading.getKeepAwake()`),false);
  await run(`document.querySelector("[data-settings-tab='language']").click()`);
  await run(`document.querySelector("[data-settings-tab='permissions']").click()`);await wait();
  assert.equal(await run(`document.querySelector('#settings-keep-awake').checked`),false,'reopening keeps the keep-awake setting');
  await run(`document.querySelector('#settings-keep-awake').click()`);await wait();
  assert.equal(await run(`window.ading.getKeepAwake()`),true);
  await writeFile(join(output,'permission-modes.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#app-settings-dialog').close()`);await wait();
  await click('#new-group'); await wait();
  assert.equal(await run(`document.querySelector('#group-dialog').open`), true);
  assert.equal(await run(`document.querySelectorAll('#group-member-list .conversation-agent-readiness').length`), 3);
  assert.equal(await run(`document.querySelectorAll('#group-member-list .conversation-agent-leader').length`), 3);
  await click('#group-select-all');
  assert.equal(await run(`document.querySelectorAll('#group-member-list input:checked').length`),3);
  assert.equal(await run(`document.querySelector('#group-member-list .conversation-agent-leader.active').closest('.member-pick').dataset.userId`),'test-c');
  await click('#group-member-list [data-user-id="test-q"] .conversation-agent-leader');
  assert.equal(await run(`document.querySelectorAll('#group-member-list .conversation-agent-leader.active').length`),1);
  assert.equal(await run(`document.querySelector('#group-member-list .conversation-agent-leader.active').closest('.member-pick').dataset.userId`),'test-q');
  assert.equal(await run(`document.querySelectorAll('#group-mode, #conversation-mode').length`),0,'user does not need to choose a conversation mode');
  assert.equal(await run(`document.querySelector('#conversation-agent-menu-button').closest('#message-filters') !== null`),true);
  assert.equal(await run(`document.querySelector('#conversation-agent-menu-button').closest('.conversation-agent-menu-wrap').nextElementSibling.id`),'toggle-process');

  assert.equal(await run(`document.querySelectorAll('#group-member-list .ading-agent-symbol, #group-member-list .member-tag').length`),0,'member picker keeps only the status light');
  assert.equal(await run(`Array.from(document.querySelectorAll('.member-pick-choice > span')).every(s=>s.getBoundingClientRect().height < 25 && s.getBoundingClientRect().width>20)`),true,'member names lay out horizontally as normal');
  await writeFile(join(output, 'create-conversation.png'), (await win.webContents.capturePage()).toPNG());
  // New conversation only picks members: the name, goal, instructions and workspace column was removed entirely
  assert.equal(await run(`document.querySelectorAll('#group-dialog .conversation-dialog-main, #group-create-name, #group-goal, #group-instructions, #group-workspace').length`),0,'dialog has only the member picker column');
  assert.equal(await run(`(()=>{const body=document.querySelector('.conversation-dialog-body');const col=document.querySelector('.conversation-contact-column');const b=body.getBoundingClientRect(),c=col.getBoundingClientRect();return c.width>b.width-60;})()`),true,'member picker column fills the dialog width');
  await click('#new-group');
  await click('#new-group'); await wait();
  assert.equal(await run(`document.querySelector('#group-dialog').open`), true);
  await click('#group-close'); await wait();
  assert.equal(await run(`document.querySelector('#group-dialog').open`), false);
  await click('[data-conversation-id="test-group"] .conversation-item-settings'); await wait();
  assert.equal(await run(`document.querySelector('#settings-dialog').open`), true);
  assert.equal(await run(`document.querySelector('#settings-clear-permissions')`), null, 'conversation settings has no clear authorization');
  assert.equal(await run(`document.querySelector('#settings-workspace').getBoundingClientRect().height`),0);
  assert.equal(await run(`document.querySelector('#workspace-input').getBoundingClientRect().height`),0);
  assert.equal(await run(`document.querySelectorAll('.workspace-management').length`),0);
  assert.equal(await run(`document.querySelectorAll('#member-editor .ading-agent-symbol').length`),0,'settings members distinguish Agents only by the light');
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#member-editor .member-row')).map(n=>n.dataset.userId)`), ['test-c','test-q'], 'member list does not show yourself');
  assert.equal(await run(`document.querySelector('#settings-members-title').textContent`), '成员 · 2');
  assert.equal(await run(`document.querySelectorAll('#member-editor .conversation-agent-readiness').length`),2);
  assert.equal(await run(`Array.from(document.querySelectorAll('#member-editor .conversation-agent-readiness')).every(n=>['可用','不可用'].includes(n.title))`),true);
  assert.equal(await run(`document.querySelectorAll('#member-editor .human-group-divider').length`),0);
  assert.equal(await run(`document.querySelectorAll('#member-editor select').length`), 0);
  await run(`document.querySelector('#group-name-input').value='未保存的新标题'`);
  await click('#member-editor [data-user-id="test-c"] .leader'); await wait();
  await run(`(() => {const b=document.querySelector('#member-editor [data-user-id="test-q"] .remove'); b.disabled=true; b.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));})()`); await wait();
  assert.equal(await run(`document.querySelector('#icon-tooltip').matches(':popover-open')`), true, 'disabled icons also show a tooltip');
  assert.equal(await run(`document.querySelector('#icon-tooltip').textContent`), '移除 小q');
  await run(`document.querySelector('#member-editor [data-user-id="test-q"] .remove').disabled=false`);
  await run(`document.dispatchEvent(new Event('scroll'))`);
  assert.equal(await run(`document.querySelector('#group-name-input').value`), '未保存的新标题');
  assert.equal(await run(`document.querySelectorAll('#member-editor .leader[aria-pressed="true"]').length`), 1);
  assert.equal(await run(`document.querySelector('#member-editor .leader').innerHTML === document.querySelector('.conversation-agent-leader').innerHTML`), true);
  assert.equal(await run(`(() => {const icons=Array.from(document.querySelectorAll('svg[data-icon="remove"]')); return icons.every(s=>s.outerHTML===icons[0].outerHTML);})()`), true, 'remove icon is consistent across entries');
  assert.equal(await run(`document.querySelector('#member-editor .member-icon-button.remove svg').dataset.icon`), 'remove', 'removing a member uses the "move out" icon, not a trash can');
  assert.equal(await run(`Array.from(document.querySelectorAll('.conversation-item-delete svg')).every(s=>s.dataset.icon==='delete')`), true, 'deleting a conversation uses a trash can');
  const align = await run(`Array.from(document.querySelectorAll('#member-editor .member-leader-slot')).map(n=>n.getBoundingClientRect().x)`);
  assert.ok(align.every(x=>x===align[0]), 'human and Agent action columns are aligned');
  await click('#settings-add-members');
  await run(`const s=document.querySelector('#settings-member-search'); s.value='QCN'; s.dispatchEvent(new Event('input'));`);
  assert.equal(await run(`document.querySelectorAll('#member-editor .member-row').length`), 1);
  await click('#member-editor [data-user-id="test-qcn"] .add'); await wait();
  await click('#settings-add-members');
  assert.equal(await run(`document.querySelectorAll('#member-editor .member-row').length`), 3, 'three Agents after joining, not counting yourself');
  await click('#member-editor [data-user-id="test-qcn"] .remove'); await wait();
  assert.equal(await run(`document.querySelectorAll('#member-editor .member-row').length`), 2);
  await writeFile(join(output, 'conversation-settings.png'), (await win.webContents.capturePage()).toPNG());
  await run(`window.adingTest.manyMembers()`); await wait();
  win.setSize(900, 560); await wait();
  const headerBefore = await run(`document.querySelector('.conversation-settings-header').getBoundingClientRect().top`);
  await run(`document.querySelector('#member-editor').scrollTop=10000; document.querySelector('.conversation-settings-main').scrollTop=10000; document.querySelector('#settings-dialog').scrollTop=10000;`);
  await wait();
  assert.equal(await run(`document.querySelector('.conversation-settings-header').getBoundingClientRect().top`), headerBefore);
  assert.equal(await run(`document.querySelector('#settings-dialog').scrollTop`), 0);
  assert.ok(await run(`document.querySelector('#member-editor').scrollTop>0`), 'member list scrolls independently');
  assert.ok(await run(`document.querySelector('#settings-close').getBoundingClientRect().top>=0 && document.querySelector('#settings-save').getBoundingClientRect().bottom<=innerHeight`), 'close and save are always visible');
  assert.ok(await run(`document.querySelector('.conversation-settings-body').scrollWidth<=document.querySelector('.conversation-settings-body').clientWidth`), 'no horizontal overflow');
  await writeFile(join(output, 'conversation-settings-scroll.png'), (await win.webContents.capturePage()).toPNG());
  // A conversation with Agents can have no goal: after clearing the goal, saving succeeds, the dialog closes, and no error is shown
  await run(`document.querySelector('#conversation-goal-input').value=''`);
  assert.equal(await run(`document.querySelector('#conversation-goal-input').required`), false);
  await click('#settings-save'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-settings-error').textContent`), '', 'can save without a goal');
  assert.equal(await run(`document.querySelector('#settings-dialog').open`), false, 'dialog closes after saving');
  win.setSize(1220,820); await wait();
  await click('#tab-contacts'); await wait();
  await run(`document.querySelector('#contact-search').value='';document.querySelector('#contact-search').dispatchEvent(new Event('input'));`);
  assert.equal(await run(`document.querySelectorAll('#contact-list .human-group-divider').length`),1);
  assert.equal(await run(`document.querySelectorAll('#contact-list .ading-agent-symbol, #contact-list .member-group-heading, #contact-list .contact-kind-icon').length`),0,'contacts have no redundant type icons or group counts');
  assert.equal(await run(`(() => {const kinds=Array.from(document.querySelectorAll('.contact-list-item')).map(n=>n.dataset.memberKind);const split=kinds.indexOf('human');return split>0 && kinds.slice(0,split).every(k=>k==='agent') && kinds.slice(split).every(k=>k==='human');})()`),true,'Agents on top, humans below');
  assert.equal(await run(`document.querySelectorAll('.contact-list-item[data-member-kind="human"] .agent-lamp').length`),0);
  await writeFile(join(output, 'contacts-grouped.png'), (await win.webContents.capturePage()).toPNG());
  await click('#tab-conversations'); await wait();
  await click('[data-conversation-id="test-paused"] .conversation-list-button'); await wait();
  assert.equal(await run('document.querySelector("#conversation-header").classList.contains("conversation-idle")'), true);
  await click('#conversation-agent-menu-button'); await wait();
  assert.equal(await run(`document.querySelectorAll('.conversation-agent-menu-state.replying').length`), 0);
  await writeFile(join(output, 'paused.png'), (await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#message-input').value = '继续讨论'; document.querySelector('#message-input').dispatchEvent(new Event('input')); document.querySelector('#composer').requestSubmit();`);
  await wait();
  assert.equal(await run('document.querySelector("#conversation-header").classList.contains("conversation-idle")'), true, 'sending alone does not prove an Agent is running');
  assert.equal(await run('document.querySelector("#composer-resume-icon")'), null);
  assert.equal(await run('document.querySelector("#stop-button").disabled'), true);
  await writeFile(join(output, 'send-resumed.png'), (await win.webContents.capturePage()).toPNG());
  await click('#report-conversation'); await wait();
  assert.equal(await run(`document.querySelector('#report-confirm-dialog').open`),true);
  assert.equal(await run(`document.querySelector('#report-confirm-copy').textContent`),'让 Leader 汇报当前会话的进展吗？');
  assert.deepEqual(await run('window.adingTest.reportedConversationIds()'),[],'opening the dialog does not request a report');
  await writeFile(join(output,'report-confirm.png'),(await win.webContents.capturePage()).toPNG());
  await click('#report-confirm-cancel'); await wait();
  assert.equal(await run(`document.querySelector('#report-confirm-dialog').open`),false);
  assert.deepEqual(await run('window.adingTest.reportedConversationIds()'),[],'cancel does not request a report');
  await click('#report-conversation'); await click('#report-confirm-action'); await wait();
  assert.deepEqual(await run('window.adingTest.reportedConversationIds()'),['test-paused'],'confirm requests exactly one report in the original conversation');

  await click('[data-conversation-id="test-direct"] .conversation-list-button'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-agent-menu-button').disabled`), true);
  assert.equal(await run(`document.querySelector('#report-conversation').disabled`), true);
  assert.equal(await run(`document.querySelector('#stop-button').disabled`), true, 'pause button is greyed out in an idle direct chat');
  assert.equal(await run(`getComputedStyle(document.querySelector('#stop-button')).backgroundColor`), 'rgb(245, 247, 250)');
  await click('#stop-button'); await wait();
  assert.deepEqual(await run('window.adingTest.stoppedConversationIds()'),['test-group'],'an idle conversation cannot be paused');

  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:{messageId:'assignment-regression',conversationId:'test-direct',seq:99,senderId:'test-c',type:'SYSTEM',content:'请小q复核图片的印刷题干',createdAt:'2026-09-05T02:00:00Z'}})`);
  await wait();
  assert.equal(await run(`document.querySelector('#messages').textContent.includes('请小q复核图片的印刷题干')`),true,'earlier assignment instructions appear in the chat');
  await click('#toggle-process'); await wait();
  assert.equal(await run(`Math.round(document.querySelector('#process-panel').getBoundingClientRect().width)`),680,'feed dialog uses the wider size');
  assert.deepEqual(await run(`(()=>{const s=getComputedStyle(document.querySelector('#process-panel'));return [s.top,s.bottom]})()`),['4px','4px'],'feed dialog uses the taller size');
  await run(`window.processFeedMutations=0;window.processFeedObserver=new MutationObserver(records=>window.processFeedMutations+=records.filter(r=>r.type==='childList').length);window.processFeedObserver.observe(document.querySelector('#process-feed'),{childList:true});`);
  for(let i=0;i<30;i++)await run(`window.adingTest.emit('onAgentProgress',{agentUserId:'test-c',conversationId:'test-direct',text:'批量进度 ${i}',revision:${200+i}})`);
  await wait();
  assert.ok(await run(`window.processFeedMutations<=4`),'a storm of parallel progress merges into a few feed refreshes');
  await run(`window.processFeedObserver.disconnect()`);
  assert.equal(await run(`document.querySelector('.process-run-current').textContent`),'批量进度 29','live feed highlights the latest progress');
  assert.equal(await run(`document.querySelector('.process-run:not(.done)>.process-timeline').textContent.includes('批量进度 28')`),true,'shows the latest three by default, not the earliest three');
  await run(`window.adingTest.emit('onAgentBusy',{agentUserId:'test-c',conversationId:'test-direct',busy:false,revision:230})`);await wait();
  assert.equal(await run(`document.querySelector('.process-run.stopped .process-run-state').textContent`),'已停止','after pausing, this round\'s feed is kept and marked final');
  assert.equal(await run(`document.querySelector('#process-feed').textContent.includes('批量进度 29')`),true,'live logs remain viewable after pausing');
  await run(`window.adingTest.emit('onAgentBusy',{agentUserId:'test-c',conversationId:'test-direct',busy:true,revision:231});window.adingTest.emit('onAgentProgress',{agentUserId:'test-c',conversationId:'test-direct',text:'新一轮进度',revision:232});window.adingTest.emit('onAgentBusy',{agentUserId:'test-c',conversationId:'test-direct',busy:false,revision:233})`);await wait();
  assert.equal(await run(`document.querySelector('#process-feed').textContent.includes('批量进度 29')`),false,'old live stream is cleared only when the same Agent starts its next round');
  assert.equal(await run(`document.querySelector('#process-feed').textContent.includes('新一轮进度')`),true);
  await run(`window.adingTest.emit('onAgentBusy',{agentUserId:'test-c',conversationId:'test-direct',busy:true,revision:234});window.adingTest.emit('onAgentProgress',{agentUserId:'test-c',conversationId:'test-direct',text:'并行工作 0952：清理中',revision:235});window.adingTest.emit('onAgentProgress',{agentUserId:'test-c',conversationId:'test-direct',text:'并行工作 0954：已交付，待核验',revision:236});window.adingTest.emit('onAgentBusy',{agentUserId:'test-c',conversationId:'test-direct',busy:false,revision:237})`);await wait();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('.process-lane-summary strong')).map(el=>el.textContent)`),['0952','0954'],'parallel work shows each lane\'s latest status');
  assert.equal(await run(`document.querySelector('#process-feed').textContent.includes('请小q复核图片的印刷题干')`),false,'assignments are not mislabelled as completed tool steps');
  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:{messageId:'internal-retry',conversationId:'test-direct',seq:99.1,senderId:'test-c',type:'SYSTEM',internal:true,content:'连接中断，正在恢复 1/3。',createdAt:'2026-09-05T02:00:01Z'}})`);
  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:{messageId:'legacy-idle',conversationId:'test-direct',seq:99.2,senderId:'test-c',type:'SYSTEM',content:'会话未停止、尚未完成交付，目前没有 Agent 正在执行。',createdAt:'2026-09-05T02:00:02Z'}})`);
  await wait();
  assert.equal(await run(`document.querySelector('#messages').textContent.includes('系统通知')`),false,'chat has no system notification sender');
  assert.equal(await run(`document.querySelector('#messages').textContent.includes('连接中断') || document.querySelector('#messages').textContent.includes('目前没有 Agent')`),false,'internal recovery and earlier reminders do not enter the chat');
  assert.equal(await run(`document.querySelector('#process-feed').textContent.includes('连接中断')`),true,'diagnostics remain viewable in the feed');
  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:{messageId:'expanded-log',conversationId:'test-direct',seq:99.3,senderId:'test-c',content:'完成',steps:Array.from({length:18},(_,i)=>'步骤'+i),createdAt:'2026-09-05T02:00:03Z'}})`);
  await wait();
  await run(`document.querySelector('#process-feed details').open=true`);await wait();
  await run(`document.querySelector('#process-feed').scrollTop=0`);
  await run(`window.adingTest.emit('onAgentQueue',{revision:100,queued:[]})`);await wait();
  assert.equal(await run(`document.querySelector('#process-feed details').open`),true,'refresh keeps expanded logs');
  assert.ok(await run(`document.querySelector('#process-feed').scrollTop<10`),'does not jump to the bottom while reading history');
  await run(`document.querySelector('#process-feed details').open=false`);await wait();
  await run(`window.adingTest.emit('onAgentQueue',{revision:101,queued:[]})`);await wait();
  assert.equal(await run(`document.querySelector('#process-feed details').open`),false,'manual collapse is also kept');
  await writeFile(join(output,'assignment-chat.png'),(await win.webContents.capturePage()).toPNG());
  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:{messageId:'artifact-regression',conversationId:'test-direct',seq:100,senderId:'test-c',type:'USER',content:'[产物](/Users/test/wrong) [危险](javascript:alert)',createdAt:'2026-09-05T02:01:00Z'}})`);
  await wait();
  assert.equal(await run(`Array.from(document.querySelectorAll('#messages a')).some(a=>a.textContent==='产物')`),true,'local artifacts show clickable links');
  assert.equal(await run(`Array.from(document.querySelectorAll('#messages a')).some(a=>a.textContent==='危险')`),false,'script links are not allowed');
  await click('#toggle-process'); await wait();
  const rawUser = '  hi？\n\n**原文**\\\n<image>不改写</image>  \n';
  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:{messageId:'user-original',conversationId:'test-direct',seq:101,senderId:'test-me',type:'USER',content:${JSON.stringify(rawUser)},createdAt:'2026-09-05T02:02:00Z'}})`);
  await wait();
  assert.equal(await run(`Array.from(document.querySelectorAll('#messages .bubble')).some(b=>b.textContent===${JSON.stringify(rawUser)} && getComputedStyle(b).whiteSpace==='pre-wrap')`),true,'user\'s original text, whitespace and markup are all kept');
  await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:{messageId:'user-skip',conversationId:'test-direct',seq:102,senderId:'test-me',type:'USER',content:'SKIP',createdAt:'2026-09-05T02:03:00Z'}})`);
  await wait();
  assert.equal(await run(`Array.from(document.querySelectorAll('#messages .bubble')).some(b=>b.textContent==='SKIP')`),true,'SKIP sent by the user must not be hidden');
  await run(`window.adingTest.emit('onStoreEvent',{type:'message-delivery',conversationId:'test-direct',messageId:'user-original',status:'SENDING'})`);
  assert.equal(await run(`document.querySelector('[data-scroll-key="user-original"] .message-delivery')?.textContent`),'待同步','status shows next to the bubble while the message awaits upload');
  await run(`window.adingTest.emit('onStoreEvent',{type:'message-delivery',conversationId:'test-direct',messageId:'user-original',status:'FAILED'})`);
  assert.equal(await run(`document.querySelector('[data-scroll-key="user-original"] .message-delivery')?.textContent`),'发送失败','clearly shows failure when the cloud rejects');
  await run(`window.adingTest.emit('onStoreEvent',{type:'message-delivery',conversationId:'test-direct',messageId:'user-original',status:'SENT'})`);
  assert.equal(await run(`document.querySelector('[data-scroll-key="user-original"] .message-delivery')`),null,'pending sync notice is cleared after a successful upload');
  const countBeforeTimeCorrection = await run(`document.querySelectorAll('#messages .message').length`);
  await run(`{
    const sent = new Date(); sent.setHours(14, 51, 0, 0);
    window.adingTest.emit('onStoreEvent', {type:'message-times', conversationId:'test-direct', times:[{messageId:'user-original',createdAt:sent.toISOString()}]});
  }`);
  assert.equal(await run(`document.querySelector('[data-scroll-key="user-original"] time').textContent`), '14:51', 'after correcting the old cache, the current chat shows the send time directly');
  assert.equal(await run(`document.querySelectorAll('#messages .message').length`), countBeforeTimeCorrection, 'correcting the time does not insert the message twice');
  await writeFile(join(output,'original-user-message.png'),(await win.webContents.capturePage()).toPNG());
  const retained={messageId:'retained-question',conversationId:'test-direct',seq:103,senderId:'test-c',type:'USER',content:'样张未通过。是否允许改用程序处理？',createdAt:'2026-09-05T02:04:00Z',agentReply:{turnId:'retained-question',inputSeq:100,raw:'样张未通过。是否允许改用程序处理？',newerInput:true}};
  for(let i=0;i<2;i++)await run(`window.adingTest.emit('onStoreEvent',{type:'message',conversationId:'test-direct',message:${JSON.stringify(retained)}})`);
  await wait();
  assert.equal(await run(`Array.from(document.querySelectorAll('#messages .bubble')).filter(b=>b.textContent.includes('是否允许改用程序处理')).length`),1,'persisted retry notice does not produce duplicate bubbles');
  assert.equal(await run(`document.querySelector('[data-scroll-key="retained-question"] .bubble').textContent`),retained.content,'keeps the full original text without appending a notice about messages received during generation');
  await writeFile(join(output,'retained-question.png'),(await win.webContents.capturePage()).toPNG());
  await click('#tab-conversations'); await wait();
  assert.equal(await run(`document.querySelector('#quick-new-conversation')`),null,'quick start entry has been removed');
  assert.equal(await run(`document.querySelector('#new-group').getAttribute('aria-disabled')`),null,'new conversation is available when there is an Agent');
  // Picking only one Agent makes this a direct chat: the header must name the peer, not "all members"
  await click('#new-group'); await wait();
  await run(`document.querySelector('#group-member-list [data-user-id="test-c"] input').click()`); await wait();
  await click('#group-confirm'); await wait();
  assert.equal(await run(`document.querySelector('#conversation-title').textContent`),'小c','a draft with only one Agent selected shows that Agent\'s name in the header');
  assert.equal(await run(`document.querySelectorAll('#conversation-avatar .member-collage-cell').length`),0,'a single person does not use a group avatar');

  await click('#new-group'); await wait();
  await click('#group-select-all');
  await click('#group-confirm'); await wait();
  assert.equal(await run(`document.querySelector('#group-dialog').open`),false,'dialog closes once members are picked');
  assert.equal(await run(`document.activeElement.id`),'message-input','lands directly in the composer waiting for the first message');
  await writeFile(join(output,'new-conversation-draft.png'),(await win.webContents.capturePage()).toPNG());
  const quickContent='请帮我把这些票据按月份归档，统计各月的支出。';
  await run(`document.querySelector('#message-input').value=${JSON.stringify(quickContent)}; document.querySelector('#message-input').dispatchEvent(new Event('input')); document.querySelector('#composer').requestSubmit();`);
  await wait();
  const quickInput=await run('window.adingTest.createdInput()');
  assert.equal(quickInput.initialMessage,quickContent,'first message text is not rewritten');
  assert.equal(quickInput.autoTitle,true,'semantic naming is enabled');
  assert.equal(quickInput.name,'新会话','does not borrow truncated content before the semantic name is generated');
  assert.deepEqual([...quickInput.memberIds].sort(),await run(`window.ading.listContacts().then(items=>items.filter(u=>u.isAgent).map(u=>u.userId).sort())`),'select all only adds Agents: Agents cannot be in the same conversation as friends');
  // After submitting it must switch to the result page: showing another identical empty form gives no way to tell whether it worked.
  await click('#support-entry'); await wait();
  await run(`document.querySelector('#support-report-description').value='验证提交后的结果页是否出现'`);
  await click('#support-submit-report'); await wait();
  assert.equal(await run(`document.querySelector('#support-report-done').hidden`), false, 'issue report shows the result page');
  assert.equal(await run(`document.querySelector('#support-report-panel').hidden`), true, 'form is collapsed when the result page appears');
  assert.ok((await run(`document.querySelector('#support-done-id').textContent`)).includes('report_test_1'), 'result page gives the report number');
  await click('#support-report-again'); await wait();
  assert.equal(await run(`document.querySelector('#support-report-panel').hidden`), false, 'report another returns to the form');
  assert.equal(await run(`document.querySelector('#support-report-description').value`), '', 'returns to a clean form');

  await run(`document.querySelector('[data-support-tab="developer"]').click()`); await wait();
  await run(`document.querySelector('#support-developer-subject').value='主题';
             document.querySelector('#support-developer-content').value='内容';
             document.querySelector('#support-developer-reply-to').value='someone@example.com'`);
  await click('#support-email-developer'); await wait();
  assert.equal(await run(`document.querySelector('#support-developer-done').hidden`), false, 'contact developer also shows the result page');
  assert.equal(await run(`document.querySelector('#support-developer-panel').hidden`), true, 'form is collapsed when the result page appears');
  assert.ok((await run(`document.querySelector('#support-developer-done-detail').textContent`)).includes('someone@example.com'), 'when a reply method is left, says where the reply will go');
  // After switching away and back it should be a clean form, not stuck on the last result page
  await run(`document.querySelector('[data-support-tab="report"]').click()`); await wait();
  await run(`document.querySelector('[data-support-tab="developer"]').click()`); await wait();
  assert.equal(await run(`document.querySelector('#support-developer-done').hidden`), true, 'no longer stays on the result page after switching tabs');
  assert.equal(await run(`document.querySelector('#support-developer-panel').hidden`), false);
  await run(`document.querySelector('#support-dialog').close()`); await wait();

  // Settings: opened by clicking the title bar icon and name; two pages, language and about
  assert.equal(await run(`document.querySelector('#update-entry').hidden`), true, 'top right shows no update when there is no new version');
  await click('#app-settings-entry'); await wait();
  assert.equal(await run(`document.querySelector('#app-settings-dialog').open`), true, 'clicking the title bar icon opens settings');
  assert.equal(await run(`document.querySelector('.support-tab.active').dataset.settingsTab`), 'permissions', 'settings opens the permissions page by default, listed above language');
  assert.equal(await run(`document.querySelector('input[name="app-language"]:checked').value`), 'zh-CN', 'Chinese by default');
  assert.equal(await run(`document.documentElement.lang`), 'zh-CN');
  // Switching to English reloads the whole page, so it is tested separately in i18n-ui.test.cjs
  assert.equal(await run(`document.querySelector('[data-settings-tab="computer"]')`), null, 'settings has no computer control page');
  await run(`window.adingTest.emit('onComputerPermissionMissing', {kind:'accessibility',message:'x'})`); await wait();
  assert.ok((await run(`document.querySelector('#app-toast').textContent`)).includes('「隐私与安全性 → 辅助功能」里允许阿钉'), 'the first missing permission explains where to allow it');
  await run(`document.querySelector('#app-toast').hidden=true`);
  await click('[data-settings-tab="about"]'); await wait();
  assert.equal(await run(`document.querySelector('#settings-language-panel').hidden`), true);
  assert.equal(await run(`document.querySelector('#settings-about-version').textContent`), '版本 0.4.0-2026.9.16-231949-dev');
  assert.equal(await run(`document.querySelector('#settings-install-update').hidden`), true, 'no update button when there is no new version');
  await click('#settings-check-update'); await wait();
  assert.equal(await run(`document.querySelector('#settings-update-status').textContent`), '已经是最新版本。');
  // There are several seconds between download finishing and verification finishing; an install sent by the main process during that time is preparing: no dialog.
  // Popping the dialog once too early pins the text to "open installer"; when verification passes and it becomes restart, it does not refresh,
  // and the user clicks through the false claim "this computer cannot replace automatically" (that happened on every upgrade of 0.6.0 on 2026-09-23).
  const preparing = { phase: 'ready', install: 'preparing', file: '/tmp/x.dmg', checkedAt: '2026-09-16T00:00:00Z', update: { version: '0.4.0-2026.9.17-070000-dev', url: 'https://example.com/x.dmg', sha256: 'a'.repeat(64), signed: false, mandatory: false, fullPackageRequired: false, gray: true } };
  await run(`window.adingTest.emit('onUpdateState', ${JSON.stringify(preparing)})`); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), false, 'no dialog while verifying the installer');
  assert.ok((await run(`document.querySelector('#settings-update-status').textContent`)).includes('正在核对安装包'), 'says verification is in progress while verifying');
  await run(`window.adingTest.emit('onUpdateState', ${JSON.stringify({ ...preparing, install: 'restart' })})`); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), true, 'dialog appears only after verification completes');
  assert.equal(await run(`document.querySelector('#update-ready-action').textContent`), '重启更新', 'when auto replace is possible, the dialog offers restart to update');
  assert.equal(await run(`document.querySelector('#update-ready-copy').textContent.includes('打开安装包')`), false, 'when auto replace is possible, it does not say to install manually');
  // When the status flips while the dialog is open (a different version, the prepared copy invalidated), the text and buttons must refresh with it
  const manual = { ...preparing, install: 'manual', installNote: '阿钉正从安装盘里运行，无法自动替换', update: { ...preparing.update, version: '0.4.0-2026.9.17-075000-dev' } };
  await run(`window.adingTest.emit('onUpdateState', ${JSON.stringify(manual)})`); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-action').textContent`), '打开安装包', 'open installer appears only when auto replace is truly impossible');
  assert.ok((await run(`document.querySelector('#update-ready-copy').textContent`)).includes('安装盘'), 'manual install explains the reason');
  await run(`window.adingTest.emit('onUpdateState', ${JSON.stringify({ ...manual, install: 'restart' })})`); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-action').textContent`), '重启更新', 'when status changes while the dialog is open, the button refreshes');
  assert.equal(await run(`document.querySelector('#update-ready-copy').textContent.includes('打开安装包')`), false, 'when status changes while the dialog is open, stale text does not stay on screen');
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), true, 'refreshing the text does not open the dialog again');
  await click('#update-ready-later'); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), false);
  const readyUpdate = { phase: 'ready', install: 'restart', file: '/tmp/x.dmg', checkedAt: '2026-09-16T00:00:00Z', update: { version: '0.4.0-2026.9.17-080000-dev', url: 'https://example.com/x.dmg', sha256: 'a'.repeat(64), signed: false, mandatory: false, fullPackageRequired: false, gray: true } };
  await run(`window.adingTest.emit('onUpdateState', ${JSON.stringify(readyUpdate)})`); await wait();
  assert.equal(await run(`document.querySelector('#settings-install-update').hidden`), false, 'update button appears when there is a new version');
  assert.equal(await run(`document.querySelector('#update-entry').hidden`), false, 'top right always shows the update version when there is a new version');
  assert.equal(await run(`document.querySelector('#app-toast').hidden`), true, 'new version no longer shows a bottom toast');
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), true, 'asks with a dialog after the new version is downloaded');
  assert.ok((await run(`document.querySelector('#update-ready-copy').textContent`)).includes('0.4.0-2026.9.17-080000-dev'));
  assert.equal(await run(`document.querySelector('#update-ready-action').textContent`), '重启更新');
  await writeFile(join(output, 'update-ready.png'), (await win.webContents.capturePage()).toPNG());
  await click('#update-ready-later'); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), false);
  await run(`window.adingTest.emit('onUpdateState', ${JSON.stringify(readyUpdate)})`); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), false, 'the same version prompts only once');
  await writeFile(join(output, 'app-settings-about.png'), (await win.webContents.capturePage()).toPNG());
  await click('#settings-install-update'); await wait();
  await run(`document.querySelector('#app-settings-dialog').close()`); await wait();
  await click('#update-entry'); await wait();
  assert.equal(await run(`window.adingTest.updateInstalls()`), 2, 'both the update button and the top right entry trigger restart to update');
  await run(`window.adingTest.emit('onUpdateState', {phase:'up-to-date',checkedAt:'2026-09-16T00:00:00Z'})`); await wait();
  await run(`window.adingTest.emit('onUpdateState', {phase:'error',message:'下载更新失败：服务器返回 403',checkedAt:'2026-09-16T00:00:00Z'})`); await wait();
  assert.ok((await run(`document.querySelector('#app-toast').textContent`)).includes('下载更新失败：服务器返回 403'), 'automatic check failure must show the reason');
  const nextReady = {...readyUpdate, update: {...readyUpdate.update, version: '0.4.0-2026.9.18-090000-dev'}};
  await run(`window.adingTest.emit('onUpdateState', ${JSON.stringify(nextReady)})`); await wait();
  assert.equal(await run(`document.querySelector('#update-ready-dialog').open`), true, 'a newer version prompts again');
  const installsBefore = await run(`window.adingTest.updateInstalls()`);
  await click('#update-ready-action'); await wait();
  assert.equal(await run(`window.adingTest.updateInstalls()`), installsBefore + 1, 'clicking restart to update in the dialog installs');
  await run(`window.adingTest.emit('onUpdateState', {phase:'up-to-date',checkedAt:'2026-09-16T00:00:00Z'})`); await wait();

  assert.deepEqual(errors, []);
  assert.equal(await run(`document.querySelector('#app-toast').textContent.includes('is not a function')`), false);
  // English UI: Agents' Chinese default names are shown as English names, so Chinese names like "小c" do not appear in the UI
  {
    await run(`localStorage.setItem('ading.language','en')`);
    const enWin=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    await enWin.loadFile(join(__dirname,'../src/index.html'));
    const enRun=source=>enWin.webContents.executeJavaScript(source);
    await new Promise(r=>setTimeout(r,300));
    await enRun(`document.querySelector('#tab-contacts').click()`); await new Promise(r=>setTimeout(r,200));
    assert.deepEqual(await enRun(`Array.from(document.querySelectorAll('.contact-list-item .contact-name')).map(el => el.textContent).sort()`), ['Cody','Quincy','Quinn'], 'English UI uses English names');
    assert.equal(await enRun(`/小c|小q/.test(document.querySelector('#contact-list').textContent)`), false, 'contact list has no Chinese default names');
    await writeFile(join(output, 'contacts-en.png'), (await enWin.webContents.capturePage()).toPNG());
    await enRun(`localStorage.setItem('ading.language','zh-CN')`);
    enWin.destroy();
  }
  const emptyWin=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-empty'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await emptyWin.loadFile(join(__dirname,'../src/index.html'));
  const emptyRun=source=>emptyWin.webContents.executeJavaScript(source);
  await emptyRun('new Promise(r=>setTimeout(r,500))');
  assert.equal(await emptyRun(`document.querySelector('#conversation-name-center').textContent`),'新会话');
  assert.equal(await emptyRun(`document.querySelector('#conversation-title').textContent`),'全体成员');
  assert.equal(await emptyRun(`document.querySelector('#message-input').disabled`),false,'can type right away when starting with an empty list');
  assert.equal(await emptyRun(`window.ading.listConversations().then(t=>t.length)`),0,'no empty conversation is created before a message is sent');
  assert.equal(await emptyRun(`document.querySelector('#contact-list').textContent.includes('从联系人发起聊天')`),false);
  await writeFile(join(output,'empty-default-conversation.png'),(await emptyWin.webContents.capturePage()).toPNG());
  await emptyRun(`document.querySelector('#message-input').value='默认草稿内容';document.querySelector('#tab-contacts').click();document.querySelector('#tab-conversations').click();`);
  assert.equal(await emptyRun(`document.querySelector('#conversation-name-center').textContent`),'新会话','returning to the empty conversation page is still the default draft');
  assert.equal(await emptyRun(`document.querySelector('#message-input').value`),'默认草稿内容','switching pages does not lose unsent content');
  await emptyRun(`document.querySelector('#composer').requestSubmit();new Promise(r=>setTimeout(r,500))`);
  const automatic=await emptyRun('window.adingTest.createdInput()');
  assert.deepEqual([...automatic.memberIds].sort(),['test-c','test-q','test-qcn']);assert.equal(automatic.autoTitle,true);
  await emptyRun(`window.adingTest.clearConversations();new Promise(r=>setTimeout(r,500))`);
  assert.equal(await emptyRun(`document.querySelector('#conversation-name-center').textContent`),'新会话','returns to the default draft after the last conversation is deleted');
  assert.equal(await emptyRun(`document.querySelector('#message-input').disabled`),false);
  assert.equal(await emptyRun(`document.querySelector('#messages').textContent.includes('讨论目标')`),false,'old messages of the deleted conversation are cleared');
  emptyWin.destroy();

  // No Agent yet: both entries that start a conversation are greyed out, clicking does nothing, and hovering explains why
  const noAgentWin=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-no-agents'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await noAgentWin.loadFile(join(__dirname,'../src/index.html'));
  const noAgentRun=source=>noAgentWin.webContents.executeJavaScript(source);
  await noAgentRun('new Promise(r=>setTimeout(r,500))');
  assert.equal(await noAgentRun(`document.querySelector('#new-group').getAttribute('aria-disabled')`),'true','new conversation entry is greyed out when there is no Agent');
  await noAgentRun(`document.querySelector('#new-group').click();new Promise(r=>setTimeout(r,200))`);
  assert.equal(await noAgentRun(`document.querySelector('#group-dialog').open`),false,'clicking the greyed-out new conversation does not open the dialog');
  for (const selector of ['#new-group']) {
    const tip = await noAgentRun(`document.querySelector('${selector}').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));new Promise(r=>setTimeout(()=>{const t=document.querySelector('#icon-tooltip');r(t.matches(':popover-open')?t.textContent:'');document.querySelector('${selector}').dispatchEvent(new PointerEvent('pointerout',{bubbles:true}));},400))`);
    assert.equal(tip,'至少添加一个 Agent',`${selector} tooltip explains the reason`);
  }
  await writeFile(join(output,'no-agent-conversation-start.png'),(await noAgentWin.webContents.capturePage()).toPNG());
  noAgentWin.destroy();

  // Startup check in progress: the refresh button spins and cannot be clicked, and recovers when done
  const slowWin=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-slow-verify'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await slowWin.loadFile(join(__dirname,'../src/index.html'));
  const slowRun=source=>slowWin.webContents.executeJavaScript(source);
  const recheckState=`(()=>{const b=document.querySelector('#agent-recheck');return [b.disabled,b.classList.contains('spinning')];})()`;
  await slowRun('new Promise(r=>setTimeout(r,300))');
  assert.deepEqual(await slowRun(recheckState),[true,true],'button spins during the directory refresh at startup');
  await slowRun('new Promise(r=>setTimeout(r,2000))');
  assert.deepEqual(await slowRun(recheckState),[true,true],'button keeps spinning while checking each vendor');
  await slowRun(`document.querySelector('#agent-recheck').click()`);
  await slowRun('new Promise(r=>setTimeout(r,3500))');
  assert.deepEqual(await slowRun(recheckState),[false,false],'clickable again after checking finishes');
  slowWin.destroy();
  // Native mouse sequences, including both click events, must survive read receipts
  // and the contact-list redraw caused by the first click.
  const unreadWin = new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await unreadWin.loadFile(join(__dirname,'../src/index.html'));
  const unreadRun = source => unreadWin.webContents.executeJavaScript(source);
  const unreadWait = (ms=100) => unreadRun(`new Promise(r=>setTimeout(r,${ms}))`);
  const unreadClick = selector => unreadRun(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const currentUnreadChat = () => unreadRun(`document.querySelector('#conversation-name-center').textContent`);
  const seedUnread = entries => unreadRun(`window.adingTest.setUnreadConversations(${JSON.stringify(entries)})`).then(unreadWait);
  const nativeDoubleClick = async () => {
    const point = await unreadRun(`(()=>{const r=document.querySelector('.contact-list-item[data-user-id="test-c"] .contact-name').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const clickCount of [1, 2]) {
      unreadWin.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount,...point});
      unreadWin.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount,...point});
      await unreadWait();
    }
  };
  await unreadWait();
  await unreadClick('#tab-contacts');
  await seedUnread([{id:'test-direct',time:'2026-09-05T02:00:00Z'},{id:'test-solo-conversation',time:'2026-09-05T03:00:00Z'}]);
  await unreadRun(`window.unreadClickEvents=[];document.querySelector('#contact-list').addEventListener('click',e=>window.unreadClickEvents.push('click:'+e.detail));document.querySelector('#contact-list').addEventListener('dblclick',e=>window.unreadClickEvents.push('dblclick:'+e.detail));`);
  await nativeDoubleClick();
  assert.deepEqual(await unreadRun('window.unreadClickEvents'),['click:1','click:2','dblclick:2'],'a real double click includes two clicks; contact row updates do not lose the dblclick');
  assert.equal(await currentUnreadChat(),'第二条单聊','after the first click clears the latest unread, the double click still lands on the original latest unread');
  assert.equal(await unreadRun(`document.querySelectorAll('#conversation-switcher-button .conversation-unread-dot').length`),1,'title bar shows a red dot when other conversations are unread');
  await unreadClick('#conversation-switcher-button');
  assert.equal(await unreadRun(`document.querySelectorAll('.conversation-switcher-item[data-conversation-id="test-direct"] .conversation-unread-dot').length`),1,'unread menu items show a red dot');
  assert.equal(await unreadRun(`document.querySelectorAll('.conversation-switcher-item.active .conversation-unread-dot').length`),0,'the current read item has no red dot');
  await unreadWait(300);
  const unreadDotLayout = await unreadRun(`(()=>{const dot=document.querySelector('.conversation-switcher-item .conversation-unread-dot');const r=dot.getBoundingClientRect();const p=dot.parentElement.getBoundingClientRect();return {width:r.width,height:r.height,inside:r.left>=p.left&&r.right<=p.right,red:getComputedStyle(dot).backgroundColor};})()`);
  assert.deepEqual(unreadDotLayout,{width:6,height:6,inside:true,red:'rgb(239, 68, 68)'},'menu red dot size, color and layout are correct');
  await writeFile(join(process.env.ADING_UI_CAPTURE_DIR || output,'unread-navigation-zh.png'),(await unreadWin.webContents.capturePage()).toPNG());
  await unreadClick('#conversation-switcher-button');
  await nativeDoubleClick();
  assert.equal(await currentUnreadChat(),'单聊','the next double click enters the remaining unread');
  assert.equal(await unreadRun(`document.querySelectorAll('#conversation-switcher-button .conversation-unread-dot').length`),0,'title bar red dot disappears after all candidates are read');
  await nativeDoubleClick();
  assert.equal(await currentUnreadChat(),'单聊','keeps single-click focus when nothing is unread');
  await unreadClick('#conversation-switcher-button');
  await seedUnread([{id:'test-solo-conversation',time:'2026-09-05T04:00:00Z'}]);
  assert.equal(await unreadRun(`document.querySelectorAll('.conversation-switcher-item .conversation-unread-dot').length`),1,'new unread synced while the menu is open refreshes immediately');
  await seedUnread([]);
  assert.equal(await unreadRun(`document.querySelectorAll('.conversation-switcher-item .conversation-unread-dot').length`),0,'read sync while the menu is open clears the red dot');
  await seedUnread([{id:'test-solo-conversation',time:'2026-09-05T05:00:00Z'}]);
  await unreadClick('#conversation-switcher-button');
  const unreadReloaded = new Promise(resolve => unreadWin.webContents.once('did-finish-load',resolve));
  await unreadClick('input[name="app-language"][value="en"]');
  await unreadReloaded;
  await unreadWait(300);
  await unreadRun(`document.querySelector('#app-settings-dialog').close()`);
  await unreadClick('#tab-contacts');
  await unreadClick('.contact-list-item[data-user-id="test-c"] .contact-button');
  await seedUnread([{id:'test-direct',time:'2026-09-05T05:00:00Z'}]);
  await unreadClick('#conversation-switcher-button');
  await unreadWait(300);
  assert.equal(await unreadRun(`document.querySelector('#conversation-switcher-button .conversation-unread-dot').getAttribute('aria-label')`),'Unread messages','red dot supports English accessibility text');
  await writeFile(join(process.env.ADING_UI_CAPTURE_DIR || output,'unread-navigation-en.png'),(await unreadWin.webContents.capturePage()).toPNG());
  // The selected conversation must remain unread while the app is in the
  // background; returning to the visible chat reads it, hidden tabs don't.
  await unreadClick('#conversation-switcher-button');
  await unreadClick('.contact-list-item[data-user-id="test-c"] .contact-button');
  await unreadRun(`window.adingTest.openNotification('test-direct')`);await unreadWait();
  const selectedUnreadId='test-direct';
  await unreadRun(`window.adingTest.setWindowActive(false)`);
  const beforeBackgroundRead=await unreadRun(`window.adingTest.readPosition(${JSON.stringify(selectedUnreadId)})`);
  const incomingSeq=await unreadRun(`window.adingTest.incomingMessage(${JSON.stringify(selectedUnreadId)})`);
  await unreadWait();
  assert.equal(await unreadRun(`window.adingTest.readPosition(${JSON.stringify(selectedUnreadId)})`),beforeBackgroundRead,'conversation selected in the background stays unread');
  await unreadRun(`window.adingTest.setWindowActive(true)`);await unreadWait();
  assert.equal(await unreadRun(`window.adingTest.readPosition(${JSON.stringify(selectedUnreadId)})`),incomingSeq,'marked read only after returning to the foreground and loading the content');
  await unreadClick('#tab-knowledge');
  const hiddenSeq=await unreadRun(`window.adingTest.incomingMessage(${JSON.stringify(selectedUnreadId)})`);await unreadWait();
  assert.equal(await unreadRun(`window.adingTest.readPosition(${JSON.stringify(selectedUnreadId)})`),incomingSeq,'the knowledge page cannot mark a hidden conversation read');
  await unreadRun(`window.adingTest.openNotification(${JSON.stringify(selectedUnreadId)})`);await unreadWait();
  assert.equal(await unreadRun(`document.querySelector('#tab-conversations').classList.contains('active')`),true,'clicking a system notification opens the conversation page');
  assert.equal(await unreadRun(`window.adingTest.readPosition(${JSON.stringify(selectedUnreadId)})`),hiddenSeq,'read position after clicking the notification is correct');
  await unreadRun(`localStorage.setItem('ading.language','zh-CN')`);
  unreadWin.destroy();

  console.log(`UI regression checks passed. Screenshots: ${output}`);
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
