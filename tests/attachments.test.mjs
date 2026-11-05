import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENT_BYTES, validateAttachments, attachmentParts } from '../functions/_lib/attachments.js';
import { sanitizeStoredMessage } from '../functions/_lib/store.js';
import { toWire } from '../functions/_lib/memory.js';

test('attachments validate, persist and become model content parts', () => {
  const attachments = validateAttachments([{ name: 'note.txt', type: 'text/plain', data: btoa('hello') }]);
  const stored = sanitizeStoredMessage({ role: 'user', content: 'read', attachments });
  assert.equal(stored.attachments.length, 1);
  assert.match(toWire(stored).content[1].text, /hello/);
  assert.equal(attachmentParts([{ name: 'a.png', type: 'image/png', data: 'AAAA' }])[0].type, 'image_url');
  assert.equal(attachmentParts([{ name: 'a.bin', type: 'application/octet-stream', data: 'AP8=' }])[0].type, 'file');
});
test('reject malformed, excessive counts and oversized attachments', () => {
  assert.throws(() => validateAttachments([{ name: 'a', data: '!' }]));
  assert.throws(() => validateAttachments(Array(6).fill({ name: 'a', data: '' })));
  assert.throws(() => validateAttachments([{ name: 'a', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }]));
  assert.deepEqual(validateAttachments(undefined), []);
});
test('accept exactly 20 MB, including aggregate limits across files', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 20_000_000);
  const data = Buffer.alloc(10_000_000).toString('base64');
  assert.equal(validateAttachments([{ name: 'a', data }, { name: 'b', data }]).length, 2);
  assert.throws(() => validateAttachments([{ name: 'a', data }, { name: 'b', data }, { name: 'c', data: 'AA==' }]));
});
