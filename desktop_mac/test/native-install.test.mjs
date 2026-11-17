import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,access,rm,cp,symlink,readlink,lstat} from 'node:fs/promises';
import {AgentLifecycleService} from '../dist/agents/lifecycle.js';
import {installNativeCli} from '../dist/agents/native-install.js';
import {ProcessRunner} from '../dist/agents/process-runner.js';
import {setMainLanguage} from '../dist/i18n.js';

// The official manifest is machine output, never a user-facing progress stream.
// Run the whole lifecycle, including checksum and install, against isolated fixtures.
const root=await mkdtemp(path.join(os.tmpdir(),'ading-native-install-test-'));
const ok=(stdout='')=>({stdout,stderr:'',failure:'',cancelled:false,exitCode:0,signal:null});
try {
 for(const kind of ['kiro','antigravity']) {
  setMainLanguage(kind==='kiro'?'zh-CN':'en');
  const scenarios=['success','partial','checksum','existing','dangling','foreign','offpath',...(kind==='kiro'?['leftover','detach']:[])];
  for(const scenario of scenarios) {
   const prefix=path.join(root,kind,scenario),progress=[],downloads=[],scratch=[];
   const bytes=Buffer.from('verified native release fixture');
   const algorithm=kind==='kiro'?'sha256':'sha512';
   const pkg={os:'macos',fileType:'dmg',download:'1.2.3/Kiro CLI.dmg',url:'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.3/fixture.tar.gz',[algorithm]:createHash(algorithm).update(bytes).digest('hex')};
   // Shared hosts are trusted only under the vendor's own release path.
   if(scenario==='offpath'){pkg.download='../other/Kiro CLI.dmg';pkg.url='https://storage.googleapis.com/someone-else/antigravity-cli/fixture.tar.gz';}
   const manifest=JSON.stringify({version:'1.2.3',...pkg,packages:[pkg]},null,2);
   const target=path.join(prefix,'bin',kind==='kiro'?'kiro-cli':'agy');
   const owned=path.join(prefix,'lib/ading-agents'),foreign=path.join(root,'elsewhere',kind);
   if(scenario==='existing'){await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'original');}
   // A dangling link into ADing's own releases is repaired; a user's link never is.
   if(scenario==='dangling'||scenario==='foreign'){await mkdir(path.dirname(target),{recursive:true});await symlink(scenario==='dangling'?path.join(owned,'kiro-0.9.0/Kiro CLI.app/Contents/MacOS/kiro-cli'):foreign,target);}
   if(scenario==='leftover'){const stale=path.join(owned,'kiro-1.2.3/Kiro CLI.app/Contents/MacOS');await mkdir(stale,{recursive:true});await writeFile(path.join(stale,'partial'),'interrupted copy');}
   let mount;
   const service=new AgentLifecycleService(undefined,prefix);
   service.runner.run=async (_id,options)=>{
    const {executablePath:exe,args}=options;
    if(exe==='/usr/bin/curl') {
     assert.ok(args.includes('--proto')&&args.includes('--proto-redir')&&args.filter(arg=>arg==='=https').length===2,'manifest and download are https only');
     if(!args.includes('--output')) {
      for(const line of manifest.split('\n'))options.onLine(line);
      return ok(manifest);
     }
     downloads.push(options);
     const archive=args[args.indexOf('--output')+1];scratch.push(path.dirname(archive));
     await writeFile(archive,scenario==='checksum'?Buffer.from('corrupt'):bytes);
     if(scenario==='partial')return {...ok(),failure:'curl: (28) Operation too slow',exitCode:28};
     return ok();
    }
    if(exe==='/usr/bin/hdiutil'&&args[0]==='detach'&&scenario==='detach')return {...ok(),failure:'hdiutil: couldn\'t unmount: Resource busy',exitCode:16};
    if(exe==='/usr/bin/hdiutil'&&args[0]==='attach'){
     mount=args.at(-1);const dir=path.join(args.at(-1),'Kiro CLI.app/Contents/MacOS');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'kiro-cli'),'fixture binary');
    } else if(exe==='/usr/bin/ditto')await cp(args[0],args[1],{recursive:true});
    else if(exe==='/usr/bin/tar')await writeFile(path.join(args[args.indexOf('-C')+1],'antigravity'),'fixture binary');
    return ok('1.2.3');
   };
   const result=await service.install(kind,true,text=>progress.push(text));
   const installed=['success','dangling','leftover','detach'].includes(scenario);
   assert.equal(result.ok,installed,`${kind} ${scenario}: ${result.message}`);
   if(scenario==='offpath'){assert.equal(downloads.length,0,'off-path release is never downloaded');await assert.rejects(access(target));continue;}
   assert.ok(progress.some(text=>text.includes('下载')||text.includes('downloading')));
   assert.ok(progress.every(text=>text.includes(kind==='kiro'?'Kiro':'Antigravity')),JSON.stringify(progress));
   assert.ok(!progress.includes('}')&&!progress.some(text=>text.includes('sha256')||text.includes('sha512')));
   if(kind==='antigravity')assert.ok(progress.every(text=>!/[\u4e00-\u9fff]/.test(text)), 'English progress contains no Chinese');
   assert.ok(downloads[0].timeoutMs>600000,'large archives outlive the old ten-minute deadline');
   assert.equal(downloads[0].idleTimeoutMs,downloads[0].timeoutMs,'curl owns transport stall detection, not silent stdout');
   assert.ok(downloads[0].args.includes('--connect-timeout')&&downloads[0].args.includes('--speed-time')&&downloads[0].args.includes('--continue-at'));
   if(scenario==='partial')assert.equal(downloads.length,3,'retry twice, then report failure');
   if(installed)assert.equal(await readFile(target,'utf8'),'fixture binary');
   else if(scenario==='existing')assert.equal(await readFile(target,'utf8'),'original');
   else if(scenario==='foreign'){assert.ok((await lstat(target)).isSymbolicLink());assert.equal(await readlink(target),foreign);}
   else await assert.rejects(access(target));
   if(scenario==='leftover')await assert.rejects(access(path.join(owned,'kiro-1.2.3/Kiro CLI.app/Contents/MacOS/partial')),'stale copy is replaced');
   // A failed detach whose mount point is not actually mounted (this fixture never
   // mounts) still cleans up; the still-mounted case is covered below.
   if(scenario==='detach')assert.ok(mount);
   if(scenario==='partial')assert.match(result.message,/0\.0 MB.*Operation too slow/);
   for(const directory of scratch)await assert.rejects(access(directory),'scratch must be removed on success and failure');
  }
 }
 // Kiro attach: detach is attempted even when attach itself was cancelled or timed
 // out (it may already have mounted), and a still-mounted image is never recursively deleted.
 for(const [label,attach,stillMounted] of [['cancelled attach',{cancelled:true},false],['timed-out attach',{failure:'timed out'},true],['detach failure',{},true]]) {
  const bytes=Buffer.from('kiro mount fixture'),pkg={os:'macos',fileType:'dmg',download:'1.2.3/Kiro CLI.dmg',sha256:createHash('sha256').update(bytes).digest('hex')};
  const calls=[];let mount;
  const result=installNativeCli('kiro',path.join(root,'mount',label),async (exe,args)=>{
   calls.push([exe,args[0]]);
   if(exe==='/usr/bin/curl'){if(!args.includes('--output'))return ok(JSON.stringify({version:'1.2.3',packages:[pkg]}));await writeFile(args[args.indexOf('--output')+1],bytes);return ok();}
   if(exe==='/usr/bin/hdiutil'&&args[0]==='attach'){mount=args.at(-1);await mkdir(path.join(mount,'Kiro CLI.app'),{recursive:true});return {...ok(),...attach};}
   if(exe==='/usr/bin/hdiutil'&&args[0]==='detach')return label==='detach failure'?{...ok(),failure:'Resource busy',exitCode:16}:ok();
   if(exe==='/usr/bin/ditto'){await cp(args[0],args[1],{recursive:true});return ok();}
   return ok('1.2.3');
  },()=>{},async()=>stillMounted);
  if(label==='detach failure'){await result;}else await assert.rejects(result,label);
  assert.ok(calls.some(([exe,action])=>exe==='/usr/bin/hdiutil'&&action==='detach'),`${label}: detach attempted`);
  if(stillMounted){await access(mount);await rm(path.dirname(mount),{recursive:true,force:true});}
  else await assert.rejects(access(path.dirname(mount)),`${label}: unmounted scratch is removed`);
 }
 // A real curl transfer must resume, not discard partial bytes on retry.
 const fixture=path.join(root,'transfer');await mkdir(fixture);
 await writeFile(path.join(fixture,'antigravity'),'#!/bin/sh\necho fixture-version\nexit 0\n#'+randomBytes(65536).toString('hex'));
 const tar=path.join(root,'release.tar.gz');execFileSync('/usr/bin/tar',['-czf',tar,'-C',fixture,'antigravity']);
 const archive=await readFile(tar),ranges=[];
 const server=http.createServer((request,response)=>{
  const range=request.headers.range;ranges.push(range??'none');
  const offset=range?Number(range.match(/bytes=(\d+)-/)[1]):0;
  response.writeHead(offset?206:200,{'Content-Length':archive.length-offset,...(offset?{'Content-Range':`bytes ${offset}-${archive.length-1}/${archive.length}`}:{})});
  if(ranges.length===1){response.write(archive.subarray(0,16384));setTimeout(()=>response.destroy(),30);}
  else response.end(archive.subarray(offset));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const runner=new ProcessRunner(),progress=[];
  await installNativeCli('antigravity',path.join(root,'resumed'),async (executablePath,args,timeoutMs)=>{
   if(executablePath==='/usr/bin/curl') {
    if(!args.includes('--output'))return ok(JSON.stringify({version:'1.2.3',url:'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.3/fixture.tar.gz',sha512:createHash('sha512').update(archive).digest('hex')}));
    // The local fixture server is plain http; production downloads stay https only.
    args=[...args.slice(0,-1).filter((arg,index,list)=>!['--proto','--proto-redir'].includes(arg)&&!['--proto','--proto-redir'].includes(list[index-1])),`http://127.0.0.1:${server.address().port}/release`];
   }
   return runner.run('fixture-download',{executablePath,args,timeoutMs,cwd:root,label:'fixture',onLine:()=>{}});
  },text=>progress.push(text));
  assert.deepEqual(ranges,['none','bytes=16384-']);
  assert.ok(progress.some(text=>text.includes('续传')||text.includes('resuming')));
  assert.equal(await readFile(path.join(root,'resumed/bin/agy'),'utf8'),await readFile(path.join(fixture,'antigravity'),'utf8'));
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 console.log('native-install: both providers, readable progress, download deadlines, partial failures, checksum, existing-install protection, stale-install repair, detach failure and release-path checks passed');
} finally {setMainLanguage('zh-CN');await rm(root,{recursive:true,force:true});}
