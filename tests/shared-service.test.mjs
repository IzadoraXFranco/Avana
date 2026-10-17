import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createAvanaService as createService } from '../shared/service.ts';
import { createHash } from 'node:crypto';
import { createSupabaseTransport } from '../shared/supabaseTransport.ts';

const memoryStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
};
const uuid = () => crypto.randomUUID();
const createAvanaService = options => createService({ ...options, fingerprint: value => createHash('sha256').update(value).digest('hex') });

test('uncertain committed create reuses the same key after app restart and creates only one task', async () => {
  const storage = memoryStorage();
  const committed = new Map();
  let calls = 0;
  const transport = async request => {
    calls++;
    if (!committed.has(request.requestId)) committed.set(request.requestId, { id: uuid(), title: request.body.title });
    if (calls === 1) throw new ApiError('Resposta perdida', 0);
    return committed.get(request.requestId);
  };
  const first = createAvanaService({ transport, scope: 'project:user', storage, uuid });
  await assert.rejects(first.request('/tasks', 'POST', { title: 'Uma tarefa' }), error => error.status === 0);
  first.dispose();
  const restarted = createAvanaService({ transport, scope: 'project:user', storage, uuid });
  const result = await restarted.request('/tasks', 'POST', { title: 'Uma tarefa' });
  assert.equal(committed.size, 1);
  assert.equal(result.id, [...committed.values()][0].id);
  await restarted.request('/tasks', 'POST', { title: 'Uma tarefa' });
  assert.equal(committed.size, 2, 'a new explicit create after acknowledgement is a new operation');
});

test('commands reuse command and request ID after uncertain completion; concurrent retry is coalesced', async () => {
  const storage = memoryStorage();
  const seen = [];
  const options = {
    scope: 'owner', storage, uuid,
    transport: async request => {
      seen.push(request);
      if (seen.length === 1) throw new ApiError('offline', 0);
      return { task: { id: 'a', version: 2 } };
    },
  };
  await assert.rejects(createAvanaService(options).command({ id: 'a', version: 1 }, { action: 'complete', note: 'Feito' }));
  const service = createAvanaService(options);
  await Promise.all([
    service.command({ id: 'a', version: 1 }, { note: 'Feito', action: 'complete' }),
    service.command({ id: 'a', version: 1 }, { action: 'complete', note: 'Feito' }),
  ]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].requestId, seen[1].requestId);
  assert.equal(seen[0].body.commandId, seen[1].body.commandId);
});

