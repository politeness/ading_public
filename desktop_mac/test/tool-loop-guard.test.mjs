import assert from 'node:assert/strict';
import {ToolLoopGuard} from '../dist/agents/tool-loop-guard.js';

const visual=new ToolLoopGuard();
for(let i=0;i<4;i++)assert.equal(visual.observe('imageView'),undefined);
assert.match(visual.observe('imageView'),/同一对象已重复查看 5 次/,'an unnamed viewer keeps looking at the same thing');
assert.equal(visual.observe('imageView'),undefined,'a visual threshold is nudged once, not spammed');
for(let i=6;i<59;i++)visual.observe(`other-${i}`);
assert.match(visual.observe('other-60'),/本轮工具动作已达 60 次/,'a later long-run regression gets its own nudge');

const generation=new ToolLoopGuard();
for(let i=0;i<3;i++)assert.equal(generation.observe('imageGeneration'),undefined);
assert.match(generation.observe('imageGeneration'),/同类生成动作已达 4 次/);

const longRun=new ToolLoopGuard();
for(let i=0;i<59;i++)assert.equal(longRun.observe(`tool-${i}`),undefined);
assert.match(longRun.observe('tool-59'),/本轮工具动作已达 60 次/);

// Reading many different images is the task, not a loop: the 4 source photos and
// the 8 generated crops of a wrong-answer book must never trip the guard.
const survey=new ToolLoopGuard();
for(let i=0;i<12;i++)assert.equal(survey.observe('Read',{file_path:`/tmp/page-${i}.png`}),undefined,'distinct images are ordinary work');

const stuck=new ToolLoopGuard();
for(let i=0;i<4;i++)assert.equal(stuck.observe('Read',{file_path:'/tmp/page-0.png'}),undefined);
assert.match(stuck.observe('Read',{file_path:'/tmp/page-0.png'}),/同一对象已重复查看 5 次/,'re-reading one image is the loop worth interrupting');

// Churn spread across objects still gets caught, but only past the first looks.
const churn=new ToolLoopGuard();
for(let i=0;i<6;i++)churn.observe('Read',{file_path:`/tmp/shot-${i}.png`});
let churnNotice;
for(let pass=0;pass<2&&!churnNotice;pass++)for(let i=0;i<6&&!churnNotice;i++)churnNotice=churn.observe('Read',{file_path:`/tmp/shot-${i}.png`});
assert.match(churnNotice,/重复查看已累计 8 次/,'redundant re-looks accumulate across objects');

// One verify-fix-verify cycle over a real deliverable stays under the threshold.
const verify=new ToolLoopGuard();
for(const file of ['IMG_0952.JPG','IMG_0953.JPG','IMG_0954.JPG','IMG_0955.JPG','q1.jpg','q4.jpg','q4.jpg','q1.jpg'])
 assert.equal(verify.observe('Read',{file_path:`/tmp/${file}`}),undefined,'checking work after a fix is not a loop');

// Codex app-server imageView items are {type,id,path}: distinct paths are
// distinct objects, and only re-viewing the same path is a loop.
const codexSurvey=new ToolLoopGuard();
for(let i=0;i<12;i++)assert.equal(codexSurvey.observe('imageView',{type:'imageView',id:`v${i}`,path:`/tmp/crop-${i}.png`}),undefined,'codex viewing different images is not a loop');
const codexStuck=new ToolLoopGuard();
for(let i=0;i<4;i++)assert.equal(codexStuck.observe('imageView',{type:'imageView',id:`s${i}`,path:'/tmp/crop-0.png'}),undefined);
assert.match(codexStuck.observe('imageView',{type:'imageView',id:'s4',path:'/tmp/crop-0.png'}),/同一对象已重复查看 5 次/,'codex re-viewing one path is caught');

const textRead=new ToolLoopGuard();
for(let i=0;i<12;i++)assert.equal(textRead.observe('Read',{file_path:`/tmp/source-${i}.ts`}),undefined,'ordinary source reads are not image-loop false positives');
console.log('tool-loop-guard: per-object visual repeats, distinct-image surveys, generation and long-run staged steering thresholds passed');
