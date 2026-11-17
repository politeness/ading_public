import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { LinkPreviews, publicAddress, parseLinkPreview, publicPreviewHostname } from '../dist/links/preview.js';
const require = createRequire(import.meta.url);
const dns = require('node:dns/promises'), https = require('node:https'), child = require('node:child_process');
for(const url of ['https://127.0.0.1/','https://localhost/','https://host.local./','https://host.internal/','https://user:pass@example.com/','http://example.com/']) assert.equal(publicPreviewHostname(new URL(url)),false,url);
assert.equal(publicPreviewHostname(new URL('https://mp.weixin.qq.com/s/example')),true);
for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','0.0.0.0','198.18.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2002:7f00:1::','2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
for (const ip of ['8.8.8.8','1.1.1.1','192.0.78.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(publicAddress(ip), true, ip);
assert.deepEqual(parseLinkPreview(`<title>Fallback</title><meta content='A &amp; B' property='og:title'><meta NAME="description" content="Summary &quot;quote&quot;"><meta property="og:site_name" content="Site">`, 'example.com'), {title:'A & B',description:'Summary "quote"',siteName:'Site'});
assert.equal(parseLinkPreview('<html>No metadata</html>', 'example.com'), null);
const originalLookup = dns.lookup, originalGet = https.get, originalExecFile = child.execFile;
let calls = 0, lookups = 0, redirect = false, mixed = false, fakeDNS = false, nativeCalls = 0, protectedPage = false;
const thumbnail = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
try {
  child.execFile = (helper,args,options,callback) => { assert.equal(args[0],'link-preview'); assert.equal(options.timeout,8500); if(!fakeDNS&&!protectedPage){callback(null,JSON.stringify({ok:false}));return;} nativeCalls++; callback(null,JSON.stringify({ok:true,title:'Native preview',siteName:'proxy.example',image:thumbnail})); };
  dns.lookup = async host => { lookups++; if(fakeDNS)return [{address:'198.19.0.25',family:4}]; return host === 'private.example' ? [{address:'127.0.0.1',family:4}] : mixed ? [{address:'8.8.8.8',family:4},{address:'::1',family:6}] : [{address:'8.8.8.8',family:4}]; };
  https.get = (url, options, callback) => {
    calls++;
    assert.equal(options.agent, false);
    options.lookup(url.hostname, {all:true}, (error, addresses) => assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]));
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new EventEmitter(); response.destroy = () => {};
      response.statusCode = redirect ? 302 : protectedPage ? 401 : 200;
      response.headers = redirect ? {location:'https://private.example/secret'} : {'content-type':'text/html;charset=utf-8'};
      callback(response);
      if (!redirect) { response.emit('data',Buffer.from('<meta property="og:title" content="Actual page"><meta name="description" content="Actual summary">')); response.emit('end'); }
    });
    return request;
  };
  const previews = new LinkPreviews();
  const [a,b] = await Promise.all([previews.get('https://example.com/page'),previews.get('https://example.com/page#same')]);
  assert.deepEqual(a,{title:'Actual page',description:'Actual summary',siteName:'example.com'});
  assert.deepEqual(a,b); assert.equal(calls,1); assert.equal(lookups,1);
  assert.equal(await previews.get('https://private.example/secret'), null); assert.equal(calls,1);
  assert.equal(await previews.get('file:///etc/passwd'),null);
  assert.equal(await previews.get('https://user:pass@example.com/'),null);
  assert.equal(await previews.get('https://example.com:8080/'),null);
  redirect = true;
  assert.equal(await previews.get('https://example.com/redirect'),null); assert.equal(calls,2,'redirect is checked before opening another socket');
  redirect = false; mixed = true;
  assert.equal(await previews.get('https://mixed.example/'),null); assert.equal(calls,2,'mixed public/private DNS records are rejected');
  fakeDNS = true; mixed = false;
  if(process.platform==='darwin'){
    assert.deepEqual(await previews.get('https://proxy.example/'),{title:'Native preview',description:'',siteName:'proxy.example',image:thumbnail});
    assert.equal(nativeCalls,1,'synthetic proxy DNS uses only the native system metadata provider');
    assert.equal(await previews.get('http://insecure.example/'),null);
    assert.equal(await previews.get('https://host.local/'),null);
    assert.equal(nativeCalls,1,'native fallback never accepts insecure or local destinations');
    fakeDNS = false; protectedPage = true;
    assert.deepEqual(await previews.get('https://login.example/private'),{title:'Native preview',description:'',siteName:'proxy.example',image:thumbnail},'401 pages still show public site branding, like iOS');
    assert.equal(nativeCalls,2);
    assert.equal(await previews.get('https://private.example/forbidden'),null);
    assert.equal(nativeCalls,2,'private DNS must never invoke the system metadata provider');
  }
} finally { dns.lookup = originalLookup; https.get = originalGet; child.execFile = originalExecFile; }
console.log('link previews: metadata, caching/coalescing, DNS pinning and private-address/redirect protection passed');
