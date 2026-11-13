import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRemoteImageBytes } from '../functions/_lib/image.js';

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('provider image downloader rejects non-HTTPS and private targets before fetching', async () => {
  await withFetch(async () => {
    throw new Error('fetch must not be called for a blocked target');
  }, async () => {
    assert.equal(await fetchRemoteImageBytes('http://images.example/p.png'), null);
    assert.equal(await fetchRemoteImageBytes('https://127.0.0.1/private.png'), null);
    assert.equal(await fetchRemoteImageBytes('https://metadata.google.internal/latest'), null);
  });
});

test('provider image downloader follows only safe HTTPS redirects', async () => {
  const calls = [];
  const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { Location: '/asset.jpg' } });
    }
    return new Response(image, { status: 200 });
  }, async () => {
    const bytes = await fetchRemoteImageBytes('https://cdn.example/generate/result');
    assert.deepEqual([...bytes], [...image]);
  });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://cdn.example/generate/result',
    'https://cdn.example/asset.jpg'
  ]);
  assert.ok(calls.every((call) => call.init.redirect === 'manual'));
});

test('provider image downloader rejects private redirect destinations without requesting them', async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
  }, async () => {
    assert.equal(await fetchRemoteImageBytes('https://cdn.example/result'), null);
  });
  assert.deepEqual(calls, ['https://cdn.example/result']);
});

test('provider image downloader enforces the byte ceiling from headers and streamed bodies', async () => {
  let bodyRead = false;
  await withFetch(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Length': '8000001' }),
    body: {
      async cancel() {},
      getReader() {
        bodyRead = true;
        throw new Error('oversized body should not be read');
      }
    }
  }), async () => {
    assert.equal(await fetchRemoteImageBytes('https://cdn.example/large.png'), null);
  });
  assert.equal(bodyRead, false, 'oversized content-length is rejected without reading its body');

  await withFetch(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8_000_000));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  }), { status: 200 }), async () => {
    assert.equal(await fetchRemoteImageBytes('https://cdn.example/unbounded.png'), null);
  });
});