test('accounts never share retry keys and disposed responses cannot update the next session', async () => {
  const storage = memoryStorage();
  let finish;
  let firstKey;
  const first = createAvanaService({ scope: 'first', storage, uuid, transport: request => {
    firstKey = request.requestId;
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = first.request('/tasks', 'POST', { title: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  first.dispose();
  const second = createAvanaService({ scope: 'second', storage, uuid, transport: async request => {
    assert.notEqual(request.requestId, firstKey);
    return 'second';
  } });
  assert.equal(await second.request('/tasks', 'POST', { title: 'A' }), 'second');
  finish('first');
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
});

test('uncertain comment after a refresh replays the original version and cannot post twice', async () => {
  const storage = memoryStorage();
  const committed = new Map();
  const seen = [];
  const transport = async request => {
    seen.push(request);
    const previous = committed.get(request.requestId);
    if (previous) {
      assert.deepEqual(request.body, previous.body, 'retries preserve the complete original command');
      return previous.result;
    }
    const result = { task: { id: 'a', version: 6 }, comments: [{ body: request.body.body }] };
    committed.set(request.requestId, { body: request.body, result });
    throw new ApiError('Resposta perdida depois da confirmação', 0);
  };
  const original = createAvanaService({ scope: 'comment-account', storage, uuid, transport });
  await assert.rejects(original.command({ id: 'a', version: 5 }, { action: 'comment', body: 'Resultado registrado' }));
  original.dispose();
  const reloaded = createAvanaService({ scope: 'comment-account', storage, uuid, transport });
  const recovered = await reloaded.command({ id: 'a', version: 6 }, { action: 'comment', body: 'Resultado registrado' });
  assert.equal(committed.size, 1);
  assert.equal(seen[1].body.version, 5);
  assert.equal(recovered.comments.length, 1);
});

test('expired auth retains uncertain IDs while a version conflict allows a corrected operation', async () => {
  const keys = [];
  let status = 401;
  const service = createAvanaService({ scope: 'account', storage: memoryStorage(), uuid, transport: async request => {
    keys.push(request.requestId);
    throw new ApiError('erro', status, status === 409 ? 'VERSION_CONFLICT' : 'AUTH_REQUIRED');
  } });
  for (let index = 0; index < 2; index++) await assert.rejects(service.request('/tasks', 'POST', { title: 'A' }));
  assert.equal(keys[0], keys[1]);
  status = 409;
  await assert.rejects(service.request('/tasks', 'POST', { title: 'A' }));
  await assert.rejects(service.request('/tasks', 'POST', { title: 'A' }));
  assert.notEqual(keys[2], keys[3]);
});

test('a failed retry journal prevents a network mutation; success is not undone by cleanup failure', async () => {
  let sent = 0;
  const failing = createAvanaService({ scope: 'x', uuid, storage: {
    getItem: () => null, setItem: () => { throw new Error('quota'); },
  }, transport: async () => { sent++; } });
  await assert.rejects(failing.request('/tasks', 'POST', {}), error => error.code === 'RETRY_STORAGE_ERROR');
  assert.equal(sent, 0);
  let writes = 0;
  const acknowledged = createAvanaService({ scope: 'y', uuid, storage: {
    getItem: () => null, setItem: () => { if (++writes > 1) throw new Error('quota'); },
  }, transport: async () => ({ id: 'saved' }) });
  assert.deepEqual(await acknowledged.request('/tasks', 'POST', {}), { id: 'saved' });
});

test('cloud transport maps domain conflicts without exposing server internals', async () => {
  const transport = createSupabaseTransport({ rpc: async (name, args) => {
    assert.equal(name, 'avana_api');
    assert.equal(args.p_path, '/api/tasks/task/command');
    return { status: 400, error: { code: 'P0001', message: JSON.stringify({ error: 'A tarefa mudou.', code: 'VERSION_CONFLICT', status: 409 }) } };
  } }, 'expected-owner');
  await assert.rejects(transport({ method: 'POST', path: '/api/tasks/task/command', body: {}, requestId: 'retry-id' }),
    error => error instanceof ApiError && error.status === 409 && error.code === 'VERSION_CONFLICT');
});

test('two tabs preserve each other\'s uncertain operations across completion and restart', async () => {
  const values = new Map();
  const storage = {
    getItem: async key => { await new Promise(resolve => setImmediate(resolve)); return values.get(key) ?? null; },
    setItem: async (key, value) => { await new Promise(resolve => setImmediate(resolve)); values.set(key, value); },
  };
  let finishA;
  let failB;
  let keyB;
  const tabA = createAvanaService({ scope: 'same-account', uuid, storage, transport: () => new Promise(resolve => { finishA = resolve; }) });
  const tabB = createAvanaService({ scope: 'same-account', uuid, storage, transport: request => {
    keyB = request.requestId;
    return new Promise((_resolve, reject) => { failB = reject; });
  } });
  const operationA = tabA.request('/tasks', 'POST', { title: 'A' });
  const operationB = tabB.request('/tasks', 'POST', { title: 'B' });
  while (!finishA || !failB) await new Promise(resolve => setImmediate(resolve));
  finishA({ id: 'task-a' });
  await operationA;
  failB(new ApiError('Response lost after commit', 0));
  await assert.rejects(operationB);
  const restartedB = createAvanaService({ scope: 'same-account', uuid, storage, transport: async request => {
    assert.equal(request.requestId, keyB);
    return { id: 'task-b' };
  } });
  assert.deepEqual(await restartedB.request('/tasks', 'POST', { title: 'B' }), { id: 'task-b' });
});

test('large import payloads persist only a compact fingerprint and never duplicate domain content in the journal', async () => {
  let serialized;
  const storage = {
    getItem: () => null,
    setItem: (_key, value) => { assert.ok(value.length < 200); serialized = value; },
  };
  const service = createAvanaService({ scope: 'migration', storage, uuid, transport: async () => { throw new ApiError('offline', 0); } });
  await assert.rejects(service.request('/import', 'POST', { data: { text: 'Private evidence '.repeat(100_000) } }));
  assert.equal(serialized.includes('Private evidence'), false);
  assert.match(Object.keys(JSON.parse(serialized))[0], /^[a-f0-9]{64}$/);
});
