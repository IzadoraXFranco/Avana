import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createStore } from '../server/store.mjs';
import { createCloudCoordinator } from '../server/cloud.mjs';
import { createAvanaService } from '../shared/service.ts';
import { createSupabaseTransport } from '../shared/supabaseTransport.ts';

test('real SQLite snapshot → cloud RPC → authenticated verification → two clients share one task', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'avana-cloud-e2e-'));
  const db = new PGlite();
  let coordinator;
  const local = createStore(join(directory, 'avana.sqlite'), { maintenanceDisabled: () => coordinator?.isLocked() || false });
  t.after(async () => { local.close(); await db.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = randomUUID();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth, public to authenticated, anon;`);
  await db.query('insert into auth.users(id) values ($1)', [owner]);
  for (const filename of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(new URL(`../supabase/migrations/${filename}`, import.meta.url), 'utf8')); }
    catch (error) { throw new Error(`Migration SQL: ${error.message}`); }
  }
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  const rpc = async (method, path, body = {}, requestId = randomUUID(), expectedUserId = owner) => {
    try { return (await db.query('select public.avana_api($1,$2,$3::jsonb,$4,$5::uuid) as result', [method,path,JSON.stringify(body),requestId,expectedUserId])).rows[0].result; }
    catch (error) { throw new Error(error.message); }
  };
  const mutate = (detail, action, fields = {}) => local.command(detail.task.id, { action, version: detail.task.version, commandId: randomUUID(), ...fields });
  let waiting = local.createTask({ title: 'Verificar entrega' });
  waiting = mutate(waiting, 'edit', { fields: { priority: 'high', executionOrder: 2, dueDate: '2026-10-20', dueTime: '09:30' } });
  waiting = mutate(waiting, 'subtaskAdd', { title: 'Conferir documento' });
  waiting = mutate(waiting, 'comment', { body: 'Comentário preservado' });
  waiting = mutate(waiting, 'complete', { note: 'Resultado inicial', confirmPending: true });
  waiting = mutate(waiting, 'reopen', { section: 'today' });
  waiting = mutate(waiting, 'move', { section: 'hold', reason: 'Falta confirmação', waitingFor: 'Fornecedor fictício', nextAction: 'Consultar andamento', followUpDate: '2026-10-19' });
  let completed = local.createTask({ title: 'Entrega concluída' });
  completed = mutate(completed, 'complete', { note: 'Concluída com evidência' });
  const fetchRemote = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-session-token');
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: owner });
    const input = JSON.parse(options.body);
    return Response.json(await rpc(input.p_method,input.p_path,input.p_body,input.p_request_id,input.p_expected_user_id));
  };
  coordinator = createCloudCoordinator(directory, { fetch: fetchRemote });
  coordinator.configure({ url: 'https://avana-test.supabase.co', publishableKey: 'sb_publishable_testpublickey123456789' });
  const snapshot = coordinator.freeze({ userId: owner }, local);
  const receipt = await rpc('POST','/api/import',{ data: snapshot.data, sourceId: snapshot.sourceId });
  const state = await coordinator.activate({ accessToken: 'test-session-token', receipt });
  assert.equal(state.state, 'cloud');
  assert.throws(() => coordinator.assertWritable(), error => error.code === 'LOCAL_FROZEN');
  assert.equal(createCloudCoordinator(directory).status().state, 'cloud', 'source remains frozen after restart');
  const detail = await rpc('GET',`/api/tasks/${waiting.task.id}`);
  assert.equal(detail.task.section, 'hold');
  assert.equal(detail.task.executionOrder, 2);
  assert.equal(detail.task.dueTime, '09:30');
  assert.equal(detail.subtasks.length, 1);
  assert.equal(detail.completions.length, 1);
  assert.equal(detail.activity.length, waiting.activity.length);
  assert.deepEqual(detail.comments, waiting.comments);
  assert.deepEqual((await rpc('GET',`/api/tasks/${completed.task.id}`)).completions, completed.completions);

  const cloudClient = { rpc: async (_name, input) => {
    try { return { data: await rpc(input.p_method,input.p_path,input.p_body,input.p_request_id,input.p_expected_user_id), error: null, status: 200 }; }
    catch (error) { return { data: null, error: { code: 'P0001', message: error.message }, status: 400 }; }
  } };
  const fingerprint = value => createHash('sha256').update(value).digest('hex');
  const web = createAvanaService({ transport: createSupabaseTransport(cloudClient, owner), scope: 'web', uuid: randomUUID, fingerprint });
  const android = createAvanaService({ transport: createSupabaseTransport(cloudClient, owner), scope: 'android', uuid: randomUUID, fingerprint });
  const fromWeb = await web.getDetail(waiting.task.id);
  const fromAndroid = await android.getDetail(waiting.task.id);
  await web.command(fromWeb.task, { action: 'edit', fields: { title: 'Alterada pela Web' } });
  await assert.rejects(android.command(fromAndroid.task, { action: 'edit', fields: { description: 'Rascunho do Android' } }), error => error.code === 'VERSION_CONFLICT');
  const updated = await android.getDetail(waiting.task.id);
  assert.equal(updated.task.title, 'Alterada pela Web');
  await android.command(updated.task, { action: 'comment', body: 'Comentário do Android' });
  assert.equal((await web.getDetail(waiting.task.id)).comments.at(-1).body, 'Comentário do Android');
  assert.equal((await web.request('/bootstrap')).tasks.length, 2);
  const repeated = await rpc('POST','/api/import',{ data: snapshot.data, sourceId: snapshot.sourceId });
  assert.deepEqual(repeated, receipt, 'import retry remains stable after cloud edits');
  assert.equal((await coordinator.activate({ accessToken: 'test-session-token', receipt })).state, 'cloud');
});
