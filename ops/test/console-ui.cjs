const {app,BrowserWindow}=require('electron');
// When an assertion fails, finally destroys the window first: without handling this event the app would exit with 0 and the failure would count as a pass
app.on('window-all-closed',()=>{});
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const os=require('node:os');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ading-ops-ui-'));
 app.setPath('userData',path.join(directory,'profile'));
 const root=path.resolve(__dirname,'../src/main/resources/static');
 const page=items=>({page:1,size:20,total:items.length,items});
 const requests=[];
 const statusChanges=[];
 const tagChanges=[];
 let rejectTagChange=false;
 const feedbackRows=[{reportId:'report_1',status:'PENDING',description:'<img src=x onerror=alert(1)>发送按钮没有反应',occurredAt:'2026-11-02T09:00:00',submittedAt:'2026-11-02T09:01:00',appVersion:'0.10.1-pre',channel:'pre',platform:'darwin',arch:'arm64',mode:'local',objectPrefix:'bug_report/x',attachments:[{id:1,kind:'screenshot',name:'截图.png',contentType:'image/png',sizeBytes:68},{id:2,kind:'log_archive',name:'日志.tar.gz',contentType:'application/gzip',sizeBytes:2048}]}];
 const responses={
  '/api/me':{username:'ops-test',displayName:'运维测试',zone:'Asia/Shanghai'},
  '/api/summary':{userCount:12,deviceCount:9,terminalCount:8,onlineTerminalCount:3,dauToday:5,dauYesterday:4,dauUsersToday:2,dauUsersYesterday:1,mau30:9,mauUsers30:6,mauMonth:8,earliestStatHour:'2026-10-30T00:00:00',unavailable:[]},
  '/api/active':{granularity:'day',days:30,earliestStatHour:'2026-10-30T00:00:00',points:[{bucket:'2026-10-30',total:5,loggedIn:3,standalone:2,users:2},{bucket:'2026-10-31',total:0,loggedIn:0,standalone:0,users:0},{bucket:'2026-11-01',total:7,loggedIn:5,standalone:2,users:4}],totals:{dauToday:5,dauYesterday:4,avg7:3,mau30:9,mauMonth:8,dauUsersToday:2,dauUsersYesterday:1,avgUsers7:1.5,mauUsers30:6,mauUsersMonth:5}},
  '/api/users':page([{userId:'test',username:'human',displayName:'测试用户',status:'ACTIVE',phone:'13800138000',email:'human@example.com',registeredAt:'2026-11-01T10:20:00',terminalCount:3,agentCount:0,activeTerminalCount:1,online:true,tags:['PRE_GRAY','MAINLAND_ADD_FRIEND']}]),
  '/api/agents':page([{userId:'agent',username:'agent',displayName:'测试 Agent',agentType:'CODEX',owner:'test',ownerName:'测试用户',status:'ACTIVE'}]),
  '/api/contacts':page([{contactId:'contact_1',subject:'想合作',content:'正文内容',replyTo:'reader@example.com',submittedAt:'2026-11-02T09:01:00',appVersion:'0.10.1',channel:'release',platform:'darwin',arch:'arm64',mode:'remote',attachments:[{id:3,kind:'file',name:'方案.pdf',contentType:'application/pdf',sizeBytes:4096}]}]),
  '/api/devices':page([{deviceUuid:'terminal-test',deviceType:'mac',name:'测试电脑',appVersion:'0.11.0',osVersion:'macOS 26.1',status:'OFFLINE',firstSeenAt:'2026-11-01T08:00:00',agents:['codex','qoder'],accounts:[{userId:'test',username:'human',displayName:'测试用户',online:false},{userId:'other',username:'second-account',displayName:'第二个账号',online:true}]},{deviceUuid:'PHONE-1',deviceType:'mobile',name:'测试手机',status:'ONLINE',accounts:[{userId:'test',username:'human',online:true}]},{deviceUuid:'solo-device',deviceType:'mac',accounts:[]}])
 };
 const server=http.createServer(async(req,res)=>{
  try {
   res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'");
   const url=new URL(req.url,'http://localhost');
   if(url.pathname.startsWith('/api/')){
    requests.push({path:url.pathname,params:Object.fromEntries(url.searchParams)});
    if(url.pathname==='/api/users/test/tags') {
     assert.equal(req.headers['x-ops-request'],'user-tags');
     assert.equal(req.headers['content-type'],'application/json');
     let body='';for await(const chunk of req)body+=chunk;
     const change=JSON.parse(body);tagChanges.push(change);
     res.setHeader('Content-Type','application/json');
     if(rejectTagChange){res.end(JSON.stringify({code:'OPS_007',message:'保存失败测试'}));return;}
     const row=responses['/api/users'].items[0];
     row.tags=row.tags.filter(t=>t!==change.tag);if(change.enabled)row.tags.push(change.tag);
     res.end(JSON.stringify({code:'OK',data:row.tags}));return;
    }
    if(url.pathname==='/api/active/members') {
     const users=url.searchParams.get('dimension')==='users';
     res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'OK',data:{dimension:users?'users':'terminals',from:'2026-11-01T00:00:00',to:'2026-11-02T00:00:00',members:{page:Number(url.searchParams.get('page')),size:20,total:21,items:[{memberId:'member1',name:users?'活跃测试用户':'活跃测试终端',username:'active-test',lastActiveAt:'2026-11-01T09:00:00',activeHours:2.5,terminalCount:2,device:users?null:{...responses['/api/devices'].items[0],name:'活跃测试终端',city:'杭州'}}]}}}));return;
    }
    if(url.pathname==='/api/feedback'){
     const status=url.searchParams.get('status');
     const included={ACTIVE:['ACCEPTED','IN_PROGRESS'],COMPLETED:['IGNORED','RESOLVED']}[status];
     const items=feedbackRows.filter(r=>!status||(included?included.includes(r.status):r.status===status));
     res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'OK',data:{feedback:page(items),counts:{PENDING:feedbackRows.filter(r=>r.status==='PENDING').length,ACCEPTED:feedbackRows.filter(r=>r.status==='ACCEPTED').length,IN_PROGRESS:feedbackRows.filter(r=>r.status==='IN_PROGRESS').length,IGNORED:feedbackRows.filter(r=>r.status==='IGNORED').length,RESOLVED:feedbackRows.filter(r=>r.status==='RESOLVED').length}}}));return;
    }
    if(url.pathname==='/api/feedback/report_1/status'){
     let body='';for await(const chunk of req)body+=chunk;
     feedbackRows[0].status=JSON.parse(body).status;
     statusChanges.push(feedbackRows[0].status);
     res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'OK',data:feedbackRows[0]}));return;
    }
    if(url.pathname==='/api/feedback/report_1'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'OK',data:feedbackRows[0]}));return;}
    if(url.pathname==='/api/contacts/contact_1'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'OK',data:responses['/api/contacts'].items[0]}));return;}
    if(url.pathname.startsWith('/api/attachments/')){res.setHeader('Content-Type','image/png');res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));return;}
    assert.ok(responses[url.pathname],`unexpected API: ${url.pathname}`);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'OK',data:responses[url.pathname]}));return;
   }
   const file=path.join(root,url.pathname==='/'?'index.html':url.pathname.slice(1));
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
   res.end(await fs.readFile(file));
  } catch(e) {res.statusCode=500;res.end(String(e));}
 });
 let win;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await app.whenReady();
  win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true,sandbox:true}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const run=s=>win.webContents.executeJavaScript(s);
  const wait=()=>run('new Promise(r=>setTimeout(r,100))');await wait();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('[role=tab]')).map(n=>n.textContent)`),['概览','活跃','问题反馈','用户联系']);
  assert.ok(await run(`document.querySelector('#out-overview').textContent.includes('今日活跃用户')`));
  for(const sel of ['.app-head','.topbar','.tabs'])assert.ok(await run(`(()=>{const n=document.querySelector('${sel}');return n.scrollHeight<=n.clientHeight;})()`),`${sel} must not scroll vertically`);
  assert.ok(await run(`!document.querySelector('#out-overview').textContent.includes('数据生成时间')`));
  if(process.env.ADING_TEST_SCREENSHOT)await fs.writeFile(process.env.ADING_TEST_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
  assert.ok(!(await run(`document.querySelector('#out-overview').textContent.includes('Agent 数')`)),'Overview no longer shows the Agent count');
  for(const [label,panel,expected] of [['注册用户','users','测试用户'],['终端','devices','测试电脑']]){
   await run(`Array.from(document.querySelectorAll('#out-overview .card')).find(n=>n.querySelector('.card-label').textContent===${JSON.stringify(label)}).querySelector('button').click()`);await wait();
   assert.equal(await run(`document.querySelector('#panel-${panel}').hidden`),false);
   assert.ok(await run(`document.querySelector('#out-${panel}').textContent.includes(${JSON.stringify(expected)})`));
   await run('history.back()');await wait();
   assert.equal(await run(`document.querySelector('#panel-overview').hidden`),false);
  }
  assert.ok(await run(`!document.querySelector('#out-overview').textContent.includes('当前连接服务的终端') && !document.querySelector('#out-overview').textContent.includes('按已登录真人账号去重')`));
  await run(`Array.from(document.querySelectorAll('#out-overview .card')).find(n=>n.querySelector('.card-label').textContent==='在线终端').querySelector('button').click()`);await wait();
  assert.equal(requests.at(-1).params.scope,'online');
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-devices th')).map(n=>n.textContent)`),['终端','类型','版本号','城市']);
  assert.equal(await run(`document.querySelector('#seg-scope [aria-pressed=true]').textContent`),'仅在线终端');
  win.webContents.reload();await wait();await wait();
  assert.equal(requests.at(-1).params.scope,'online');
  await run('history.back()');await wait();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-overview .card-label')).slice(-4).map(n=>n.textContent)`),['今日活跃终端','今日活跃用户','近 30 天活跃终端','近 30 天活跃用户']);
  await run(`document.querySelector('[data-tab=active]').click()`);await wait();
  assert.equal(await run(`document.querySelector('#active-chart-title').textContent`),'活跃终端趋势');
  assert.ok(await run(`!document.querySelector('#panel-active').textContent.includes('去重总数')`));
  assert.equal(await run(`document.querySelectorAll('#active-chart .total-mark').length`),0);
  await run(`document.querySelector('#active-table .count-link').click()`);await wait();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-members th')).map(n=>n.textContent)`),['终端','类型','版本号','城市','最近活跃','状态','活跃小时数']);
  assert.ok(await run(`document.querySelector('#out-members').textContent.includes('0.11.0') && document.querySelector('#out-members').textContent.includes('杭州') && document.querySelector('#out-members').textContent.includes('2.5')`));
  assert.ok(await run(`!document.querySelector('#out-members').textContent.includes('terminal-test') && !document.querySelector('#out-members').textContent.includes('second-account')`));
  await run(`document.querySelector('#out-members .device-link').click()`);await wait();
  assert.equal(await run(`document.querySelector('#device-detail').open`),true);
  assert.ok(await run(`['terminal-test','macOS 26.1','human','second-account','codex','qoder','首次注册时间'].every(t=>document.querySelector('#device-detail').textContent.includes(t))`));
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'active-device-detail.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#device-detail .btn').click()`);await wait();
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'active-devices.png'),(await win.webContents.capturePage()).toPNG());
  const memberRange=await run(`document.querySelector('#out-members .cell-sub').textContent`);
  assert.equal(memberRange,'2026-11-01 00:00:00 至 2026-11-02 00:00:00');
  await run('history.back()');await wait();
  await run(`Array.from(document.querySelectorAll('#seg-dimension button')).find(n=>n.textContent==='用户').click()`);await wait();
  assert.equal(await run(`document.querySelector('#active-chart-title').textContent`),'活跃用户趋势');
  assert.equal(await run(`document.querySelector('#active-chart').getAttribute('aria-label')`),'活跃用户趋势折线图');
  assert.equal(await run(`document.querySelectorAll('#active-chart polyline.trend-line').length`),1);
  assert.equal(await run(`document.querySelectorAll('#active-chart .trend-point').length`),3);
  assert.equal(await run(`document.querySelectorAll('#active-chart .bar').length`),0);
  const coords=await run(`Array.from(document.querySelectorAll('#active-chart .trend-point')).map(n=>[Number(n.getAttribute('cx')),Number(n.getAttribute('cy'))])`);
  assert.ok(coords[0][0]<coords[1][0] && coords[1][0]<coords[2][0]);
  assert.ok(coords[1][1]>coords[0][1] && coords[0][1]>coords[2][1]);
  await run(`document.querySelector('#active-chart .band').dispatchEvent(new MouseEvent('mouseenter'))`);
  assert.ok(await run(`!document.querySelector('#active-tip').hidden && document.querySelector('#active-tip').textContent.includes('活跃用户')`));
  assert.ok(await run(`!document.querySelector('#active-table').textContent.includes('单机版')`));
  assert.ok(await run(`document.querySelector('#active-totals').textContent.includes('近 30 天活跃用户')`));
  await run(`Array.from(document.querySelectorAll('#seg-dimension button')).find(n=>n.textContent==='终端').click()`);await wait();
  assert.ok(await run(`document.querySelector('#active-table').textContent.includes('单机版')`));
  assert.equal(await run(`document.querySelectorAll('#active-chart .trend-line').length`),1);
  assert.ok(await run(`document.querySelectorAll('#active-chart .bar').length===0`));
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'terminal-trend.png'),(await win.webContents.capturePage()).toPNG());
  for (const label of ['终端','用户']) {
   await run(`Array.from(document.querySelectorAll('#seg-dimension button')).find(n=>n.textContent===${JSON.stringify(label)}).click()`);await wait();
   await run(`document.querySelector('#active-totals .card-value').click()`);await wait();
   assert.equal(await run(`document.querySelector('#panel-members').hidden`),false);
   assert.ok(await run(`document.querySelector('#out-members').textContent.includes('活跃测试${label}')`));
   assert.equal(requests.at(-1).params.period,'today');
   assert.equal(requests.at(-1).params.dimension,label==='用户'?'users':'terminals');
   await run(`Array.from(document.querySelectorAll('#out-members button')).find(n=>n.textContent==='下一页').click()`);await wait();
   assert.equal(requests.at(-1).params.page,'2');
   await run('history.back()');await wait();
   assert.equal(await run(`document.querySelector('#panel-members').hidden`),false);
   assert.ok(await run(`document.querySelector('#out-members .pager-info').textContent.includes('第 1 /')`));
   await run('history.back()');await wait();
   await run(`document.querySelector('#active-table .count-link').click()`);await wait();
   assert.equal(requests.at(-1).params.period,'bucket');
   assert.equal(requests.at(-1).params.bucket,'2026-10-30');
   await run('history.back()');await wait();
  }
  await run(`Array.from(document.querySelectorAll('#seg-dimension button')).find(n=>n.textContent==='终端').click()`);await wait();
  await run(`document.querySelectorAll('#active-table .count-link')[2].click()`);await wait();
  assert.equal(requests.at(-1).params.login,'standalone');
  await run('history.back()');await wait();
  assert.ok(await run(`!document.querySelector('#view-main').textContent.includes('设备')`));
  assert.ok(await run(`!document.querySelector('#view-main').textContent.includes('返回概览') && !document.querySelector('#view-main').textContent.includes('返回活跃')`));
  await run(`Array.from(document.querySelectorAll('#seg-dimension button')).find(n=>n.textContent==='用户').click()`);await wait();
  await run(`document.querySelector('#active-totals button').click()`);await wait();
  const memberUrl=await run('location.href');
  await run('history.back()');await wait();
  assert.equal(await run(`document.querySelector('#panel-active').hidden`),false);
  assert.equal(await run(`document.querySelector('#seg-dimension [aria-pressed=true]').textContent`),'用户');
  await run('history.forward()');await wait();
  assert.equal(await run('location.href'),memberUrl);
  assert.equal(await run(`document.querySelector('#members-title').textContent`),'今日活跃用户');
  win.webContents.reload();await wait();await wait();
  assert.equal(await run(`document.querySelector('#panel-members').hidden`),false);
  assert.ok(await run(`document.querySelector('#out-members').textContent.includes('活跃测试用户')`));
  await run('history.back()');await wait();
  assert.equal(await run(`document.querySelector('#panel-active').hidden`),false);
  await run(`document.querySelector('[data-tab=overview]').click()`);await wait();
  await run(`Array.from(document.querySelectorAll('#out-overview .card')).find(n=>n.querySelector('.card-label').textContent==='注册用户').querySelector('button').click()`);await wait();
  await run(`document.querySelector('#users-keyword').value='someone';document.querySelector('#users-keyword').dispatchEvent(new Event('input'))`);
  await run('new Promise(r=>setTimeout(r,400))');
  await run('history.back()');await wait();
  assert.equal(await run(`document.querySelector('#users-keyword').value`),'');
  await run('history.forward()');await wait();
  assert.equal(await run(`document.querySelector('#users-keyword').value`),'someone');
  await run(`document.querySelector('#users-keyword').value='';document.querySelector('#users-keyword').dispatchEvent(new Event('input'))`);
  await run('new Promise(r=>setTimeout(r,400))');
  assert.ok(await run(`document.querySelector('#out-users').textContent.includes('预发灰度') && document.querySelector('#out-users').textContent.includes('大陆加好友')`));
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-users th')).map(n=>n.textContent)`),['用户名','显示名','状态','标签','最近活跃','在线']);
  for(const width of [1600,1280,720,390]) {
   win.setSize(width,900);await wait();
   assert.ok(await run(`Array.from(document.querySelectorAll('#out-users .tag-chip')).every(n=>n.getBoundingClientRect().height<40)`),'Tags stay on one row');
   assert.ok(await run(`document.documentElement.scrollWidth<=innerWidth`),'Page does not overflow horizontally');
  }
  win.setSize(1600,900);await wait();
  assert.ok(await run(`document.querySelector('.wrap').getBoundingClientRect().width>1320`),'Uses wide-screen space');
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'users-wide.png'),(await win.webContents.capturePage()).toPNG());
  const openUserDetail=async()=>{await run(`document.querySelector('#out-users .user-link').click()`);await wait();};
  await openUserDetail();
  assert.equal(await run(`document.querySelector('#user-detail').open`),true);
  assert.ok(await run(`['13800138000','human@example.com','注册时间','已登记终端数','Agent 数'].every(v=>document.querySelector('#user-detail').textContent.includes(v))`));
  assert.ok(await run(`!document.querySelector('#user-detail').textContent.includes('近 30 天活跃终端')`));
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'user-detail.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#user-detail .btn').click()`);await wait();
  assert.equal(await run(`document.activeElement===document.querySelector('#out-users .user-link')`),true,'Focus returns to the username after closing');
  assert.equal(await run(`(()=>{const heads=Array.from(document.querySelectorAll('#out-users th')).map(n=>n.textContent);return document.querySelectorAll('#out-users tbody td')[heads.indexOf('在线')].textContent;})()`),'在线');
  const openOwnerLink=async(name)=>{await openUserDetail();await run(`document.querySelector('#user-detail .count-link[aria-label^="测试用户 ${name}"]').click()`);await wait();};
  await openOwnerLink('已登记终端');
  assert.equal(await run(`document.querySelector('#panel-devices').hidden`),false);
  assert.equal(requests.at(-1).path,'/api/devices');
  assert.deepEqual([requests.at(-1).params.owner,requests.at(-1).params.scope,requests.at(-1).params.active],['test','terminal',undefined]);
  assert.ok(await run(`document.querySelector('#devices-filter').textContent.includes('测试用户 · 已登记终端') && document.querySelector('#seg-scope').hidden`));
  assert.ok(await run(`document.querySelector('#out-devices').textContent.includes('手机')`));
  assert.equal(await run(`document.querySelectorAll('#out-devices tbody tr').length`),3,'One row per device');
  const deviceHeads=await run(`Array.from(document.querySelectorAll('#out-devices th')).map(n=>n.textContent)`);
  assert.deepEqual(deviceHeads,['终端','类型','版本号','城市','最近活跃','状态']);
  await run(`document.querySelector('#out-devices .device-link').click()`);await wait();
  assert.equal(await run(`document.querySelector('#device-detail').open`),true);
  assert.ok(await run(`['terminal-test','macOS 26.1','human','second-account','codex','qoder','首次注册时间','11月1日 08:00'].every(v=>document.querySelector('#device-detail').textContent.includes(v))`));
  assert.equal(await run(`document.querySelectorAll('#device-detail .badge.ready').length`),1);
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'device-detail.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#device-detail .btn').click()`);await wait();
  assert.equal(await run(`document.activeElement===document.querySelector('#out-devices .device-link')`),true);
  const firstDevice=await run(`Array.from(document.querySelectorAll('#out-devices tbody tr')[0].children).map(n=>n.textContent)`);
  assert.equal(firstDevice[deviceHeads.indexOf('版本号')],'0.11.0');
  await run(`document.querySelectorAll('#out-devices .device-link')[2].click()`);await wait();
  assert.ok(await run(`document.querySelector('#device-detail').textContent.includes('solo-device') && document.querySelector('#device-detail').textContent.includes('单机版')`));
  assert.equal(await run(`document.querySelector('#device-detail .detail-meta dd:last-child').textContent`),'—');
  await run(`document.querySelector('#device-detail .btn').click()`);await wait();
  const soloDevice=await run(`Array.from(document.querySelectorAll('#out-devices tbody tr')[2].children).map(n=>n.textContent)`);
  assert.equal(soloDevice[deviceHeads.indexOf('版本号')],'—');
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'terminals-list.png'),(await win.webContents.capturePage()).toPNG());
  await run('history.back()');await wait();
  await openOwnerLink('Agent');
  assert.equal(await run(`document.querySelector('#panel-agents').hidden`),false);
  assert.equal(requests.at(-1).path,'/api/agents');
  assert.deepEqual([requests.at(-1).params.owner,requests.at(-1).params.contact],['test','true']);
  assert.ok(await run(`document.querySelector('#agents-filter').textContent.includes('测试用户 · Agent')`));
  await run('history.back()');await wait();
  assert.equal(await run(`document.querySelector('#panel-users').hidden`),false);
  assert.equal(await run(`document.querySelector('#out-users .tag-add')`),null);
  await run(`document.querySelector('#out-users button[aria-label="移除预发灰度"]').click()`);await wait();
  assert.deepEqual(tagChanges.at(-1),{tag:'PRE_GRAY',enabled:false});
  assert.equal(await run(`document.querySelectorAll('#out-users .tag-chip').length`),1);
  assert.ok(await run(`document.querySelector('#out-users button[aria-label="移除大陆加好友"]')!==null`));
  await run(`document.querySelector('#out-users .tag-add').click()`);await wait();
  assert.equal(await run(`document.querySelector('#out-users .tag-picker').matches(':popover-open')`),true);
  assert.equal(await run(`document.querySelectorAll('#out-users .tag-option').length`),1);
  const pickerPosition=await run(`(()=>{const add=document.querySelector('#out-users .tag-add').getBoundingClientRect();const list=document.querySelector('#out-users .tag-picker').getBoundingClientRect();return {right:add.right,left:list.left,top:add.top,listTop:list.top};})()`);
  assert.ok(pickerPosition.left>=pickerPosition.right+7);
  assert.ok(Math.abs(pickerPosition.top-pickerPosition.listTop)<2);
  assert.equal(await run(`document.querySelector('#out-users .tag-option').classList.contains('tag')`),false);
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'tag-add.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#out-users button[aria-label="添加预发灰度"]').click()`);await wait();
  assert.deepEqual(tagChanges.at(-1),{tag:'PRE_GRAY',enabled:true});
  assert.equal(await run(`document.querySelectorAll('#out-users .tag-chip').length`),2);
  assert.equal(await run(`document.querySelector('#out-users .tag-add')`),null);
  rejectTagChange=true;
  await run(`document.querySelector('#out-users button[aria-label="移除预发灰度"]').click()`);await wait();
  assert.equal(await run(`document.querySelectorAll('#out-users .tag-chip').length`),2);
  assert.ok(await run(`document.querySelector('#out-users [role=status]').textContent.includes('保存失败测试')`));
  assert.equal(await run(`document.querySelector('#out-users button[aria-label="移除预发灰度"]').disabled`),false);
  rejectTagChange=false;
  await run(`document.querySelector('#out-users button[aria-label="移除预发灰度"]').click()`);await wait();
  await run(`document.querySelector('#out-users button[aria-label="移除大陆加好友"]').click()`);await wait();
  assert.equal(await run(`document.querySelectorAll('#out-users .tag-chip').length`),0);
  assert.ok(await run(`document.querySelector('#out-users .tag-add')!==null`));
  await run(`document.querySelector('#out-users .tag-add').click()`);await wait();
  assert.equal(await run(`document.querySelectorAll('#out-users .tag-option').length`),2);
  const optionRows=await run(`Array.from(document.querySelectorAll('#out-users .tag-option')).map(n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,bottom:r.bottom};})`);
  assert.equal(optionRows[0].left,optionRows[1].left);
  assert.ok(optionRows[1].top>=optionRows[0].bottom);
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'tag-list.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#out-users .tag-add').click()`);await wait();
  assert.equal(await run(`document.querySelector('#out-users .tag-picker').matches(':popover-open')`),false);
  await run(`document.querySelector('#out-users .tag-add').click()`);await wait();
  await run(`document.querySelector('#out-users button[aria-label="添加预发灰度"]').click()`);await wait();
  await run(`document.querySelector('#out-users .tag-add').click()`);await wait();
  await run(`document.querySelector('#out-users button[aria-label="添加大陆加好友"]').click()`);await wait();
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'user-tags.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-tab=feedback]').click()`);await wait();
  assert.equal(await run(`document.querySelector('#panel-feedback').hidden`),false);
  assert.equal(await run(`document.querySelector('#seg-feedback-status [aria-pressed=true]').textContent`),'待处理 1');
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#seg-feedback-status button')).map(n=>n.textContent)`),['待处理 1','进行中 0','已完成 0']);
  assert.ok(await run(`document.querySelector('#out-feedback .row-link').textContent.includes('发送按钮没有反应')`));
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-feedback th')).map(n=>n.textContent)`),['问题描述','版本','环境','状态','上报时间','解决时间','操作']);
  assert.equal(await run(`document.querySelector('#out-feedback tbody tr').children[5].textContent`),'—');
  assert.equal(await run(`document.querySelectorAll('#out-feedback img').length`),0);
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-feedback .feedback-actions button')).map(n=>n.textContent)`),['接受','忽略']);
  await run(`document.querySelector('#out-feedback .feedback-actions .primary').click()`);await wait();
  assert.deepEqual(statusChanges,['ACCEPTED']);
  assert.ok(await run(`document.querySelector('#out-feedback').textContent.includes('没有「待处理」')`));
  await run(`Array.from(document.querySelectorAll('#seg-feedback-status button')).find(n=>n.textContent.startsWith('进行中')).click()`);await wait();
  assert.equal(requests.at(-1).params.status,'ACTIVE');
  await run(`document.querySelector('#out-feedback .row-link').click()`);await wait();
  assert.equal(await run(`document.querySelector('#panel-feedbackDetail').hidden`),false);
  assert.ok(await run(`document.querySelector('#out-feedbackDetail .detail-body').textContent.startsWith('<img')`));
  assert.ok(await run(`document.querySelector('.attachment-thumb img').naturalWidth===1`));
  assert.ok(await run(`document.querySelector('#out-feedbackDetail .attachment-files a').hasAttribute('download')`));
  assert.ok(await run(`document.querySelector('#out-feedbackDetail .attachment-files').textContent.includes('日志压缩包')`));
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-feedbackDetail .feedback-actions button')).map(n=>n.textContent)`),['忽略']);
  feedbackRows[0].status='IN_PROGRESS';
  feedbackRows[0].handledBy='worker-1';
  win.webContents.reload();await wait();await wait();
  assert.ok(await run(`document.querySelector('#out-feedbackDetail').textContent.includes('处理中')`));
  assert.ok(await run(`document.querySelector('#out-feedbackDetail').textContent.includes('worker-1')`));
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#out-feedbackDetail .feedback-actions button')).map(n=>n.textContent)`),['已解决','退回接受','忽略']);
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'feedback-processing.png'),(await win.webContents.capturePage()).toPNG());
  const beforeConfirm=statusChanges.length;
  await run(`window.confirm = () => false; document.querySelector('#out-feedbackDetail .feedback-actions .primary').click()`);await wait();
  assert.equal(statusChanges.length,beforeConfirm,'cancel must not send a status mutation');
  await run(`window.confirm = text => { window.confirmedDescription=text; return true; }; document.querySelector('#out-feedbackDetail .feedback-actions .primary').click()`);await wait();
  assert.equal(statusChanges.at(-1),'RESOLVED');
  assert.ok(await run(`window.confirmedDescription.includes('发送按钮没有反应')`));
  feedbackRows[0].statusChangedAt='2026-11-04T12:34:00';
  win.webContents.reload();await wait();await wait();
  assert.equal(await run(`document.querySelector('#panel-feedbackDetail').hidden`),false);
  assert.equal(await run(`document.querySelectorAll('#out-feedbackDetail .feedback-actions button').length`),0);
  await run('history.back()');await wait();
  assert.equal(await run(`document.querySelector('#panel-feedback').hidden`),false);
  await run(`Array.from(document.querySelectorAll('#seg-feedback-status button')).find(n=>n.textContent.startsWith('已完成')).click()`);await wait();
  assert.ok(await run(`document.querySelector('#out-feedback tbody tr').children[5].textContent.includes('12:34')`));
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'feedback-resolved-columns.png'),(await win.webContents.capturePage()).toPNG());
  for(const status of ['ACCEPTED','IN_PROGRESS','IGNORED'])feedbackRows.push({...feedbackRows[0],reportId:'group_'+status,status,description:'分组 '+status});
  await run(`document.querySelector('#btn-refresh').click()`);await wait();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('#seg-feedback-status button')).map(n=>n.textContent)`),['待处理 0','进行中 2','已完成 2']);
  assert.equal(await run(`document.querySelectorAll('#out-feedback tbody tr').length`),2);
  assert.ok(await run(`document.querySelector('#out-feedback').textContent.includes('分组 IGNORED')`));
  await run(`Array.from(document.querySelectorAll('#seg-feedback-status button')).find(n=>n.textContent.startsWith('进行中')).click()`);await wait();
  assert.equal(await run(`document.querySelectorAll('#out-feedback tbody tr').length`),2);
  assert.ok(await run(`document.querySelector('#out-feedback').textContent.includes('分组 ACCEPTED') && document.querySelector('#out-feedback').textContent.includes('分组 IN_PROGRESS')`));
  win.webContents.reload();await wait();await wait();
  assert.equal(requests.at(-1).params.status,'ACTIVE');
  // Old browser history entries migrate to the containing group on reload.
  await run(`history.replaceState({...history.state,feedback:{...history.state.feedback,status:'IGNORED',page:3}},'',location.href)`);
  win.webContents.reload();await wait();await wait();
  assert.equal(requests.at(-1).params.status,'COMPLETED');
  assert.equal(requests.at(-1).params.page,'1');
  if(process.env.ADING_TEST_SCREENSHOT_DIR)await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,'feedback-groups.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-tab=contacts]').click()`);await wait();
  assert.ok(await run(`document.querySelector('#out-contacts').textContent.includes('reader@example.com')`));
  await run(`document.querySelector('#out-contacts .row-link').click()`);await wait();
  assert.equal(await run(`document.querySelector('#out-contactDetail .detail-body').textContent`),'正文内容');
  assert.ok(await run(`document.querySelector('#out-contactDetail .attachment-files').textContent.includes('方案.pdf')`));
  if(process.env.ADING_TEST_SCREENSHOT_DIR){for(const [tab,file] of [['feedback','feedback.png'],['contacts','contacts.png']]){await run(`document.querySelector('[data-tab=${tab}]').click()`);await wait();await fs.writeFile(path.join(process.env.ADING_TEST_SCREENSHOT_DIR,file),(await win.webContents.capturePage()).toPNG());}}
  await run('history.back()');await wait();
  const historyLength=await run('history.length');
  await run(`document.querySelector('#btn-refresh').click()`);await wait();
  assert.equal(await run('history.length'),historyLength);
  console.log('ops-console-ui: overview links, agents, terminals, activity lists, browser back/forward, reload, filters, refresh history, tags, feedback and contact inbox, user and terminal line charts, terminal details passed');
 }finally{win?.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
 app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
