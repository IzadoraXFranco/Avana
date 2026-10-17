import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLegacyEntries, parseTaskDraftRecord, parseExecutionOrderDraft, recoveryCopyCandidates, isPortableExport } from '../shared/legacy.ts';
import { createStore } from '../server/store.mjs';

function draftRecord() {
  const base = {
    main: { title: 'Tarefa', description: '', assignee: 'Você', priority: '', executionOrder: '', plannedDate: '', dueDate: '', dueTime: '', projectId: 'project' },
    hold: { reason: '', waitingFor: '', nextAction: '', followUpDate: '' },
    subtasks: { subtask: { title: 'Subtarefa', assignee: '', dueDate: '' } },
    comment: '', commentKind: 'comment', completionNote: '', completionLink: '', followupNote: '', nextFollowup: '', newSubtask: '',
  };
  const draft = structuredClone(base);
  draft.comment = 'Não publicado';
  return { version: 3, base, draft };
}
function completeExport() {
  const store = createStore(':memory:', { autoBackup: false });
  try { return store.exportData(); } finally { store.close(); }
}

test('browser recovery separates unpublished drafts from complete portable exports and unknown legacy tasks', () => {
  const entries = {
    'avana.project': '"project"',
    'avana:task-draft:task': JSON.stringify(draftRecord()),
    'avana.backup': JSON.stringify(completeExport()),
    'avana.tasks': '[{"id":"old","title":"Não descartar","done":true}]',
    'avana.invalid': 'texto antigo',
  };
  const before = JSON.stringify(entries);
  const report = inspectLegacyEntries(entries);
  assert.equal(report.preferenceCount, 1);
  assert.equal(report.draftCount, 1);
  assert.equal(report.exports.length, 1);
  assert.deepEqual(report.unknown.map(item => item.key), ['avana.tasks', 'avana.invalid']);
  assert.equal(JSON.stringify(entries), before);
});

test('task draft validation keeps typed text and known legacy upgrades without modifying the source', () => {
  const record = draftRecord();
  record.base.main.priority = 'urgent';
  record.draft.main.priority = 'urgent';
  delete record.base.main.executionOrder;
  delete record.draft.main.executionOrder;
  record.draft.completionLink = 'link ainda em edição';
  const raw = JSON.stringify(record);
  const recovered = parseTaskDraftRecord(raw);
  assert.equal(recovered.version, 3);
  assert.equal(recovered.draft.comment, 'Não publicado');
  assert.equal(recovered.draft.main.priority, 'high');
  assert.equal(recovered.base.main.executionOrder, '');
  assert.equal(recovered.draft.main.executionOrder, '');
  assert.equal(recovered.draft.completionLink, 'link ainda em edição');
  assert.equal(JSON.stringify(record), raw);
  assert.equal(record.draft.main.priority, 'urgent');
});

test('malformed draft values cannot reach text trimming, subtask iteration or recovery counts', () => {
  const invalid = [null, [], {}, { comment: 'Texto antigo solto' }, { ...draftRecord(), version: 0 }, { ...draftRecord(), version: '3' }];
  for (const field of Object.keys(draftRecord().draft.main)) {
    const record = draftRecord(); record.draft.main[field] = { unsafe: true }; invalid.push(record);
  }
  for (const field of Object.keys(draftRecord().draft.hold)) {
    const record = draftRecord(); record.draft.hold[field] = 12; invalid.push(record);
  }
  for (const field of ['comment', 'completionNote', 'completionLink', 'followupNote', 'nextFollowup', 'newSubtask']) {
    const record = draftRecord(); record.draft[field] = null; invalid.push(record);
  }
  for (const change of [record => { record.base.main.title = 7; }, record => { record.draft.subtasks = []; },
    record => { record.draft.subtasks.subtask.title = false; }, record => { delete record.base.hold; },
    record => { record.draft.commentKind = 'automatic'; }, record => { record.draft.unknownFutureField = 'preserve separately'; }]) {
    const record = draftRecord(); change(record); invalid.push(record);
  }
  const entries = Object.fromEntries(invalid.map((record, index) => [`avana:task-draft:task-${index}`, JSON.stringify(record)]));
  entries['avana:task-draft:broken-json'] = '{';
  for (const raw of Object.values(entries)) assert.equal(parseTaskDraftRecord(raw), null);
  const report = inspectLegacyEntries(entries);
  assert.equal(report.draftCount, 0);
  assert.equal(report.unknown.length, Object.keys(entries).length);
  assert.deepEqual(recoveryCopyCandidates(entries).entries, []);
});

