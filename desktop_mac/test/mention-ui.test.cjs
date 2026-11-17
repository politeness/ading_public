const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');const {tmpdir}=require('node:os');const {writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-mention-ui-'));app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),additionalArguments:['--ading-test-mentions'],contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 try{
  await win.loadFile(join(__dirname,'../src/index.html'));
  const run=s=>win.webContents.executeJavaScript(s),wait=()=>run('new Promise(r=>setTimeout(r,300))');
  const click=async s=>{try{await run(`document.querySelector(${JSON.stringify(s)}).click()`)}catch(e){throw new Error(`click ${s}: ${e.message}`)}};
  const shot=async name=>{if(process.env.ADING_SHOT_DIR)await writeFile(join(process.env.ADING_SHOT_DIR,name),(await win.webContents.capturePage()).toPNG());};
  await wait();await run(`window.adingTest.setWindowActive(true)`);await click('[data-conversation-id="test-direct"] .conversation-list-button');await wait();

  // Unviewed conversation: red flag in the list
  assert.equal(await run(`document.querySelector('[data-conversation-id="test-people"] .mention-flag')?.textContent`),'[有人@我]','List shows someone @-mentioned me');
  await shot('mention-list.png');

  // On open: the flag disappears; when that message is off-screen a floating button appears, and clicking it jumps there and highlights it
  await click('[data-conversation-id="test-people"] .conversation-list-button');await wait();await wait();
  assert.equal(await run(`!!document.querySelector('[data-conversation-id="test-people"] .mention-flag')`),false,'Flag gone once read');
  assert.equal(await run(`document.querySelector('#mention-jump').hidden`),false,'Button shown when that message is off-screen');
  const mineSpan=`document.querySelector('[data-scroll-key="people-3"] .mention-me')`;
  assert.equal(await run(`${mineSpan}?.textContent`),'@测试用户','@-mentions of me are prominently highlighted');
  assert.equal(await run(`document.querySelector('[data-scroll-key="people-3"] .mention:not(.mention-me)')?.textContent`),'@Bob','@-mentions of others are highlighted normally');
  await shot('mention-jump.png');
  await click('#mention-jump');await wait();
  assert.equal(await run(`document.querySelector('#mention-jump').hidden`),true,'Dismissed after clicking');
  assert.equal(await run(`document.querySelector('[data-scroll-key="people-3"]').classList.contains('mention-target')`),true,'That message flashes');
  const visible=await run(`(()=>{const a=document.querySelector('[data-scroll-key="people-3"]').getBoundingClientRect(),b=document.querySelector('#messages').getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom})()`);
  assert.equal(visible,true,'Jumped to that message');

  // Input box: groups with other humans can @ all humans, expanded to each human on send, excluding Agents and yourself
  const type=text=>run(`(()=>{const input=document.querySelector('#message-input');input.focus();input.value=${JSON.stringify(text)};input.selectionStart=input.selectionEnd=input.value.length;input.dispatchEvent(new Event('input'))})()`);
  await type('@');await wait();
  const options=await run(`[...document.querySelectorAll('.mention-menu button')].map(b=>b.textContent)`);
  assert.equal(options[0],'所有真人','@all humans is listed first');
  assert.ok(options.includes('Alice')&&options.includes('Bob'),'Each person can also be @-mentioned individually');
  await shot('mention-menu.png');
  await click('.mention-menu button');await wait();
  assert.equal(await run(`document.querySelector('#message-input').value`),'@所有真人 ');
  await run(`document.querySelector('#message-input').value+='开会了';document.querySelector('#message-input').dispatchEvent(new Event('input'))`);
  await run(`document.querySelector('#composer').requestSubmit()`);await wait();
  const sent=await run(`window.adingTest.sentMessages().at(-1)`);
  assert.deepEqual([...sent.mentions].sort(),['test-friend-a','test-friend-b'],'Expanded to all other humans');

  // Clicking a name on a group message: @-mention them at the cursor without opening the profile; counts as a real @ on send
  await type('你好');await wait();
  await click('[data-scroll-key="people-3"] .message-sender');await wait();
  assert.equal(await run(`document.querySelector('#message-input').value`),'你好@Alice ','Name inserted at the cursor');
  assert.equal(await run(`document.querySelector('#readonly-profile-dialog').open`),false,'Clicking a name does not open the profile');
  assert.equal(await run(`document.activeElement.id`),'message-input','Focus returns to the input box');
  await run(`document.querySelector('#composer').requestSubmit()`);await wait();
  assert.deepEqual([...(await run(`window.adingTest.sentMessages().at(-1)`)).mentions],['test-friend-a'],'Counts as @ on send');
  // The avatar still opens the profile
  await click('[data-scroll-key="people-3"] .message-avatar');await wait();
  assert.equal(await run(`document.querySelector('#readonly-profile-dialog').open`),true,'Clicking the avatar opens the profile');
  await run(`document.querySelector('#readonly-profile-dialog').close()`);

  // The reply button is to the right of the message, bottom-aligned with it
  const replyBox=await run(`(()=>{const a=document.querySelector('[data-scroll-key="people-3"]'),r=a.querySelector('.message-reply').getBoundingClientRect(),b=a.querySelector('.bubble').getBoundingClientRect();return {gap:r.left-b.right,bottom:r.bottom-b.bottom}})()`);
  assert.ok(replyBox.gap>=0&&replyBox.gap<=12,'Button hugs the right of the message');
  assert.ok(Math.abs(replyBox.bottom)<1,'Button bottom aligns with message bottom');

  // Replying to someone's message: show the quote, auto-@ at the start, send with the original message; cancelling also removes the auto-added @
  await type('');await wait();
  await click('[data-scroll-key="people-3"] .message-reply');await wait();
  assert.equal(await run(`document.querySelector('#message-input').value`),'@Alice ','Reply auto-@-mentions the sender');
  assert.equal(await run(`document.querySelector('#composer-reply').hidden`),false,'Quote shown above the input box');
  assert.match(await run(`document.querySelector('#composer-reply').textContent`),/Alice.*帮忙看一下/,'Quote shows sender and original text');
  await shot('reply-composer.png');
  await click('#composer-reply button');await wait();
  assert.equal(await run(`document.querySelector('#message-input').value`),'','Cancelling removes the auto @');
  assert.equal(await run(`document.querySelector('#composer-reply').hidden`),true,'Quote no longer shown after cancelling');
  await click('[data-scroll-key="people-3"] .message-reply');await wait();
  await run(`document.querySelector('#message-input').value+='收到';document.querySelector('#message-input').dispatchEvent(new Event('input'))`);
  await run(`document.querySelector('#composer').requestSubmit()`);await wait();
  const replied=await run(`window.adingTest.sentMessages().at(-1)`);
  assert.equal(replied.replyTo,'people-3','Send carries the original message ID');
  assert.equal(replied.quote.senderId,'test-friend-a','Snapshot records the sender');
  assert.deepEqual([...replied.mentions],['test-friend-a'],'Reply counts as @');
  assert.equal(await run(`document.querySelector('#composer-reply').hidden`),true,'Quote disappears after sending');
  assert.match(await run(`[...document.querySelectorAll('.message-quote')].at(-1)?.textContent`),/帮忙看一下/,'Sent message shows the quote');
  await run(`[...document.querySelectorAll('.message-quote')].at(-1).click()`);await wait();
  assert.equal(await run(`document.querySelector('[data-scroll-key="people-3"]').classList.contains('mention-target')`),true,'Clicking the quote jumps back to the original message');
  await shot('reply-sent.png');

  // Not applicable in direct chats and Agent-only groups
  await click('[data-conversation-id="test-group"] .conversation-list-button');await wait();
  await type('@');await wait();
  assert.equal(await run(`[...document.querySelectorAll('.mention-menu button')].some(b=>b.textContent==='所有真人')`),false,'Agent-only groups do not have this option');
  await type('');

  // A space right after @ shows no options; spaces inside names are unaffected
  await click('[data-conversation-id="test-people"] .conversation-list-button');await wait();
  await type('@ ');await wait();
  assert.equal(await run(`document.querySelector('.mention-menu').hidden`),true,'A space right after @ shows no options');
  await type('@Ali');await wait();
  assert.equal(await run(`document.querySelector('.mention-menu').hidden`),false,'Typing a name still shows options');
  await type('');

  // No selection needed in direct chats
  await click('[data-conversation-id="test-direct"] .conversation-list-button');await wait();
  await type('@');await wait();
  assert.equal(await run(`document.querySelector('.mention-menu').hidden`),true,'Direct chats show no options');
  await type('');
  console.log('mention ui: list flag, jump button, highlight and @ all people');
 }finally{win.destroy();}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
