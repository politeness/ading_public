import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

// Read Chromium's LevelDB files without opening/locking or modifying the live DB.
// Resolve sequence numbers and tombstones, including compacted Snappy tables.
function varint(b:Buffer,c:{p:number}):number {
 let n=0,m=1;
 for(let i=0;i<10;i++){if(c.p>=b.length)throw Error('Truncated varint');const v=b[c.p++];n+=(v&127)*m;if(v<128)return n;m*=128;}
 throw Error('Invalid varint');
}
function slice(b:Buffer,c:{p:number},n:number):Buffer {if(n<0||c.p+n>b.length)throw Error('Truncated data');const v=b.subarray(c.p,c.p+n);c.p+=n;return v;}
function snappy(b:Buffer):Buffer {
 const c={p:0},size=varint(b,c);if(size>32*1024*1024)throw Error('Oversize block');const out=Buffer.alloc(size);let p=0;
 while(c.p<b.length){const tag=b[c.p++],type=tag&3;let n=0,offset=0;
  if(type===0){n=tag>>2;if(n<60)n++;else{const count=n-59;n=0;const raw=slice(b,c,count);for(let i=0;i<count;i++)n+=raw[i]*2**(8*i);n++;}if(p+n>size)throw Error('Invalid literal');slice(b,c,n).copy(out,p);p+=n;continue;}
  if(type===1){n=4+((tag>>2)&7);offset=((tag&224)<<3)+slice(b,c,1)[0];}
  else{n=1+(tag>>2);const raw=slice(b,c,type===2?2:4);offset=type===2?raw.readUInt16LE():raw.readUInt32LE();}
  if(offset<=0||offset>p||p+n>size)throw Error('Invalid copy');for(let i=0;i<n;i++){out[p]=out[p-offset];p++;}
 }if(p!==size)throw Error('Truncated Snappy block');return out;
}
function entries(b:Buffer):Array<[Buffer,Buffer]> {
 if(b.length<4)throw Error('Invalid block');const end=b.length-4-4*b.readUInt32LE(b.length-4);if(end<0)throw Error('Invalid restart table');
 const c={p:0},rows:Array<[Buffer,Buffer]>=[];let previous=Buffer.alloc(0);
 while(c.p<end){const shared=varint(b,c),n=varint(b,c),v=varint(b,c);if(shared>previous.length)throw Error('Invalid prefix');const key=Buffer.concat([previous.subarray(0,shared),slice(b,c,n)]);rows.push([key,slice(b,c,v)]);previous=key;}return rows;
}
function block(file:Buffer,handle:Buffer):Buffer {const c={p:0},offset=varint(handle,c),size=varint(handle,c);if(offset+size+5>file.length)throw Error('Invalid block handle');const b=file.subarray(offset,offset+size),type=file[offset+size];if(type===0)return b;if(type===1)return snappy(b);throw Error('Unsupported compression');}
export function readChromiumPreference(directory:string,origin:string,key:string):{found:boolean;value?:string} {
 const wanted=Buffer.from(`_${origin}\0\x01${key}`);let latest=-1n,value:Buffer|undefined;
 const accept=(k:Buffer,v:Buffer|undefined,seq:bigint)=>{if(k.equals(wanted)&&seq>latest){latest=seq;value=v;}};
 let names:string[];try{names=readdirSync(directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {found:false};throw e;}
 for(const name of names){if(!/\.(log|ldb|sst)$/.test(name))continue;const f=readFileSync(path.join(directory,name));
  if(/\.(ldb|sst)$/.test(name)){
   if(f.length<48||f.readBigUInt64LE(f.length-8)!==0xdb4775248b80fb57n)throw Error('Invalid LevelDB table');
   const footer=f.subarray(f.length-48),c={p:0};varint(footer,c);varint(footer,c);
   for(const [,handle] of entries(block(f,footer.subarray(c.p))))for(const [k,v] of entries(block(f,handle))){if(k.length<8)continue;const tag=k.readBigUInt64LE(k.length-8);accept(k.subarray(0,-8),(tag&255n)===1n?v:undefined,tag>>8n);}
  }else{
   let parts:Buffer[]=[];
   for(let p=0;p+7<=f.length;){const remain=32768-(p%32768);if(remain<7){p+=remain;continue;}const n=f.readUInt16LE(p+4),type=f[p+6];if(!n&&!type){p+=remain;continue;}if(p+7+n>f.length)break;const fragment=f.subarray(p+7,p+7+n);p+=7+n;
    if(type===1)parts=[fragment];else if(type===2){parts=[fragment];continue;}else if(type===3){parts.push(fragment);continue;}else if(type===4)parts.push(fragment);else throw Error('Invalid log record');
    const b=Buffer.concat(parts);parts=[];if(b.length<12)throw Error('Invalid write batch');const seq=b.readBigUInt64LE(),count=b.readUInt32LE(8),c={p:12};
    for(let i=0;i<count;i++){const type=slice(b,c,1)[0],k=slice(b,c,varint(b,c));if(type!==0&&type!==1)throw Error('Invalid batch entry');const v=type===1?slice(b,c,varint(b,c)):undefined;accept(k,v,seq+BigInt(i));}
   }
  }
 }
 if(latest<0n)return {found:false};if(!value)return {found:true};
 if(value[0]!==0&&value[0]!==1)throw Error('Unknown Chromium string encoding');
 return {found:true,value:value.subarray(1).toString(value[0]===0?'utf16le':'latin1')};
}
