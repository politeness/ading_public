import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareCliEnvironment, buildNodeShim, isElectronExecutable } from '../dist/agents/runtime-environment.js';

const exec=promisify(execFile);
const root=await mkdtemp('/tmp/ading-runtime-test-');
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
const baseEnv={ PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME:root };
const options={ baseEnv, home:root, runtimeDirectory:path.join(root,"runtime with space's"), executablePath:process.execPath };
const result=await prepareCliEnvironment(options);
assert.equal(baseEnv.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
assert.match(result.nodeVersion,/^v\d+\./);
const child=path.join(root,'child.cjs');
await writeFile(child, '#!/usr/bin/env node\nconsole.log("child-ok")\n', {mode:0o700});
const wrapper=path.join(root,'wrapper.cjs');
await writeFile(wrapper, `#!/usr/bin/env node\nrequire('node:child_process').execFileSync(${JSON.stringify(child)},[],{stdio:'inherit'});\n`, {mode:0o700});
assert.equal((await exec(wrapper,[],{env:result.env})).stdout.trim(),'child-ok');
const preserved=await prepareCliEnvironment({...options,baseEnv:{...baseEnv,PATH:path.dirname(process.execPath)+':'+baseEnv.PATH}});
// When PATH already has a real node, no shim should be created. This test may also be run by Electron as node
// (that is how the 2026-09-10 incident was triggered); then there is no node next to execPath, and creating the shim is correct.
assert.equal(preserved.bundled, !existsSync(path.join(path.dirname(process.execPath),'node')));
// Without a shim, the caller's directories must still come first; with a shim, the shim directory comes first,
// and the caller's directories are still kept after it.
if (preserved.bundled) assert.ok(preserved.env.PATH.includes(path.dirname(process.execPath)+path.delimiter));
else assert.ok(preserved.env.PATH.startsWith(path.dirname(process.execPath)+':'));
assert.ok(result.env.PATH.includes(path.join(root,'.local/bin')));
const bin=path.join(root,'.local/bin'); await mkdir(bin,{recursive:true});
for(const [file,version] of [['qoder','qoder-test'],['qodercn','qodercn-test']]) {
 await writeFile(path.join(bin,file),`#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,{mode:0o700});
 assert.equal((await exec(file,['--version'],{env:result.env})).stdout.trim(),version);
}

// Regression: the 2026-09-10 self fork bomb. The shim pointed at the GUI app but omitted ELECTRON_RUN_AS_NODE,
// so `node --version` launched the whole desktop app, whose startup probed node again, looping forever.
// So "is it Electron" must be derived from the target path only, never from a boolean passed by the caller.
const appExecutable='/tmp/x/阿钉.app/Contents/MacOS/阿钉';
assert.ok(isElectronExecutable(appExecutable));
assert.ok(!isElectronExecutable('/usr/bin/node'));
const appShim=buildNodeShim(appExecutable);
assert.match(appShim,/export ELECTRON_RUN_AS_NODE=1/);
assert.ok(appShim.indexOf('ELECTRON_RUN_AS_NODE')<appShim.indexOf('exec '));
assert.ok(!buildNodeShim('/usr/bin/node').includes('ELECTRON_RUN_AS_NODE'));

// The shim must really work as node, and include a nesting-depth circuit breaker.
const shimDir=path.join(root,'shim'); await mkdir(shimDir,{recursive:true});
const shimPath=path.join(shimDir,'node');
await writeFile(shimPath,buildNodeShim(process.execPath),{mode:0o700});
assert.match((await exec(shimPath,['--version'])).stdout.trim(),/^v\d+\./);
await assert.rejects(
  exec(shimPath,['--version'],{env:{...process.env,ADING_NODE_SHIM_DEPTH:'99'}}),
  (error)=>error.code===127
);
// Normal nesting (node -> wrapper script -> child script) must not trip the breaker.
assert.equal((await exec(wrapper,[],{env:{...result.env,PATH:shimDir+':'+result.env.PATH}})).stdout.trim(),'child-ok');

console.log('runtime-environment: 12 passed (Finder PATH, nested Node wrappers, spaces, environment isolation, provider separation, Electron shim self-launch guard)');
