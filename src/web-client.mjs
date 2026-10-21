import { randomUUID } from 'node:crypto';

const NO_ARGUMENT_METHODS = new Set([
  'session/modelCatalog', 'session/canOpenWorkspacePath',
  'session/initializeDefaultModel', 'workspace/initializeDefault',
]);

/** Connect to one owned local DSH Web service without putting its token in RPC URLs. */
export async function createWebClient(webUrl, options = {}) {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const startup = new URL(webUrl);
  if (!['http:', 'https:'].includes(startup.protocol) || startup.username || startup.password) {
    throw new Error('DSH Web startup URL must be an HTTP(S) root');
  }
  const tokens = startup.searchParams.getAll('token');
  if (tokens.length !== 1 || !tokens[0]) throw new Error('DSH Web startup URL has no unique launch token');
  const base = new URL(startup);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const lifetime = new AbortController();
  let closed = false;
  let cookie = '';
  let socket;
  let socketEnded = false;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]);

  const connectUrl = new URL('connect', base);
  connectUrl.searchParams.set('token', tokens[0]);
  connectUrl.searchParams.set('interactions', 'none');
  let handshake;
  try {
    handshake = await fetchRequest(connectUrl.href, { method: 'GET', redirect: 'manual', signal: signal() });
  } catch (cause) {
    throw new Error('DSH Web authentication transport failed', { cause });
  }
  if (handshake.status !== 302) throw new Error(`DSH Web authentication failed over HTTP ${String(handshake.status)}`);
  const cookies = typeof handshake.headers.getSetCookie === 'function'
    ? handshake.headers.getSetCookie()
    : [handshake.headers.get('set-cookie')].filter(Boolean);
  cookie = cookies.map(value => value.split(';', 1)[0].trim()).filter(Boolean).join('; ');
  if (!cookie) throw new Error('DSH Web authentication returned no session cookie');
  const destination = new URL(handshake.headers.get('location') ?? 'api/remote.mux', connectUrl);
  if (destination.origin !== base.origin) throw new Error('DSH Web authentication changed origin');
  destination.search = '';
  destination.hash = '';

  if (options.WebSocket) {
    destination.protocol = destination.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new options.WebSocket(destination.href, { headers: { Cookie: cookie } });
    const onError = () => {};
    listen(socket, 'error', onError);
    listen(socket, 'close', () => { socketEnded = true; });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('DSH Web API socket timed out')), timeoutMs);
        const removeOpen = listen(socket, 'open', () => finish());
        const removeError = listen(socket, 'error', () => finish(new Error('DSH Web API socket failed')));
        const removeClose = listen(socket, 'close', () => finish(new Error('DSH Web API socket closed before readiness')));
        function finish(error) {
          clearTimeout(timer);
          removeOpen(); removeError(); removeClose();
          if (error) reject(error); else resolve();
        }
        if (socket.readyState === 1) finish();
      });
    } catch (error) {
      cookie = '';
      lifetime.abort(error);
      socket.close();
      throw error;
    }
  }

  async function invoke(endpoint, payload) {
    if (closed || socketEnded) throw new Error('DSH Web client is closed');
    if (!/^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/.test(endpoint)) throw new Error('Invalid DSH Remote endpoint');
    let args;
    if (payload && Object.hasOwn(payload, 'args')) {
      args = payload.args;
    } else if (endpoint === 'session/list') {
      args = { _request: payload ?? {} };
    } else {
      args = payload === undefined || NO_ARGUMENT_METHODS.has(endpoint) ? {} : { request: payload };
    }
    const rpcId = `mcp-${randomUUID()}`;
    let response;
    try {
      response = await fetchRequest(new URL(`api/${endpoint}`, base).href, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: signal(),
      });
    } catch (cause) {
      if (closed) throw new Error('DSH Web client is closed', { cause });
      throw new Error(`${endpoint} transport failed`, { cause });
    }
    if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${String(response.status)}`);
    const message = await response.json();
    if (message?.type !== 'server-response' || message.rpcId !== rpcId) throw new Error(`${endpoint} response rpcId correlation failed`);
    if (message.result?.ok !== true) {
      const failure = message.result?.error;
      const error = new Error(`${endpoint} failed: ${failure?.code ?? 'invalid-response'}: ${failure?.message ?? 'invalid result'}`);
      if (typeof failure?.code === 'string') error.code = failure.code;
      throw error;
    }
    return message.result.value;
  }

  async function history(payload) {
    const { sessionId, maxMessages = 50, afterSeq = -1 } = payload ?? {};
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('session.history requires a sessionId');
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new Error('session.history afterSeq must be an integer >= -1');
    const projection = await invoke('session/projections', { sessionId });
    if (projection?.kind !== 'sequenced' || !Number.isSafeInteger(projection.asOfSeq) || projection.asOfSeq < -1) {
      throw new Error('session.history requires sequenced projections; session is missing or requires migration');
    }
    const throughSeq = projection.asOfSeq;
    const records = new Map();
    let beforeSeq;
    while (throughSeq > afterSeq) {
      const page = await invoke('session/page', {
        address: { kind: 'session', sessionId }, throughSeq, maxMessages,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') throw new Error('Invalid DSH session page');
      let oldest = Infinity;
      for (const record of page.records) {
        const seq = record?.event?.seq;
        if (record?.type !== 'event' || !Number.isSafeInteger(seq) || seq < 0 || seq > throughSeq) throw new Error('Invalid DSH session event record');
        oldest = Math.min(oldest, seq);
        if (seq > afterSeq) records.set(seq, record);
      }
      if (!page.hasMore || oldest <= afterSeq) break;
      if (!Number.isFinite(oldest) || oldest >= (beforeSeq ?? throughSeq + 1)) throw new Error('DSH session pagination made no progress');
      beforeSeq = oldest;
    }
    return { events: [...records.values()].sort((a, b) => a.event.seq - b.event.seq), asOfSeq: throughSeq };
  }

  return {
    protocol: 'remote',
    async rpc(method, payload) {
      if (closed || socketEnded) throw new Error('DSH Web client is closed');
      if (method === 'session.history' || method === 'session/history') return history(payload);
      return invoke(method.includes('/') ? method : method.replace('.', '/'), payload);
    },
    async close() {
      if (closed) return;
      closed = true;
      cookie = '';
      lifetime.abort(new Error('DSH Web client is closed'));
      if (socket && socket.readyState !== 3) {
        await new Promise(resolve => {
          const timer = setTimeout(() => { socket.terminate?.(); resolve(); }, 1_000);
          const removeClose = listen(socket, 'close', () => { clearTimeout(timer); removeClose(); resolve(); });
          socket.close();
        });
      }
    },
  };
}

/** Retain the published rc.6 HTTP contract when its service advertises no launch token. */
export async function createLegacyWebClient(webUrl, options = {}) {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const base = new URL(webUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.searchParams.has('token')) {
    throw new Error('Legacy DSH Web URL must be an HTTP(S) root without a launch token');
  }
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const lifetime = new AbortController();
  let closed = false;
  return {
    protocol: 'legacy',
    async rpc(method, payload) {
      if (closed) throw new Error('DSH Web client is closed');
      const endpoint = method.replace('/', '.');
      if (!/^[A-Za-z0-9_$.-]+\.[A-Za-z0-9_$.-]+$/.test(endpoint)) throw new Error('Invalid legacy DSH RPC endpoint');
      if (endpoint === 'session.history' && payload && Object.hasOwn(payload, 'afterSeq')) {
        const { afterSeq: _afterSeq, ...legacyPayload } = payload;
        payload = legacyPayload;
      }
      const response = await fetchRequest(new URL(`api/${endpoint}`, base).href, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `mcp-${randomUUID()}`, method: endpoint, payload }),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]),
      });
      if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${String(response.status)}`);
      const body = await response.json();
      if (body.result?.ok !== true) {
        const failure = body.result?.error;
        throw new Error(`${endpoint} failed: ${failure?.code ?? 'invalid-response'}: ${failure?.message ?? 'invalid result'}`);
      }
      return body.result.value;
    },
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort(new Error('DSH Web client is closed'));
    },
  };
}

function listen(socket, event, callback) {
  if (typeof socket.on === 'function') {
    socket.on(event, callback);
    return () => socket.off(event, callback);
  }
  socket.addEventListener(event, callback);
  return () => socket.removeEventListener(event, callback);
}