test('execution-order recovery requires a textual draft, valid saved base and nonempty revision', () => {
  for (const text of ['2', '', ' 3 ', 'valor ainda inválido']) {
    const draft = { text, base: null, revision: 'revision-1' };
    assert.deepEqual(parseExecutionOrderDraft(JSON.stringify(draft)), draft);
  }
  for (const base of [0, 100000, 1.5, '2', {}, undefined])
    assert.equal(parseExecutionOrderDraft(JSON.stringify({ text: '3', base, revision: 'r' })), null);
  for (const draft of [{ text: 2, base: null, revision: 'r' }, { text: '2', base: null, revision: '' },
    { text: '2', base: null, revision: 9 }, { text: '2', base: null }, { text: '2', base: 1, revision: 'r', unknown: true }])
    assert.equal(parseExecutionOrderDraft(JSON.stringify(draft)), null);
  assert.equal(parseExecutionOrderDraft('{'), null);
});

test('copy candidates exclude unknown and foreign-task records while preserving the original package', () => {
  const entries = {
    'avana:task-draft:task': JSON.stringify(draftRecord()),
    'avana:task-draft:missing': JSON.stringify(draftRecord()),
    'avana:task-draft:invalid': '{"draft":{"main":{"title":3}}}',
    'avana:execution-order-draft:task': JSON.stringify({ text: '4', base: null, revision: 'revision' }),
    'avana:execution-order-draft:invalid': '{"text":3,"base":null,"revision":"r"}',
    'avana.columns': '{"due":true,"priority":false}',
    'avana.sidebar': '"not-a-boolean"',
    'avana.backup': JSON.stringify(completeExport()),
    'avana:pending-requests:local': '{"private":"operational"}',
    'avana:scope:another-account:avana:task-draft:task': JSON.stringify(draftRecord()),
  };
  const before = JSON.stringify(entries);
  const candidates = recoveryCopyCandidates(entries, new Set(['task']));
  assert.deepEqual(candidates.entries.map(item => item.key), ['avana:task-draft:task', 'avana:execution-order-draft:task', 'avana.columns']);
  assert.equal(candidates.skipped, 4);
  assert.equal(inspectLegacyEntries(entries).draftCount, 3);
  assert.equal(inspectLegacyEntries(entries).unknown.length, 3);
  assert.equal(JSON.stringify(entries), before, 'unrecognized entries and other account records remain in original recovery data');
});

test('only complete v1 envelopes are offered for explicit additive import, never copied as drafts', () => {
  const exported = completeExport();
  assert.equal(isPortableExport(exported), true);
  const invalid = [
    { format: 'avana', version: 1, data: { projects: [], tasks: [] } },
    { ...exported, version: 2 }, { ...exported, exportedAt: '2026-99-99' },
    { ...exported, data: { ...exported.data, comments: undefined } },
    { ...exported, data: { ...exported.data, tasks: [null] } },
    { ...exported, data: { ...exported.data, memberships: [] } },
  ];
  for (const item of invalid) assert.equal(isPortableExport(item), false);
  const entries = { 'avana.export': JSON.stringify(exported), 'avana.partial': JSON.stringify(invalid[0]) };
  const report = inspectLegacyEntries(entries);
  assert.equal(report.exports.length, 1);
  assert.deepEqual(report.exports[0].data, exported);
  assert.deepEqual(report.unknown.map(item => item.key), ['avana.partial']);
  assert.equal(recoveryCopyCandidates(entries).entries.length, 0);
});
