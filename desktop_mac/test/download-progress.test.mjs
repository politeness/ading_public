import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {downloadArchive,downloadTotal} from '../dist/agents/download-progress.js';
import {ProcessRunner} from '../dist/agents/process-runner.js';
const header=(status,fields)=>`HTTP/2 ${status}\r\n${fields}\r\n\r\n`;
assert.equal(downloadTotal(header(200,'Content-Length: 100')),100);
assert.equal(downloadTotal(header(302,'Content-Length: 9')+header(200,'content-length: 100')),100);
assert.equal(downloadTotal(header(200,'content-length: 9')+'HTTP/2 200\r\ncontent-length: 100'),undefined);
assert.equal(downloadTotal(header(206,'Content-Length: 60\r\nContent-Range: bytes 40-99/100')),100);
for(const text of [header(403,'Content-Length: 100'),header(302,'Content-Length: 100'),header(206,'Content-Length: 60'),header(200,'Transfer-Encoding: chunked'),header(200,'Content-Length: 100\r\nContent-Encoding: gzip'),header(200,'Content-Length: -1'),header(200,'Content-Length: 1e9'),header(206,'Content-Range: bytes 90-80/100'),header(206,'Content-Range: bytes 0-100/100')])assert.equal(downloadTotal(text),undefined);
const root=await mkdtemp(path.join(os.tmpdir(),'ading-download-progress-'));
const bytes=Buffer.alloc(65536,7),ranges=[],events=[];let denied=0;
const server=http.createServer((req,res)=>{
 if(req.url==='/deny'){denied++;res.writeHead(403,{'Content-Length':0});res.end();return;}
 if(req.url==='/redirect'){res.writeHead(302,{'Location':'/resume','Content-Length':0});res.end();return;}
 if(req.url==='/unknown'){res.writeHead(200,{'Transfer-Encoding':'chunked'});res.end(bytes);return;}
 const offset=req.headers.range?Number(req.headers.range.match(/bytes=(\d+)-/)[1]):0;
 ranges.push(offset);
 res.writeHead(offset?206:200,{'Content-Length':bytes.length-offset,...(offset?{'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});
 if(ranges.length===1){res.write(bytes.subarray(0,16384));setTimeout(()=>res.destroy(),1200);}
 else res.end(bytes.subarray(offset));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const runner=new ProcessRunner();
const run=(executablePath,args,timeoutMs)=>runner.run('download-fixture',{executablePath,args,timeoutMs,cwd:root,label:'fixture',onLine:()=>{}});
const base=`http://127.0.0.1:${server.address().port}`;
try{
 await downloadArchive(base+'/redirect',path.join(root,'archive'),run,(text,download)=>events.push({text,download}),'Fixture',false);
 assert.deepEqual(ranges,[0,16384]);
 assert.deepEqual(await readFile(path.join(root,'archive')),bytes);
 assert.ok(events.some(e=>e.download?.receivedBytes===16384&&e.download.totalBytes===65536),'actual partial download has correct full size before resume');
 assert.ok(events.some(e=>e.download?.receivedBytes===65536&&e.download.totalBytes===65536),'206 reports full size, not remaining bytes');
 const unknown=[];
 await downloadArchive(base+'/unknown',path.join(root,'unknown'),run,(_text,d)=>{if(d)unknown.push(d);},'Fixture',false);
 assert.ok(unknown.some(d=>d.receivedBytes===65536&&d.totalBytes===undefined));
 await assert.rejects(downloadArchive(base+'/deny',path.join(root,'denied'),run,()=>{},'Fixture',false),/403/);
 assert.equal(denied,1,'403 must not be retried as transient transport failure');
 assert.deepEqual(runner.busyIds(),[]);
 console.log('download-progress: redirects, full size, real curl partial/resume, unknown totals, 403 and cleanup passed');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
