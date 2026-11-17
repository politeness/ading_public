import assert from 'node:assert/strict';
import {interpretProposalReply as interpret} from '../dist/orchestration/proposal-reply.js';
const id='assignment-current';
for (const text of [
 '方案同意。范围清晰，能力范围内可以执行，没有冲突。确认接受分工 review_q15。',
 '范围清晰，纯只读核查，题号模糊时标注“无法确认”并记录位置，不推断续题关系。确认接受分工 source_integrity_review。',

 '同意，我按这个方案执行：直接从原图裁取第7题可见残片、保留原有断边，不生成新内容，先核实范围内有无手写重叠再决定是否需要清除，输出到 drafts/xiaocc/0954_q07_visible.png。',
 '同意，我按这个方案执行：逐张只读查看三张源图，列出完整题号、印刷题干、裁剪边界，区分完整题与截断残题，重点核实第8题是否完整，附图像位置证据，不加工图片。',
 '同意，我按这个方案执行：先做第3题裁剪去手写并对照原图核查，再做第5题，输出到 drafts/xiaocc/，遇到手写重叠无法可靠清除会如实报告不算完成。',
 '同意，检查每张图片是否完整。遇到无法确定的内容会明确说明。'
]) { assert.equal(interpret(text,id).action,'accept',text); assert.equal(interpret(text,id).visible,text); }
for (const text of [
 '同意，先核实范围再决定是否接受。',
 '同意，先核实范围再决定是否需要权限。',
 '同意，先核实范围再决定是否需要清除？',
 '同意，先核实范围再决定是否需要清除，等你批准后开始。',
 '同意，但我无法读取源图。', '同意，请核实第8题是否完整后再分给我。',
 '同意，核实第8题是否完整需要权限。', '同意，检查第8题是否完整？',
 '同意，如果不能可靠清除，我需要先获得帮助再执行。',
 '同意，遇到无法读取的情况会如实报告再决定是否接受。',
 '同意，遇到手写重叠无法可靠清除会如实报告。不过我现在无法打开图片。'
]) assert.equal(interpret(text,id).action,'revise',text);
for(const text of ['同意，我按这个方案执行。','收到，方案可执行，我来负责读取原图。','没问题，按方案处理。','I accept this assignment.','好的'])assert.equal(interpret(text,id).action,'accept',text);
for(const text of ['我先确认一下两张原图的情况，再回复是否接受分工。\n<tool-_calls><tool>ls</tool></tool-_calls>','我需要先确认一个关键能力问题再决定。','可以，但我需要先获得权限。','我不同意，建议先给样张。','我无法读取图片。','收到','I cannot accept this.','If the files exist I will proceed.'])assert.equal(interpret(text,id).action,'revise',text);
for(const text of ['', 'SKIP','<image><path>/input.jpg</path></image>','```json\n{"control":{"action":"accept","assignmentId":"old"}}\n```'])assert.equal(interpret(text,id).action,'clarify',text);
assert.equal(interpret('接受。\n'+JSON.stringify({control:{action:'accept',assignmentId:'old'}}),id).action,'clarify');
assert.equal(interpret(JSON.stringify({control:{action:'accept',assignmentId:id}}),id).action,'accept');
assert.equal(interpret(JSON.stringify({control:{action:'revise',assignmentId:id,reason:'需要输入'}}),id).visible,'需要输入');
assert.equal(interpret(JSON.stringify({control:{action:'accept',assignmentId:id}})+'\n\n同意方案。',id).visible,'同意方案。');
assert.equal(interpret(JSON.stringify({control:{action:'accept',assignmentId:'old'}})+'\n\n同意方案。',id).action,'clarify');
assert.equal(interpret('回复如下\n```json\n'+JSON.stringify({control:{action:'accept',assignmentId:id}})+'\n```\n同意。',id).source,'control');
console.log('proposal-reply: natural assent, conditional/negative replies, raw tool-like text and stale controls passed');

assert.equal(interpret('同意。确认后准备执行。',id).action,'accept');
assert.equal(interpret(`同意。\ncontrol action=accept, assignmentId=${id}`,id).action,'accept');
assert.equal(interpret(`已同意，等待执行轮。\ncontrol: {"action":"accept","assignmentId":"${id}"}`,id).action,'accept');
assert.equal(interpret('同意。control action=accept, assignmentId=old',id).action,'clarify');
assert.equal(interpret('同意，等你批准后开始。',id).action,'revise');

for (const text of ['范围、能力和风险均无问题，直接执行。','小q-cn 同意分工。执行时会实际打开输入；无法确定时保留未定结论，不猜补。']) assert.equal(interpret(text,id).action,'accept');

// With an English UI the Agent replies in English: common assent phrases count as acceptance; real conditions and questions still go to the Leader for discussion
for (const text of ['Agreed. I will proceed with the approved route.','Looks good, no concerns. Ready to start.','I agree. If a question number is unreadable, I will report it instead of guessing.'])
  assert.equal(interpret(text,id).action,'accept',text);
for (const text of ['I agree, but I need the source folder path first.','I cannot access the input folder.','Should I also crop the margins?'])
  assert.equal(interpret(text,id).action,'revise',text);
console.log('proposal-reply: English assent and English conditions passed');
