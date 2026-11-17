import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { mock } from 'node:test';
import { Aedes } from 'aedes';
import { CloudPush } from '../dist/store/cloud-push.js';
import { RuntimeUplink, RemoteRuntime } from '../dist/store/runtime-relay.js';
import { AccountSession } from '../dist/account/session.js';

// Trust a temporary local broker CA in a child process. Production TLS verification stays enabled.
if (!process.env.ADING_MQTT_TEST_CERT) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ading-mqtt-tls-'));
  try {
    await writeFile(path.join(dir, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-config', path.join(dir, 'openssl.cnf')], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'temporary TLS fixture creation failed');
    const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
      env: { ...process.env, ADING_MQTT_TEST_CERT: dir, NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem') }, stdio: 'inherit', timeout: 30000
    });
    assert.equal(child.status, 0, 'MQTT integration tests failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
} else {
  const cert = process.env.ADING_MQTT_TEST_CERT;
  const broker = await Aedes.createBroker();
  const server = tls.createServer({ key: await readFile(path.join(cert, 'key.pem')), cert: await readFile(path.join(cert, 'cert.pem')) }, broker.handle);
  const connections = []; const reports = []; const logs = [];
  let deniedSubscriptions = 0;
  const accountTopic = 'deliver/user/u_owner'; const terminalTopic = 'deliver/terminal/d_mac';
  broker.authenticate = (client, username, password, done) => done(null, username === 'Token|key|instance' && password.toString() === 'R|read|W|write');
  broker.authorizeSubscribe = (client, subscription, done) => {
    if (![accountTopic, terminalTopic].includes(subscription.topic)) { deniedSubscriptions++; done(new Error('outside terminal ACL')); }
    else done(null, subscription);
  };
  broker.on('clientReady', client => connections.push(client));
  broker.on('publish', (packet, client) => { if (client) reports.push({ topic: packet.topic, ...JSON.parse(packet.payload.toString()) }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const credentials = () => ({ enabled: true, terminalId: 'd_mac', brokerUrl: `mqtts://127.0.0.1:${server.address().port}`, clientId: 'GID_TERMINAL@@@d_mac', username: 'Token|key|instance', password: 'R|read|W|write', subscriptions: [accountTopic, terminalTopic], reportTopic: 'report_pre/d_mac', expiresAt: Date.now() + 3600000, keepAliveSeconds: 20 });
  const until = async (predicate, message) => {
    const deadline = Date.now() + 6000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), message);
  };
  let connected = 0, disconnected = 0, requested = 0;
  const changes = [], progress = [];
  const controls = [], verifications = [];
  const push = new CloudPush({
    credentials: async () => { requested++; return credentials(); },
    onConversationChanged: id => changes.push(id), onConnected: () => connected++, onDisconnected: () => disconnected++,
    onConversationControl: (type, payload) => controls.push({ type, payload }),
    onAgentVerificationRequested: agentUserId => verifications.push(agentUserId),
    onTurnProgress: frame => progress.push(frame), log: (event, data) => logs.push({ event, data }), maxRetryMs: 20 });
  const deliver = (topic, frame) => new Promise((resolve, reject) => broker.publish({ topic, payload: Buffer.from(JSON.stringify(frame)), qos: 1 }, error => error ? reject(error) : resolve()));
  let denied, renewing;
  try {
    push.start();
    await until(() => connected === 1, 'MQTT ready only after subscriptions succeed');
    await new Promise((resolve, reject) => broker.publish({ topic: accountTopic, payload: Buffer.from(JSON.stringify({ type: 'MESSAGE_NEW', payload: { conversationId: 'task' } })), qos: 1 }, error => error ? reject(error) : resolve()));
    await until(() => changes.includes('task'), 'account MQTT event triggers durable message pull');
    for (const type of ['CONVERSATION_CONTROL', 'CONVERSATION_CONTROL_ACCEPTED', 'CONVERSATION_CONTROL_RESULT'])
      await deliver(terminalTopic, { type, payload: { requestId: 'request', conversationId: 'task', action: 'pause' } });
    await until(() => controls.length === 3, 'task controls and acknowledgements reach the control handler');
    assert.deepEqual(changes, ['task'], 'control frames do not replay user messages');
    await deliver(terminalTopic, { type: 'AGENT_VERIFY_REQUEST', payload: { agentUserId: 'u_home_cc' } });
    await until(() => verifications.includes('u_home_cc'), 'single Agent verification request reaches its computer');
    await deliver(accountTopic, { type: 'MESSAGE_NEW', payload: { conversationId: 'phone', seq: 3, messageId: 'm_1', content: 'phone body' } });
    await until(() => changes.includes('phone'), 'pushed task is handed to catch-up pull');
    assert.ok(!JSON.stringify(logs).includes('phone body'), 'push logs record identifiers only, never message bodies');
    assert.equal(push.send('TURN_PROGRESS', { conversationId: 'task', agentUserId: 'agent', busy: true }), true);
    await until(() => reports.length > 0, 'progress reaches environment-specific report topic');
    assert.equal(reports[0].topic, 'report_pre/d_mac');
    assert.ok(reports[0].eventId); assert.equal(typeof reports[0].sentAt, 'number');
    const before = connected;
    connections.at(-1).close();
    await until(() => connected > before, 'broker disconnect reconnects and invokes catch-up callback');
    assert.ok(requested >= 2, 'reconnect obtains credentials again');
    const beforePause = connected, beforeDisconnect = disconnected;
    push.pause();
    assert.equal(disconnected, beforeDisconnect + 1, 'sleep clears remote runtime state');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(connected, beforePause); assert.equal(push.send('TURN_PROGRESS', {}), false);
    push.resume(); await until(() => connected > beforePause, 'wake reconnects');
    push.stop();
    // Renewal keeps the same clientId, so the broker takes over the old session: make-before-break, no disconnect.
    let renewRequests = 0, renewedConnections = 0, renewDisconnects = 0;
    const renewChanges = [];
    renewing = new CloudPush({
      credentials: async () => ({ ...credentials(), clientId: 'GID_TERMINAL@@@renewal', expiresAt: ++renewRequests === 1 ? Date.now() + 90010 : Date.now() + 3600000 }),
      onConversationChanged: id => renewChanges.push(id), onConnected: () => { renewedConnections++; },
      onDisconnected: () => { renewDisconnects++; }, log: (event, data) => logs.push({ event, data }), maxRetryMs: 20 });
    renewing.start();
    await until(() => renewedConnections === 2, 'expiring credentials are fetched again before expiry and catch-up runs');
    assert.equal(renewRequests, 2);
    assert.ok(logs.some(log => log.event === 'cloud-mqtt-renewed'), 'replacement connected before the old one retired');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(renewDisconnects, 0, 'credential renewal never reports a disconnect (in-flight controls and remote busy survive)');
    assert.equal(renewRequests, 2, 'takeover of the old session does not trigger another reconnect');
    const reportsBefore = reports.length;
    assert.equal(renewing.send('TURN_PROGRESS', { conversationId: 'renewed' }), true, 'renewed channel can report');
    await until(() => reports.length > reportsBefore, 'report goes through the renewed connection');
    await deliver(accountTopic, { type: 'MESSAGE_NEW', payload: { conversationId: 'after-renewal' } });
    await until(() => renewChanges.includes('after-renewal'), 'renewed connection receives pushes');
    renewing.stop();
    // Replacement connection fails: only then is it a real disconnect, followed by a normal retry.
    let failRequests = 0, failConnected = 0, failDisconnects = 0;
    const failing = new CloudPush({
      credentials: async () => {
        failRequests++;
        if (failRequests === 2) throw new Error('credentials endpoint down');
        return { ...credentials(), clientId: 'GID_TERMINAL@@@renew-fail', expiresAt: failRequests === 1 ? Date.now() + 90010 : Date.now() + 3600000 };
      },
      onConversationChanged() {}, onConnected: () => { failConnected++; }, onDisconnected: () => { failDisconnects++; },
      log: (event, data) => logs.push({ event, data }), maxRetryMs: 20 });
    try {
      failing.start();
      await until(() => failConnected === 2, 'failed renewal falls back to a normal reconnect');
      assert.equal(failDisconnects, 1, 'failed renewal is reported as one disconnect');
      assert.ok(logs.some(log => log.event === 'cloud-mqtt-renew-failed' && log.data.reason === 'credentials-failed'));
    } finally { failing.stop(); }
    let deniedConnected = false;
    denied = new CloudPush({
      credentials: async () => ({ ...credentials(), clientId: 'GID_TERMINAL@@@denied', subscriptions: ['deliver/user/someone_else'] }),
      onConversationChanged() {}, onConnected: () => { deniedConnected = true; }, log: (event, data) => logs.push({ event, data }), maxRetryMs: 30 });
    const closedBefore = logs.filter(log => log.event === 'cloud-mqtt-closed').length;
    denied.start();
    await until(() => deniedSubscriptions > 0 && logs.filter(log => log.event === 'cloud-mqtt-closed').length > closedBefore, 'unauthorized subscription rejected');
    assert.equal(deniedConnected, false, 'denied subscribe never appears ready');
    const closed = logs.filter(log => log.event === 'cloud-mqtt-closed')[closedBefore];
    assert.equal(closed.data.phase, 'subscribing', 'a broker-side close says which step it stopped at');
    // When the broker is unreachable, the error log carries the concrete reason (e.g. ECONNREFUSED), not just an event name
    const unreachableLogs = [];
    const unreachable = new CloudPush({
      credentials: async () => ({ ...credentials(), clientId: 'GID_TERMINAL@@@unreachable', brokerUrl: 'mqtts://127.0.0.1:1' }),
      onConversationChanged() {}, onConnected() {}, log: (event, data) => unreachableLogs.push({ event, data }), maxRetryMs: 30 });
    try {
      unreachable.start();
      await until(() => unreachableLogs.some(log => log.event === 'cloud-mqtt-error'), 'unreachable broker logs an error');
      const error = unreachableLogs.find(log => log.event === 'cloud-mqtt-error');
      assert.match(error.data.reason, /ECONNREFUSED/, 'error log carries the concrete cause: ' + error.data.reason);
      assert.equal(unreachableLogs.find(log => log.event === 'cloud-mqtt-closed')?.data.phase ?? 'connecting', 'connecting');
    } finally { unreachable.stop(); }
    denied.stop();
    assert.ok(!JSON.stringify(logs).includes('R|read|W|write'), 'logs never include MQTT password');
  } finally {
    push.stop(); denied?.stop(); renewing?.stop();
    for (const client of Object.values(broker.clients)) client.close();
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }

  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const frames = [];
    const uplink = new RuntimeUplink(frame => frames.push(frame));
    uplink.push('agent:busy', { conversationId: 'task', agentUserId: 'agent', busy: true });
    mock.timers.tick(10000);
    assert.equal(frames.length, 2, 'busy status repeats after ten seconds');
    uplink.push('agent:busy', { conversationId: 'task', agentUserId: 'agent', busy: false });
    const ended = frames.length; mock.timers.tick(30000); assert.equal(frames.length, ended, 'ended turns stop repeating');
    uplink.reset();
  } finally { mock.timers.reset(); }
  const remote = new RemoteRuntime(() => false);
  remote.apply({ conversationId: 'task', agentUserId: 'agent', busy: true, sentAt: 100 });
  remote.apply({ conversationId: 'task', agentUserId: 'agent', busy: false, sentAt: 200 });
  assert.deepEqual(remote.apply({ conversationId: 'task', agentUserId: 'agent', busy: true, sentAt: 100 }), [], 'late/duplicate start cannot revive stopped turn');
  remote.apply({ conversationId: 'task', agentUserId: 'agent', busy: true, sentAt: 300 });
  assert.equal(remote.expire(Date.now() + 30001)[0].payload.busy, false, 'thirty-second expiry clears lost stop');
  // Frames relayed by the server always carry sentAt; a frame without it is synthesized locally (e.g. clearing busy after a remote pause).
  remote.apply({ conversationId: 'task', agentUserId: 'agent', busy: true, sentAt: 400 });
  assert.equal(remote.apply({ conversationId: 'task', agentUserId: 'agent', busy: false })[0].payload.busy, false, 'local synthetic stop applies without sentAt');
  assert.deepEqual(remote.apply({ conversationId: 'task', agentUserId: 'agent', busy: true, sentAt: 350 }), [], 'local stop keeps the relayed ordering watermark');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'ading-terminal-token-'));
  try {
    const file = path.join(dir, 'session');
    await writeFile(file, JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', user: { userId: 'owner', username: 'owner' }, computer: { terminalId: 't_mac', name: 'Home', nodeToken: 'old', fingerprint: 'hardware' } }));
    const account = new AccountSession({ file, baseUrl: 'https://unused.invalid',
      secrets: { available: async () => true, encrypt: async plain => Buffer.from(plain), decrypt: async data => data.toString() },
      fetch: async () => { throw new Error('loading a session must not call the server'); }
    });
    await account.init();
    assert.equal(account.computer()?.terminalId, 't_mac', 'current registration is restored');
    assert.equal(account.status().user?.userId, 'owner', 'the account stays signed in');
  } finally { await rm(dir, { recursive: true, force: true }); }
  console.log('mqtt: TLS pub/sub, report routing, reconnect, sleep/wake, ACL rejection, busy expiry/order and terminal session restoration passed');
}
