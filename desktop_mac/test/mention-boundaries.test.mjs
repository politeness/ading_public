import assert from 'node:assert/strict';
import {resolveMentions} from '../dist/ui/mentions.js';
const options=[{label:'Alice',userId:'alice'},{label:'Qoder',userId:'q'},{label:'Qoder CN',userId:'qcn'}];
for(const prefix of ['', '正文', 'English text', '正文，', '正文。', '看看：', 'line\n', '正文 ']) {
 assert.deepEqual(resolveMentions(`${prefix}@Alice 帮忙`,options),['alice'],`a selected mention after ${JSON.stringify(prefix)} resolves`);
 assert.deepEqual(resolveMentions(`${prefix}@Qoder CN 帮忙`,options),['qcn'],'the longest matching name is still selected');
}
assert.deepEqual(resolveMentions('正文@Alice 请看，@Qoder CN 帮忙。@Alice 谢谢',options),['alice','qcn'],'multiple adjacent-text mentions are found and deduplicated');
assert.deepEqual(resolveMentions('正文@Alice 帮忙',[]),[],'unpicked names are still ordinary text');
assert.deepEqual(resolveMentions('mail@Alice.com https://example.test/@Alice/path',options),[],'email addresses and URLs are not interpreted as picked mentions');
assert.deepEqual(resolveMentions('正文@Qoder CN (Home Mac) #2 帮忙',[{label:'Qoder CN (Home Mac) #2',userId:'other-mac'}]),['other-mac'],'computer labels keep their member identity');
console.log('mention-boundaries: start, Chinese/English text, punctuation, newlines, longest names, distinct members, deduplication and email/URL protection passed');
