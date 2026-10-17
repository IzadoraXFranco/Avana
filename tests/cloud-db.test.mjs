import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createStore } from '../server/store.mjs';

let db;
let currentOwner;
before(async () => {
  db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;`);
  for (const file of readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  }
});
after(async () => { await db?.close(); });

async function user(owner = randomUUID()) {
  await db.exec('reset role');
  await db.query('insert into auth.users(id) values($1) on conflict do nothing',[owner]);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  currentOwner = owner;
  return owner;
}
async function admin(fn) {
  const owner = currentOwner;
  await db.exec('reset role');
  try { return await fn(); }
  finally { if (owner) await user(owner); }
}
async function rpc(method,path,body = {},requestId = randomUUID(),expectedOwner) {
  try { return (await db.query(expectedOwner === undefined
    ? 'select public.avana_api($1,$2,$3::jsonb,$4) result'
    : 'select public.avana_api($1,$2,$3::jsonb,$4,$5::uuid) result',
    [method,path,JSON.stringify(body),requestId,...(expectedOwner === undefined ? [] : [expectedOwner])])).rows[0].result; }
  catch (error) {
    if (error.code === 'P0001') { const parsed = JSON.parse(error.message); throw Object.assign(new Error(parsed.error),parsed); }
    throw error;
  }
}
const command = (detail,action,fields = {}) => rpc('POST',`/api/tasks/${detail.task.id}/command`,{action,version:detail.task.version,commandId:randomUUID(),...fields});
const code = expected => error => error.code === expected;
const localAct = (store,task,action,fields = {}) => store.command(task.task.id,{action,version:task.task.version,commandId:randomUUID(),...fields});
function legacySnapshot() {
  const store = createStore(':memory:',{autoBackup:false,clock:() => '2026-10-16T12:30:45.123Z'});
  try {
    store.updateSettings({name:'Nome original',theme:'dark'});
    let task = store.createTask({title:'Entrega importada'});
    task = localAct(store,task,'edit',{fields:{executionOrder:2,priority:'high',dueDate:'2026-11-20',dueTime:'09:30'}});
    task = localAct(store,task,'subtaskAdd',{title:'Subtarefa preservada'});
    task = localAct(store,task,'comment',{body:'Primeiro comentário'});
    task = localAct(store,task,'complete',{confirmPending:true,note:'Evidência inicial'});
    task = localAct(store,task,'reopen');
    task = localAct(store,task,'move',{section:'hold',reason:'Documento',waitingFor:'Fornecedor',followUpDate:'2026-11-19'});
    const exported = store.exportData();
    exported.data.comments[0].author = 'Autor histórico diferente';
    return {exported,taskId:task.task.id};
  } finally { store.close(); }
}

test('cloud initialization is private, owner scoped and read-only outside RPC',async () => {
  const owner = await user();
  const bootstrap = await rpc('GET','/api/bootstrap');
  assert.equal(bootstrap.projects.length,1); assert.equal(bootstrap.tasks.length,0);
  assert.equal(bootstrap.projects[0].name,'Meu trabalho'); assert.equal(bootstrap.revision,0);
  assert.equal((await rpc('GET','/api/bootstrap')).workspaceId,bootstrap.workspaceId);
  await assert.rejects(db.query('update public.avana_workspaces set revision=99'),error => error.code === '42501');
  await assert.rejects(db.query("select avana_private.bootstrap($1)",[bootstrap.workspaceId]),error => error.code === '42501');
  const other = await user();
  const otherBootstrap = await rpc('GET','/api/bootstrap'); assert.notEqual(otherBootstrap.workspaceId,bootstrap.workspaceId);
  assert.deepEqual((await db.query('select owner_id from public.avana_workspaces')).rows,[{owner_id:other}]);
  assert.equal((await db.query('select count(*)::integer count from public.avana_projects where "workspaceId"=$1',[bootstrap.workspaceId])).rows[0].count,0);
  await assert.rejects(rpc('PATCH',`/api/projects/${bootstrap.projects[0].id}`,{name:'Intrusão'}),code('NOT_FOUND'));
  await db.query("select set_config('request.jwt.claim.sub','',false)");
  await assert.rejects(rpc('GET','/api/bootstrap'),code('UNAUTHENTICATED'));
  await db.exec('set role anon');
  await assert.rejects(rpc('GET','/api/bootstrap'),error => error.code === '42501');
  await user(owner);
});

test('cloud mutations require idempotency and version, retries return current state',async () => {
  await user();
  await assert.rejects(rpc('POST','/api/tasks',{title:'Sem chave'},null),code('IDEMPOTENCY_REQUIRED'));
  const requestId = randomUUID(); const body = {title:'Uma vez'};
  let task = await rpc('POST','/api/tasks',body,requestId);
  assert.deepEqual(await rpc('POST','/api/tasks',body,requestId),task);
  await assert.rejects(rpc('POST','/api/tasks',{title:'Diferente'},requestId),code('IDEMPOTENCY_CONFLICT'));
  const initialRevision = (await rpc('GET','/api/bootstrap')).revision;
  for (const version of [undefined,null,'1',0,1.5]) {
    await assert.rejects(rpc('POST',`/api/tasks/${task.task.id}/command`,{action:'edit',fields:{title:'Não salvar'},version,commandId:randomUUID()}),code('VALIDATION_ERROR'));
  }
  await assert.rejects(rpc('POST',`/api/tasks/${task.task.id}/command`,{action:'edit',fields:{title:'Não salvar'},version:1}),code('VALIDATION_ERROR'));
  assert.equal((await rpc('GET','/api/bootstrap')).revision,initialRevision);
  task = await command(task,'comment',{body:'Depois da criação'});
  assert.equal((await rpc('POST','/api/tasks',body,requestId)).task.version,task.task.version);
  const complete = {action:'complete',version:task.task.version,commandId:randomUUID(),note:'Pronto'};
  task = await rpc('POST',`/api/tasks/${task.task.id}/command`,complete);
  assert.deepEqual(await rpc('POST',`/api/tasks/${task.task.id}/command`,complete),task);
  await assert.rejects(rpc('POST',`/api/tasks/${task.task.id}/command`,{...complete,note:'Outro'}),code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(rpc('POST',`/api/tasks/${task.task.id}/command`,{action:'reopen',version:1,commandId:randomUUID()}),code('VERSION_CONFLICT'));
});

test('expected identity rejects a changed session before bootstrap, import or idempotency replay',async () => {
  const originalOwner = await user();
  const requestId = randomUUID(); const body = {title:'Conta original'};
  const originalTask = await rpc('POST','/api/tasks',body,requestId,originalOwner);
  const differentOwner = await user(); const {exported} = legacySnapshot();
  for (const [method,path,payload,id] of [
    ['GET','/api/bootstrap',{},null],
    ['POST','/api/import',{data:exported,sourceId:randomUUID()},randomUUID()],
    ['POST','/api/tasks',body,requestId],
  ]) await assert.rejects(rpc(method,path,payload,id,originalOwner),error => error.code==='SESSION_CHANGED' && error.status===401);
  await admin(async () => {
    assert.equal((await db.query('select count(*)::integer count from public.avana_workspaces where owner_id=$1',[differentOwner])).rows[0].count,0);
    assert.equal((await db.query('select count(*)::integer count from public.avana_tasks where id=$1',[originalTask.task.id])).rows[0].count,1);
  });
  const bootstrap = await rpc('GET','/api/bootstrap',{},null,differentOwner);
  assert.equal(bootstrap.tasks.length,0);
  await user(originalOwner);
  assert.equal((await rpc('POST','/api/tasks',body,requestId,originalOwner)).task.id,originalTask.task.id);
});

test('planning, Hold, follow-ups and execution order retain independent dates and history',async () => {
  await user(); let task = await rpc('POST','/api/tasks',{title:'Acompanhar'});
  const originalPosition = task.task.position;
  task = await command(task,'edit',{fields:{priority:'high',executionOrder:2,dueDate:'2026-10-01',dueTime:'16:30'}});
  assert.equal(task.task.position,originalPosition); assert.equal(task.task.executionOrder,2);
  for (const invalid of [0,100000,1.2,'3']) await assert.rejects(command(task,'edit',{fields:{executionOrder:invalid}}),code('VALIDATION_ERROR'));
  await assert.rejects(command(task,'edit',{fields:{priority:'urgent'}}),code('VALIDATION_ERROR'));
  task = await command(task,'plan'); assert.equal(task.task.section,'today'); assert.equal(task.task.dueDate,'2026-10-01'); assert.equal(task.task.plannedDate,(await rpc('GET','/api/bootstrap')).today);
  task = await command(task,'move',{section:'hold',reason:'Aprovação',waitingFor:'Fornecedor',nextAction:'Conferir retorno',followUpDate:'2026-11-01'});
  assert.equal(task.task.assignee,'Você'); assert.equal(task.task.waitingFor,'Fornecedor'); assert.equal(task.task.dueTime,'16:30');
  task = await command(task,'hold',{reason:'Documento pendente'}); assert.equal(task.task.waitingFor,'Fornecedor'); assert.equal(task.task.followUpDate,'2026-11-01');
  task = await command(task,'move',{section:'backlog'}); assert.ok(task.holds[0].endedAt); assert.equal(task.task.followUpDate,'2026-11-01');
  task = await command(task,'followupDone',{note:'Verificado',nextDate:'2026-11-03'}); assert.equal(task.followUps[0].status,'done'); assert.equal(task.followUps[0].note,'Verificado');
  task = await command(task,'followup',{date:'2026-11-04'}); assert.equal(task.followUps.at(-2).status,'cancelled');
  task = await command(task,'move',{section:'hold'}); assert.equal(task.holds.length,2); assert.equal(task.task.executionOrder,2);
  task = await command(task,'complete'); assert.equal(task.task.followUpDate,null); assert.ok(task.holds.at(-1).endedAt); assert.equal(task.task.executionOrder,2);
  task = await command(task,'reopen'); assert.equal(task.task.section,'today'); assert.equal(task.task.executionOrder,2);
  await assert.rejects(command(task,'move',{section:'done'}),code('VALIDATION_ERROR'));
  await assert.rejects(command(task,'edit',{fields:{completedAt:'2020-01-01'}}),code('VALIDATION_ERROR'));
});

test('subtasks, manual ordering, evidence and completion cycles use the same cloud rules',async () => {
  await user();
  const project = await rpc('POST','/api/projects',{name:'Evidências',requireEvidence:true});
  let first = await rpc('POST','/api/tasks',{title:'Primeira',projectId:project.id,section:'today'});
  let second = await rpc('POST','/api/tasks',{title:'Segunda',projectId:project.id,section:'today'});
  second = await command(second,'edit',{fields:{executionOrder:1}});
  second = await command(second,'reorder',{beforeId:first.task.id}); assert.equal(second.task.executionOrder,1);
  const ordered = (await rpc('GET','/api/bootstrap')).tasks.filter(task => task.projectId===project.id); assert.equal(ordered[0].id,second.task.id);
  first = await rpc('GET',`/api/tasks/${first.task.id}`);
  first = await command(first,'subtaskAdd',{title:'A'}); first = await command(first,'subtaskAdd',{title:'B'});
  const a = first.subtasks[0].id, b = first.subtasks[1].id;
  first = await command(first,'subtaskReorder',{subtaskId:b,beforeId:a}); assert.equal(first.subtasks[0].id,b);
  first = await command(first,'subtaskEdit',{subtaskId:b,fields:{title:'B revisada',completed:true,assignee:'Você',dueDate:'2026-12-01'}});
  assert.equal(first.task.completedAt,null); assert.equal(first.task.subtaskDone,1);
  await assert.rejects(command(first,'complete'),code('PENDING_SUBTASKS'));
  await assert.rejects(command(first,'complete',{confirmPending:true}),code('EVIDENCE_REQUIRED'));
  first = await command(first,'comment',{body:'Prova anexada como link https://example.com',kind:'evidence'});
  first = await command(first,'complete',{confirmPending:true}); assert.equal(first.task.subtaskDone,1); assert.equal(first.comments[0].completionId,first.task.completionId);
  const firstCompletion = first.task.completedAt;
  first = await command(first,'complete'); assert.equal(first.completions.length,1); assert.equal(first.task.completedAt,firstCompletion);
  first = await command(first,'reopen',{section:'backlog'}); await assert.rejects(command(first,'complete',{confirmPending:true}),code('EVIDENCE_REQUIRED'));
  first = await command(first,'subtaskDelete',{subtaskId:a}); assert.equal(first.task.subtaskCount,1);
  first = await command(first,'complete',{note:'Novo resultado',link:'https://example.com/result'}); assert.equal(first.completions.length,2);
  const exported = await rpc('GET','/api/export'); assert.equal(exported.data.completions.filter(row => row.taskId===first.task.id).length,2);
});

test('projects, settings, archive and trash remain functional in cloud',async () => {
  await user(); const project = await rpc('POST','/api/projects',{name:'Projeto',description:'Descrição',color:'#aabbcc',icon:'star'});
  let task = await rpc('POST','/api/tasks',{title:'Preservada',projectId:project.id});
  const changed = await rpc('PATCH',`/api/projects/${project.id}`,{favorite:true,name:'Renomeado',archived:true}); assert.equal(changed.favorite,true);
  await assert.rejects(command(task,'complete'),code('PROJECT_ARCHIVED'));
  await rpc('PATCH',`/api/projects/${project.id}`,{archived:false});
  task = await command(task,'delete'); assert.ok(task.task.deletedAt); await assert.rejects(command(task,'comment',{body:'Não salvar'}),code('TASK_DELETED'));
  task = await command(task,'restore'); assert.equal(task.task.deletedAt,null);
  await rpc('PATCH',`/api/projects/${project.id}`,{deleted:true}); await assert.rejects(command(task,'edit',{fields:{title:'Outra'}}),code('PROJECT_DELETED'));
  await rpc('PATCH',`/api/projects/${project.id}`,{deleted:false});
  const settings = await rpc('PATCH','/api/settings',{name:'Nome',timezone:'UTC',theme:'dark',backupDirectory:null}); assert.equal(settings.theme,'dark');
  await assert.rejects(rpc('PATCH','/api/settings',{timezone:'Invalid/Zone'}),code('VALIDATION_ERROR'));
  await assert.rejects(rpc('PATCH','/api/settings',{backupDirectory:'C:\\Device'}),code('VALIDATION_ERROR'));
  assert.equal((await rpc('GET','/api/export')).data.settings[0].backupDirectory,null);
});

test('legacy import keeps IDs, authors and cycles; receipts survive edits and support source aliases',async () => {
  await user(); const {exported,taskId} = legacySnapshot(); const sourceId = randomUUID();
  for (const sourceId of ['has spaces','has/slash','has:colon']) await assert.rejects(rpc('POST','/api/import',{data:exported,sourceId}),code('VALIDATION_ERROR'));
  for (const key of ['format','version']) {
    const invalid = structuredClone(exported); delete invalid[key];
    await assert.rejects(rpc('POST','/api/import',{data:invalid,sourceId:randomUUID()}),code('VALIDATION_ERROR'));
    invalid[key] = null;
    await assert.rejects(rpc('POST','/api/import',{data:invalid,sourceId:randomUUID()}),code('VALIDATION_ERROR'));
  }
  const receipt = await rpc('POST','/api/import',{data:exported,sourceId},null);
  assert.equal(receipt.sourceId,sourceId); assert.equal(receipt.counts.tasks,1); assert.equal(receipt.settingsApplied,true);
  assert.equal((await rpc('GET','/api/bootstrap')).projects.length,1,'empty initial project is replaced only on first import');
  let task = await rpc('GET',`/api/tasks/${taskId}`);
  assert.equal(task.task.section,'hold'); assert.equal(task.task.executionOrder,2); assert.equal(task.task.dueTime,'09:30');
  assert.equal(task.comments[0].author,'Autor histórico diferente'); assert.equal(task.completions[0].completedAt,'2026-10-16T12:30:45.123Z');
  assert.deepEqual(task.activity.map(event => event.id),[...exported.data.activity].reverse().map(event => event.id));
  task = await command(task,'edit',{fields:{title:'Alteração após importar'}});
  assert.deepEqual(await rpc('POST','/api/import',{data:exported,sourceId}),receipt);
  assert.equal((await rpc('GET',`/api/tasks/${taskId}`)).task.title,'Alteração após importar');
  assert.deepEqual(await rpc('GET',`/api/imports/${sourceId}`),receipt);
  const aliasId = randomUUID(); const alias = await rpc('POST','/api/import',{data:exported,sourceId:aliasId});
  assert.equal(alias.sourceId,aliasId); assert.equal(alias.hash,receipt.hash); assert.deepEqual(await rpc('GET',`/api/imports/${aliasId}`),alias);
  const different = structuredClone(exported); different.data.tasks[0].title='Diferente';
  await assert.rejects(rpc('POST','/api/import',{data:different,sourceId}),code('IMPORT_SOURCE_CONFLICT'));
  await assert.rejects(rpc('POST','/api/import',{data:different,sourceId:randomUUID()}),code('IMPORT_CONFLICT'));
});

test('migration verification reads preserve even legacy trash until the normal workspace review',async () => {
  await user(); const {exported,taskId} = legacySnapshot();
  exported.data.tasks[0].deletedAt='2000-01-01T00:00:00.000Z';
  const sourceId=randomUUID(); const receipt=await rpc('POST','/api/import',{data:exported,sourceId});
  assert.deepEqual(await rpc('GET',`/api/imports/${sourceId}`),receipt);
  assert.ok((await rpc('GET','/api/export')).data.tasks.some(task => task.id===taskId));
  assert.equal((await rpc('GET',`/api/tasks/${taskId}`)).task.deletedAt,'2000-01-01T00:00:00.000Z');
  assert.equal((await rpc('GET','/api/bootstrap')).tasks.length,0);
  const daily = (await db.query("select data from public.avana_backups where kind='daily'")).rows;
  assert.ok(daily.some(row => row.data.data.tasks.some(task => task.id===taskId)),'snapshot preserves expired records before normal purge');
});

test('restore is atomic and workspace scoped; export round trips back into the local format',async t => {
  const owner = await user(); const {exported,taskId} = legacySnapshot();
  await rpc('POST','/api/import',{data:exported,sourceId:randomUUID()});
  const snapshot = await rpc('GET','/api/export');
  const other = await user(); const otherTask = await rpc('POST','/api/tasks',{title:'Outra conta'});
  await assert.rejects(rpc('GET',`/api/tasks/${taskId}`),code('NOT_FOUND'));
  await assert.rejects(rpc('POST','/api/import',{data:exported,sourceId:randomUUID()}),code('IMPORT_CONFLICT'));
  await user(owner);
  let task = await rpc('GET',`/api/tasks/${taskId}`); task = await command(task,'comment',{body:'Depois do snapshot'});
  const invalid = structuredClone(snapshot); invalid.data.tasks[0].projectId=randomUUID(); invalid.data.tasks[0].version=900;
  await assert.rejects(rpc('POST','/api/restore',{data:invalid}),code('VALIDATION_ERROR'));
  assert.deepEqual(await rpc('GET',`/api/tasks/${taskId}`),task);
  assert.equal((await db.query('select max_version from public.avana_task_versions where "taskId"=$1',[taskId])).rows[0].max_version,task.task.version,'invalid restore rolls the version ledger back too');
  const beforeRestore = Date.now();
  await rpc('POST','/api/restore',{data:snapshot});
  const restored = await rpc('GET',`/api/tasks/${taskId}`);
  assert.equal(restored.comments.length,2);
  assert.ok(restored.task.version>task.task.version);
  assert.ok(Date.parse(restored.task.updatedAt)>=beforeRestore);
  await assert.rejects(command(task,'edit',{fields:{title:'Edição antiga'}}),code('VERSION_CONFLICT'));
  const restorationEvent=restored.activity.find(item => item.type==='restoreSnapshot');
  assert.equal(restorationEvent.before.version,snapshot.data.tasks[0].version);
  assert.equal(restorationEvent.after.version,restored.task.version);
  assert.deepEqual(restored.activity.filter(item => item.type!=='restoreSnapshot').map(item=>item.id).sort(),snapshot.data.activity.map(item=>item.id).sort());
  const backups = (await db.query('select kind from public.avana_backups')).rows; assert.ok(backups.some(row => row.kind==='before-restore'));
  const restoredExport = await rpc('GET','/api/export');
  const domainTask = ({version,updatedAt,...domain}) => domain;
  assert.deepEqual(restoredExport.data.tasks.map(domainTask),snapshot.data.tasks.map(domainTask));
  assert.deepEqual(restoredExport.data.comments,snapshot.data.comments);
  assert.deepEqual(restoredExport.data.completions,snapshot.data.completions);
  const directory = mkdtempSync(join(tmpdir(),'avana-cloud-roundtrip-'));
  const local = createStore(join(directory,'restored.sqlite'),{autoBackup:false,backupDirectory:join(directory,'backups')});
  t.after(() => { local.close(); rmSync(directory,{recursive:true,force:true}); });
  try {
    local.restore(restoredExport);
    assert.equal(restoredExport.data.projects[0].favorite,1);
    assert.equal(typeof restoredExport.data.activity[0].before,'string');
    assert.equal(restoredExport.data.tasks[0].dueTime,'09:30');
    assert.deepEqual(local.getTask(taskId).task,(await rpc('GET',`/api/tasks/${taskId}`)).task);
    assert.deepEqual(local.getTask(taskId).comments,(await rpc('GET',`/api/tasks/${taskId}`)).comments);
  } catch (error) { throw new Error(`Portable cloud export must restore into temporary SQLite: ${error.message}`); }
  await user(other); assert.equal((await rpc('GET',`/api/tasks/${otherTask.task.id}`)).task.title,'Outra conta');
});

test('restoration invalidates stale versions above both the live task and the snapshot without changing conclusions',async () => {
  await user(); let task = await rpc('POST','/api/tasks',{title:'Conclusão preservada'});
  task = await command(task,'complete',{note:'Documento entregue'});
  const snapshot = await rpc('GET','/api/export');
  const originalCompletion = task.task.completedAt;
  task = await command(task,'reopen');
  const higherSnapshot = structuredClone(snapshot); higherSnapshot.data.tasks[0].version=500;
  await rpc('POST','/api/restore',{data:higherSnapshot});
  const restored = await rpc('GET',`/api/tasks/${task.task.id}`);
  assert.equal(restored.task.version,501);
  assert.equal(restored.task.completedAt,originalCompletion);
  assert.equal(restored.task.completionId,snapshot.data.tasks[0].completionId);
  assert.deepEqual(restored.completions,snapshot.data.completions);
  await assert.rejects(command(task,'edit',{fields:{title:'Não pode sobrescrever'}}),code('VERSION_CONFLICT'));
  await assert.rejects(command({task:{...restored.task,version:500}},'reopen'),code('VERSION_CONFLICT'));
  const repeatedRequest=randomUUID();
  await rpc('POST','/api/restore',{data:snapshot},repeatedRequest);
  const repeated = await rpc('GET',`/api/tasks/${task.task.id}`);
  assert.equal(repeated.task.version,502);
  await rpc('POST','/api/restore',{data:snapshot},repeatedRequest);
  assert.deepEqual(await rpc('GET',`/api/tasks/${task.task.id}`),repeated,'replaying restore does not create another version or event');
});

test('version tombstones survive snapshot removal and are isolated from other owners',async () => {
  const owner=await user(); const emptySnapshot=await rpc('GET','/api/export');
  let task=await rpc('POST','/api/tasks',{title:'Voltar depois'});
  const snapshot=await rpc('GET','/api/export');
  task=await command(task,'comment',{body:'Versão posterior ao arquivo'});
  task=await command(task,'edit',{fields:{priority:'high'}});
  const beforeVersion=task.task.version;
  await rpc('POST','/api/restore',{data:emptySnapshot});
  await assert.rejects(rpc('GET',`/api/tasks/${task.task.id}`),code('NOT_FOUND'));
  assert.equal((await db.query('select max_version from public.avana_task_versions where "taskId"=$1',[task.task.id])).rows[0].max_version,beforeVersion);
  await assert.rejects(db.query('update public.avana_task_versions set max_version=1'),error=>error.code==='42501');
  await user();
  assert.equal((await db.query('select count(*)::integer count from public.avana_task_versions where "taskId"=$1',[task.task.id])).rows[0].count,0);
  await user(owner);
  await assert.rejects(rpc('POST','/api/import',{data:snapshot,sourceId:randomUUID()}),code('IMPORT_CONFLICT'));
  await rpc('POST','/api/restore',{data:snapshot});
  const restored=await rpc('GET',`/api/tasks/${task.task.id}`);
  assert.equal(restored.task.version,beforeVersion+1);
  await assert.rejects(command(task,'edit',{fields:{title:'Versão retirada'}}),code('VERSION_CONFLICT'));
});

test('version tombstones survive permanent trash expiry before a task is restored',async () => {
  await user(); let task=await rpc('POST','/api/tasks',{title:'Expurgar e recuperar'});
  const snapshot=await rpc('GET','/api/export');
  task=await command(task,'comment',{body:'Histórico posterior'});
  task=await command(task,'delete');
  await admin(()=>db.query('update public.avana_tasks set "deletedAt"=now()-interval \'31 days\' where id=$1',[task.task.id]));
  assert.equal((await rpc('GET','/api/bootstrap')).tasks.length,0);
  assert.equal((await db.query('select max_version from public.avana_task_versions where "taskId"=$1',[task.task.id])).rows[0].max_version,task.task.version);
  await rpc('POST','/api/restore',{data:snapshot});
  const restored=await rpc('GET',`/api/tasks/${task.task.id}`);
  assert.equal(restored.task.version,task.task.version+1);
  assert.equal(restored.task.deletedAt,null);
  await assert.rejects(command(task,'edit',{fields:{title:'Edição obsoleta'}}),code('VERSION_CONFLICT'));
});

test('cloud maintenance recovers daily snapshots and purges only expired trash',async () => {
  await user(); const boot = await rpc('GET','/api/bootstrap');
  let expired = await rpc('POST','/api/tasks',{title:'Expirada'}); expired = await command(expired,'complete'); expired = await command(expired,'delete');
  const kept = await rpc('POST','/api/tasks',{title:'Manter'});
  await rpc('POST','/api/backup');
  await admin(async () => {
    await db.query('update public.avana_tasks set "deletedAt"=now()-interval \'31 days\' where id=$1',[expired.task.id]);
    await db.query('update public.avana_backups set "createdAt"=now()-interval \'40 days\' where "workspaceId"=$1',[boot.workspaceId]);
  });
  const after = await rpc('GET','/api/bootstrap'); assert.deepEqual(after.tasks.map(task => task.id),[kept.task.id]);
  const backups = (await db.query('select kind from public.avana_backups')).rows;
  assert.equal(backups.filter(row => row.kind==='daily').length,1); assert.equal(backups.filter(row => row.kind==='manual').length,1);
  await assert.rejects(rpc('GET',`/api/tasks/${expired.task.id}`),code('NOT_FOUND'));
});
