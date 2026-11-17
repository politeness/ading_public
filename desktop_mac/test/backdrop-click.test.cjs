const {mkdtemp}=require('./tmp.cjs');
const {app,BrowserWindow}=require('electron');
const {readFile}=require('node:fs/promises');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

// Closing a dialog by clicking the backdrop must be a "complete click": both press and release land on the backdrop.
// Pressing inside the card and releasing outside it (even outside the window) is text selection or a slip, and must not close the dialog.
(async()=>{
 const output=await mkdtemp(join(tmpdir(),'ading-backdrop-'));
 app.setPath('userData',join(output,'profile'));await app.whenReady();
 const win=new BrowserWindow({show:false,width:1220,height:820,webPreferences:{preload:join(__dirname,'ui-preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});
 await win.loadFile(join(__dirname,'../src/index.html'));
 const run=s=>win.webContents.executeJavaScript(s).catch(e=>{console.error(s,errors);throw e;});
 const tick=(ms=60)=>run(`new Promise(r=>setTimeout(r,${ms}))`);
 const settle=()=>tick(400);                       // The close animation is 190ms; wait for it to finish before checking open
 const mouse=(type,x,y)=>win.webContents.sendInputEvent({type,x:Math.round(x),y:Math.round(y),button:'left',clickCount:1});
 const drag=async(from,to)=>{mouse('mouseDown',from.x,from.y);await tick();mouse('mouseUp',to.x,to.y);await settle();};
 await settle();

 const center=sel=>run(`(()=>{
  const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  if(!r.width||!r.height)throw new Error('Trigger button is not visible: '+${JSON.stringify(sel)});
  return {x:r.left+r.width/2,y:r.top+r.height/2};
 })()`);
 // The card can only be measured after the dialog opens. The card selector is looked up inside the dialog: several dialogs reuse the same card class name.
 // The backdrop point must avoid the trigger button - inside the button's bounds OverlayController treats it as a click on the toggle anchor.
 const points=(dialogSel,cardSel,anchorSel)=>run(`(()=>{
  const dialog=document.querySelector(${JSON.stringify(dialogSel)});
  const card=dialog.querySelector(${JSON.stringify(cardSel)}).getBoundingClientRect();
  const anchor=document.querySelector(${JSON.stringify(anchorSel)}).getBoundingClientRect();
  if(!card.width||!card.height)throw new Error('Card has no layout: '+${JSON.stringify(cardSel)});
  const hit=(x,y,r)=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
  const inside={x:card.left+10,y:card.top+10};
  const at=document.elementFromPoint(inside.x,inside.y);
  if(!at||at===dialog||!dialog.contains(at))throw new Error('Failed to pick a point inside the card: '+${JSON.stringify(cardSel)});
  for(const [x,y] of [[innerWidth-40,40],[innerWidth-40,innerHeight-40],[40,40],[card.right+70,card.top+20]])
   if(!hit(x,y,card)&&!hit(x,y,anchor))return {inside,outside:{x,y}};
  throw new Error('No free point found on the backdrop: '+${JSON.stringify(dialogSel)});
 })()`);

 const scenario=async(label,dialogSel,cardSel,anchorSel)=>{
  const isOpen=()=>run(`document.querySelector(${JSON.stringify(dialogSel)}).open`);
  const anchor=await center(anchorSel);
  const open=async()=>{if(!await isOpen())await drag(anchor,anchor);assert.equal(await isOpen(),true,`${label}: clicking the trigger button opens it`);};
  const offscreen={x:-60,y:-60};

  await open();
  const {inside,outside}=await points(dialogSel,cardSel,anchorSel);
  await drag(inside,outside);
  assert.equal(await isOpen(),true,`${label}: press in card, release on backdrop does not close`);
  await drag(inside,offscreen);
  mouse('mouseMove',inside.x,inside.y);await tick();
  assert.equal(await isOpen(),true,`${label}: press in card, release outside the window does not close`);
  await drag(outside,inside);
  assert.equal(await isOpen(),true,`${label}: press on backdrop, release in card also does not close`);
  await drag(inside,inside);
  assert.equal(await isOpen(),true,`${label}: clicking inside the card does not close`);
  await drag(outside,outside);
  assert.equal(await isOpen(),false,`${label}: closes only when both press and release are on the backdrop`);

  await open();
  await drag(outside,outside);
  assert.equal(await isOpen(),false,`${label}: can reopen after closing, and a backdrop click still closes it normally`);
 };

 await scenario('Profile details','#contact-detail-dialog','#contact-detail-form','#current-user-rail-avatar');
 await scenario('Help & support','#support-dialog','.support-card','#support-entry');

 // The close button must not be broken by this change
 await run(`document.querySelector('#current-user-rail-avatar').click()`);await settle();
 assert.equal(await run(`document.querySelector('#contact-detail-dialog').open`),true,'reopen profile details to verify the close button');
 await run(`document.querySelector('#contact-detail-close').click()`);await settle();
 assert.equal(await run(`document.querySelector('#contact-detail-dialog').open`),false,'the close button still works');

 // All seven dialogs go through the shared helper; don't hand-write event.target === dialog again
 const source=await readFile(join(__dirname,'../src/renderer.ts'),'utf8');
 assert.ok(!/event\.target === \w*[Dd]ialog/.test(source),'renderer no longer hand-writes backdrop click checks');
 for(const dialog of ['supportDialog','contactDetailDialog','readonlyProfileDialog','avatarPreviewDialog','deleteConfirmDialog','reportConfirmDialog','appSettingsDialog'])
  assert.ok(source.includes(`closeOnBackdropClick(${dialog}`),`${dialog} uses the shared backdrop-click close`);

 assert.deepEqual(errors,[]);
 console.log('backdrop-click: a backdrop click needs both press and release on the backdrop; dragging out of the card/window no longer closes the dialog by mistake');
 win.destroy();app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
