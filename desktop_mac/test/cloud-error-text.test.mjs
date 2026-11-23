import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { cloudErrorText, setMainLanguage } from '../dist/i18n.js';
import { cloudErrorMessages } from '../dist/locales/cloud-errors.js';

// Every conductor error code needs client text: the server message is English only and is never shown.
const dir = new URL('../../conductor/src/main/java/com/politeness/ading/conductor/error/', import.meta.url);
const codes = new Set();
for (const file of await readdir(dir)) {
  if (!file.endsWith('Error.java')) continue;
  for (const match of (await readFile(new URL(file, dir), 'utf8')).matchAll(/\(\s*"([A-Z]+_\d{3})"\s*,/g)) codes.add(match[1]);
}
assert.ok(codes.size > 50, 'conductor error codes were found');
const known = new Set(Object.keys(cloudErrorMessages).map(key => key.slice('cloud.error.'.length)));
assert.deepEqual([...codes].filter(code => !known.has(code)), [], 'every conductor code has client text');
assert.deepEqual([...known].filter(code => !codes.has(code)), [], 'no client text for removed codes');

setMainLanguage('zh-CN');
assert.equal(cloudErrorText('AUTH_002'), '用户名或密码不正确');
setMainLanguage('en');
assert.equal(cloudErrorText('AUTH_002'), 'Incorrect username or password');
assert.equal(cloudErrorText('AUTH_999'), undefined, 'unknown codes fall back to the caller');
assert.equal(cloudErrorText('OK'), undefined);
assert.equal(cloudErrorText(undefined), undefined);
assert.equal(cloudErrorText('constructor'), undefined);
setMainLanguage('zh-CN');
console.log('cloud-error-text: every conductor code localized, unknown codes fall back');
