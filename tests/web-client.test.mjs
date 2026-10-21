import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebClient } from '../src/web-client.mjs';
import * as clients from '../src/web-client.mjs';

const launchUrl = 'http://127.0.0.1:3080/?token=test-launch-token';
const cookie = 'dsh_test=signed-test-cookie';

function carrier(handler, { authHeaders } = {}) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/connect')) {
      assert.equal(url.searchParams.get('token'), 'test-launch-token');
      assert.equal(url.searchParams.get('interactions'), 'none');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: authHeaders ?? {
        'set-cookie': cookie + '; Path=/; HttpOnly; SameSite=Strict',
        location: './api/remote.mux',
      } });
    }
    assert.equal(url.search, '', 'launch token must never become an API query');
    assert.equal(new Headers(options.headers).get('cookie'), cookie);
    const message = JSON.parse(options.body);
    assert.equal(message.type, 'client-request');
    assert.equal(url.pathname, '/api/' + message.method);
    const value = await handler(message, options);
    return Response.json({ type: 'server-response', rpcId: message.rpcId,
      result: { ok: true, value } });
  };
}

test('tokenized startup URL authenticates once and addresses the clean RPC path', async () => {
  const client = await createWebClient(launchUrl, { fetch: carrier(message => {
    assert.equal(message.method, 'workspace/create');
    assert.deepEqual(message.payload, { args: { request: { path: 'C:/empty' } } });
    return { workspace: { workspaceId: 'workspace-1' }, created: true };
  }) });
  const result = await client.rpc('workspace.create', { path: 'C:/empty' });
  assert.equal(client.protocol, 'remote');
  assert.equal(result.workspace.workspaceId, 'workspace-1');
  await client.close();
});

test('legacy client preserves dotted endpoints and original request payloads without token exchange', async () => {
  assert.equal(typeof clients.createLegacyWebClient, 'function');
  const requests = [];
  const client = await clients.createLegacyWebClient('http://127.0.0.1:3080', { fetch: async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, request });
    assert.equal(new Headers(options.headers).get('cookie'), null);
    return Response.json({ result: { ok: true, value: { events: [] } } });
  } });
  assert.equal(client.protocol, 'legacy');
  await client.rpc('session.history', { sessionId: 'old-session', maxMessages: 50, afterSeq: 5 });
  assert.equal(requests[0].url, 'http://127.0.0.1:3080/api/session.history');
  assert.equal(requests[0].request.method, 'session.history');
  assert.deepEqual(requests[0].request.payload, { sessionId: 'old-session', maxMessages: 50 });
  await client.close();
  await assert.rejects(client.rpc('session.list', {}), /closed/i);
});

test('dotted and slash methods use the generated named-argument contract', async () => {
  const observed = [];
  const client = await createWebClient(launchUrl, { fetch: carrier(message => {
    observed.push([message.method, message.payload]);
    return message.method === 'session/list' ? { items: [] } : { accepted: true };
  }) });
  await client.rpc('session.list', {});
  await client.rpc('session/create', { cwd: 'C:/empty' });
  await client.rpc('session.prompt', { requestId: 'request-1', sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'test' }] });
  await client.rpc('session/modelCatalog');
  await client.rpc('session/cancel', { args: { request: { sessionId: 'session-1' } } });
  assert.deepEqual(observed, [
    ['session/list', { args: { _request: {} } }],
    ['session/create', { args: { request: { cwd: 'C:/empty' } } }],
    ['session/prompt', { args: { request: { requestId: 'request-1', sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'test' }] } } }],
    ['session/modelCatalog', { args: {} }],
    ['session/cancel', { args: { request: { sessionId: 'session-1' } } }],
  ]);
  await client.close();
});

function event(seq) {
  return { type: 'event', event: { type: 'test/event', seq, time: seq, data: {} } };
}

test('history uses an exact projection cursor and pages until the requested run boundary', async () => {
  const pages = [];
  const client = await createWebClient(launchUrl, { fetch: carrier(message => {
    if (message.method === 'session/projections') {
      assert.deepEqual(message.payload, { args: { request: { sessionId: 'session-1' } } });
      return { kind: 'sequenced', asOfSeq: 12, values: {} };
    }
    const request = message.payload.args.request;
    assert.equal(message.method, 'session/page');
    assert.deepEqual(request.address, { kind: 'session', sessionId: 'session-1' });
    assert.equal(request.throughSeq, 12);
    assert.equal(request.maxMessages, 2);
    pages.push(request.beforeSeq);
    return request.beforeSeq === undefined
      ? { records: [event(9), event(10), event(11), event(12)], hasMore: true }
      : { records: [event(5), event(6), event(7), event(8)], hasMore: true };
  }) });
  const history = await client.rpc('session.history', { sessionId: 'session-1', maxMessages: 2, afterSeq: 6 });
  assert.deepEqual(history.events.map(item => item.event.seq), [7, 8, 9, 10, 11, 12]);
  assert.equal(history.asOfSeq, 12);
  assert.deepEqual(pages, [undefined, 9]);
  await client.close();
});

test('history refuses a migration hint instead of presenting incomplete events', async () => {
  const client = await createWebClient(launchUrl, { fetch: carrier(() => ({ kind: 'migration-required', values: {} })) });
  await assert.rejects(client.rpc('session.history', { sessionId: 'session-1' }), /sequenced|migration/i);
  await client.close();
});

test('close aborts active HTTP requests and refuses future calls', async () => {
  let entered;
  const started = new Promise(resolve => entered = resolve);
  const client = await createWebClient(launchUrl, { fetch: carrier((_message, options) => new Promise((_resolve, reject) => {
    entered();
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  })) });
  const pending = client.rpc('session.list', {});
  await started;
  await client.close();
  await assert.rejects(pending, /closed/i);
  await client.close();
  await assert.rejects(client.rpc('session.list', {}), /closed/i);
});

test('optional API lifecycle socket authenticates with the same cookie and closes once', async () => {
  const opened = [];
  class Socket extends EventEmitter {
    constructor(url, options) {
      super();
      this.readyState = 0;
      this.closeCount = 0;
      opened.push({ url, options, socket: this });
      queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
    }
    close() { this.closeCount++; this.readyState = 3; this.emit('close'); }
  }
  const client = await createWebClient(launchUrl, { fetch: carrier(() => ({})), WebSocket: Socket });
  assert.equal(opened[0].url, 'ws://127.0.0.1:3080/api/remote.mux');
  assert.equal(opened[0].options.headers.Cookie, cookie);
  await client.close();
  await client.close();
  assert.equal(opened[0].socket.closeCount, 1);
});

test('authentication and correlation failures do not expose the launch token', async () => {
  await assert.rejects(createWebClient(launchUrl, { fetch: carrier(() => ({}), { authHeaders: { location: 'https://elsewhere.invalid/api/remote.mux' } }) }), error => {
    assert.ok(!error.message.includes('test-launch-token'));
    return /cookie|origin/i.test(error.message);
  });
  const fetch = carrier(() => ({}));
  const client = await createWebClient(launchUrl, { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (new URL(url).pathname === '/connect') return response;
    const value = await response.json();
    value.rpcId = 'unrelated-request';
    return Response.json(value);
  } });
  await assert.rejects(client.rpc('session.list', {}), /correlation|rpcId/i);
  await client.close();
});
