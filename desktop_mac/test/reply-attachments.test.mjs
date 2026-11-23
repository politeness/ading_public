import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localReplyAttachments, prepareReplyAttachments } from '../dist/orchestration/reply-attachments.js';
import { AttachmentVault } from '../dist/store/attachments.js';
import { LocalStore } from '../dist/store/local.js';
import { LocalScheduler } from '../dist/orchestration/local-scheduler.js';
import { setMainLanguage } from '../dist/i18n.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'ading-reply-attachments-'));
const outside = await mkdtemp(path.join(os.tmpdir(), 'ading-reply-outside-'));
const file = path.join(root, '中文 图 (1).png');
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let store;
let scheduler;
try {
  await writeFile(file, bytes);
  await symlink(file, path.join(root, 'alias.png'));
  const vault = new AttachmentVault(path.join(root, 'vault'));
  let imports = 0;
  const prepare = content => prepareReplyAttachments({ content, references: localReplyAttachments(content), workspacePath: root,
    importAttachment: async file => { imports++; return vault.importFile(file); } });
  const raw = `这是截图：\n![预览](<${file}>)\n[下载原图](${pathToFileURL(file).href})\n![重复](./alias.png)\n[官网](https://example.com/image.png)`;
  const result = await prepare(raw);
  assert.equal(result.attachments.length, 1, 'absolute, file URL and symlink references share one attachment');
  assert.equal(imports, 1);
  assert.deepEqual(await readFile(vault.pathFor(result.attachments[0])), bytes);
  assert.equal(result.content, '这是截图：\n预览\n下载原图\n重复\n[官网](https://example.com/image.png)');

  for (const link of [`![图](${file})`, `![图](${encodeURI(file)})`, '![图](中文 图 (1).png "标题")', '![图](中文 图 \\(1\\).png)']) {
    const prepared = await prepare(link);
    assert.equal(prepared.attachments?.length, 1, link);
    assert.equal(prepared.content, '图');
  }
  const examples = [
    '`![示例](secret.png)`', '``[图](secret.png)``', '```md\n![示例](secret.png)\n```',
    '~~~\n[图](secret.png)\n~~~', '    ![示例](secret.png)', '\\![示例](secret.png)',
    '\\[示例](secret.png)', '/tmp/secret.png', '![网络](https://example.com/a.png)',
    '[源码](/fixture/source.ts:50)', '[源码列](/fixture/source.ts:50:4)', '[章节](#section)', '![网络](//example.com/a.png)', '![远程文件](file://example.com/a.png)', '![数据](data:image/png;base64,abc)',
    '![不完整](secret.png', '```\n![未闭合代码](secret.png)'
  ];
  for (const example of examples) assert.deepEqual(localReplyAttachments(example), [], example);
  assert.equal(localReplyAttachments('`![示例](secret.png)`\n![图](real.png)').length, 1, 'real delivery after code is retained');

  for (const language of ['zh-CN', 'en']) {
    setMainLanguage(language);
    const missing = await prepare('![丢失](missing.png)');
    assert.equal(missing.attachments, undefined);
    assert.ok(missing.content.startsWith('丢失\n\n'), 'failed delivery preserves caption');
    assert.deepEqual(localReplyAttachments(missing.content), [], 'failed delivery leaves no clickable local URL');
    assert.match(missing.content, language === 'en' ? /Attachment not sent/ : /附件未发送/);
  }
  setMainLanguage('zh-CN');

  // Only files inside the workspace: no escaping through absolute paths,
  // ../, ~/ or a symlink.
  const secret = path.join(outside, 'secret.txt'), privatePng = path.join(outside, 'private.png');
  await writeFile(secret, 'token=abc');
  await writeFile(privatePng, bytes);
  await symlink(secret, path.join(root, 'evil.png'));
  await symlink(privatePng, path.join(root, 'escape.png'));
  await writeFile(path.join(root, 'fake.png'), 'not an image');
  await writeFile(path.join(root, 'icon.svg'), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
  const refused = [
    ['![a](./evil.png)', /文件不在会话工作区内/], ['![a](escape.png)', /文件不在会话工作区内/],
    [`![a](${privatePng})`, /文件不在会话工作区内/], [`![a](../${path.basename(outside)}/private.png)`, /文件不在会话工作区内/],
  ];
  for (const [link, reason] of refused) {
    imports = 0;
    const prepared = await prepare(link);
    assert.equal(prepared.attachments, undefined, link);
    assert.equal(imports, 0, link);
    assert.deepEqual(localReplyAttachments(prepared.content), [], link);
    assert.match(prepared.content, reason, link);
  }
  assert.equal((await prepare('![矢量](icon.svg)')).attachments?.length, 1, 'svg detected by content');
  for (const name of ['报告.pdf', 'sheet.xlsx', 'doc.docx', 'slides.pptx', 'archive.zip', 'audio.mp3', 'movie.mp4', 'custom.unknown', 'README', 'empty.bin', 'fake.png']) {
    const payload = name === 'empty.bin' ? Buffer.alloc(0) : Buffer.from(`file bytes: ${name}`);
    await writeFile(path.join(root, name), payload);
    const delivered = await prepare(`[下载](<${name}>)`);
    assert.equal(delivered.attachments?.length, 1, name);
    assert.deepEqual(await readFile(vault.pathFor(delivered.attachments[0])), payload, name);
    assert.equal(delivered.content, '下载');
  }
  const directory = await prepare('[目录](vault)');
  assert.equal(directory.attachments, undefined);
  assert.equal(directory.content, '[目录](vault)', 'a directory link is a citation, left as written');
  assert.match((await prepare('![目录](vault)')).content, /路径不是文件/, 'an image embed still reports failure');

  // Citations are not deliveries: non-image links outside the workspace or to
  // missing paths stay clickable and add no failure notice.
  await writeFile(path.join(root, 'notes.md'), '# notes');
  const citations = [
    `改动见 [secret.txt](${secret}) 和 [源码](../${path.basename(outside)}/secret.txt)`,
    '[不存在](missing.md)', '[不存在锚点](missing.md#L3)', `[外部锚点](<${secret}#L1>)`, '[子路径](notes.md/child.txt)'
  ];
  for (const citation of citations) {
    imports = 0;
    const kept = await prepare(citation);
    assert.equal(kept.content, citation, citation);
    assert.equal(kept.attachments, undefined, citation);
    assert.equal(imports, 0, citation);
  }
  const anchored = await prepare('[说明](notes.md#L3) 与 [全文](notes.md)');
  assert.equal(anchored.attachments, undefined, 'section links and ordinary file references are citations');
  assert.equal(anchored.content, '[说明](notes.md#L3) 与 [全文](notes.md)');
  // Reproduce ordinary answers citing a skill/release record, both inside and
  // outside the conversation workspace. No import attempt and no failure notice.
  for (const name of ['SKILL.md', 'release-result.md']) {
    await writeFile(path.join(root, name), 'reference only');
    await writeFile(path.join(outside, name), 'external reference only');
    for (const destination of [path.join(root, name), path.join(outside, name)]) {
      for (const link of [`[${name}](<${destination}>)`, `[${name}](${pathToFileURL(destination).href})`]) {
        imports = 0;
        assert.deepEqual(localReplyAttachments(link), []);
        const kept = await prepare(`依据见 ${link}。`);
        assert.equal(kept.content, `依据见 ${link}。`);
        assert.equal(kept.attachments, undefined);
        assert.equal(imports, 0);
      }
    }
  }
  for (const citation of ['[源码图片](alias.png)', '[下载](notes.md#L3)',
    `[下载](${pathToFileURL(path.join(root, 'notes.md')).href}#section)`, '[源码](notes.md:3:4)']) {
    assert.deepEqual(localReplyAttachments(citation), [], citation);
  }
  for (const label of ['下载记录', '附件：记录', 'Download record', 'Attachment: record']) {
    const sent = await prepare(`[${label}](release-result.md)`);
    assert.equal(sent.attachments?.length, 1);
    assert.equal(sent.content, label);
  }
  for (const language of ['zh-CN', 'en']) {
    setMainLanguage(language);
    for (const destination of ['missing.pdf', secret, 'vault']) {
      imports = 0;
      const failed = await prepare(`[下载文件](<${destination}>)`);
      assert.equal(failed.attachments, undefined);
      assert.equal(imports, 0);
      assert.match(failed.content, language === 'en' ? /Attachment not sent/ : /附件未发送/);
    }
    for (const code of ['ATTACHMENT_TOO_LARGE', 'EACCES']) {
      const content = '[下载文件](notes.md)';
      const failed = await prepareReplyAttachments({ content, references: localReplyAttachments(content), workspacePath: root,
        importAttachment: async () => { throw new Error(code); } });
      assert.equal(failed.attachments, undefined);
      assert.match(failed.content, language === 'en' ? /Attachment not sent/ : /附件未发送/);
    }
  }
  setMainLanguage('zh-CN');
  const mixed = await prepare(`[外部](${secret})\n![丢失](missing.png)`);
  assert.equal(mixed.content, `[外部](${secret})\n丢失\n\n附件未发送：missing.png（无法读取或保存文件）。`);
  const many = [];
  for (let i = 0; i < 10; i++) {
    await writeFile(path.join(root, `${i}.png`), bytes);
    many.push(`![图${i}](${i}.png)`);
  }
  const limited = await prepare(many.join('\n'));
  assert.equal(limited.attachments.length, 9);
  assert.deepEqual(localReplyAttachments(limited.content), [], 'mixed success/failure replaces all local links');
  assert.match(limited.content, /附件未发送：9.png（每条消息最多 9 个附件）/);

  // Actual scheduler -> durable message, with a transient save failure. Import
  // once and retry the same attachment IDs, never duplicate or discard the reply.
  store = new LocalStore(path.join(root, 'store'));
  await store.init();
  const [agent] = await store.syncDiscoveredAgents([{ kind: 'codex', localUuid: 'image-test', version: 'test', executablePath: '/mock' }]);
  const me = await store.currentUser();
  const conversation = await store.createConversation({ name: '图片交付', memberIds: [agent.userId] });
  await store.appendMessage({ conversationId: conversation.conversationId, senderId: me.userId, clientMessageId: 'ask', content: '直接发图' });
  const append = store.appendMessage.bind(store), importFile = store.importAttachment.bind(store);
  let attempts = 0, schedulerImports = 0;
  const attachmentIds = [];
  store.importAttachment = file => { schedulerImports++; return importFile(file); };
  store.appendMessage = async input => {
    if (input.agentReply) {
      attachmentIds.push(input.attachments.map(a => a.attachmentId));
      if (++attempts === 1) throw Error('temporary write failure');
    }
    return append(input);
  };
  scheduler = new LocalScheduler({ idleRetryLimit: 0, teamMonitorIntervalMs: 0, store,
    registry: { runTurn: async () => ({ ok: true, message: raw + "\n[下载文档](报告.pdf)", steps: [], metrics: { iterations: 1, sideEffects: false } }) },
    syncer: { ensureSynced: async () => [] }, resolveWorkspace: async () => ({ workspacePath: root, sharesKnowledge: false }),
    resolveDiscovered: () => ({ kind: 'codex', localUuid: 'image-test' }), isAgentReady: () => true,
    broadcast: () => {}, log: async () => {} });
  await scheduler.runAgentTurn(conversation, agent);
  const replies = (await store.listMessages(conversation.conversationId)).filter(m => m.agentReply);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].content, result.content + "\n下载文档");
  assert.equal(schedulerImports, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(attachmentIds[0], attachmentIds[1]);
  const saved = replies[0].attachments[0];
  await rm(file);
  assert.deepEqual(await readFile(await store.attachmentFile(conversation.conversationId, saved)), bytes, 'attachment survives removal of source');
  await store.close();
  store = new LocalStore(path.join(root, 'store'));
  await store.init();
  assert.deepEqual((await store.listMessages(conversation.conversationId)).find(m => m.agentReply).attachments, replies[0].attachments, 'metadata survives restart');
  console.log('reply-attachments: delivery links, code exclusion, captions, missing files, workspace/type boundaries, limits, localization, scheduler retry and durable bytes passed');
} finally {
  await scheduler?.shutdown();
  await store?.close();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
