import test from 'node:test';
import assert from 'node:assert/strict';
import { serverClockOffset } from '../shared/clock.ts';
import { today, sectionOf } from '../shared/dates.ts';

test('two device clocks group the same completion on the server day near midnight', () => {
  const instant = '2026-10-17T02:59:55.000Z';
  const server = Date.parse(instant);
  const task = { completedAt: instant, section: null };
  for (const skew of [-300_000, 600_000]) {
    const device = server + skew;
    const offset = serverClockOffset(instant, device - 20, device + 20);
    assert.equal(offset, -skew);
    const day = today('America/Sao_Paulo', new Date(device + offset));
    assert.equal(sectionOf(task, day), 'doneToday');
    const nextDay = today('America/Sao_Paulo', new Date(device + offset + 10_000));
    assert.equal(sectionOf(task, nextDay), 'done');
    assert.equal(task.completedAt, instant);
  }
});

test('an invalid server time cannot corrupt the last known offset', () => {
  assert.equal(serverClockOffset('invalid', 1, 2), null);
  assert.equal(serverClockOffset('2026-10-17T00:00:00Z', 2, 1), null);
});
