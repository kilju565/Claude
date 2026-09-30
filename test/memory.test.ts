import { describe, expect, it } from 'vitest';
import { AttemptMemory } from '../src/memory.js';

describe('AttemptMemory', () => {
  it('finds earlier attempts by edit or by resulting state, citing the first one', () => {
    const memory = new AttemptMemory();
    memory.record({ attempt: 1, outcome: 'tests-failed', summary: 'a', diffFingerprint: 'd1', stateFingerprint: 's1' });
    memory.record({ attempt: 2, outcome: 'apply-failed', summary: 'b', diffFingerprint: 'd2' });
    memory.record({ attempt: 3, outcome: 'tests-failed', summary: 'c', diffFingerprint: 'd1', stateFingerprint: 's1' });

    expect(memory.findDuplicate({ diffFingerprint: 'd1' })?.attempt).toBe(1);
    expect(memory.findDuplicate({ diffFingerprint: 'd2' })?.attempt).toBe(2);
    expect(memory.findDuplicate({ diffFingerprint: 'new', stateFingerprint: 's1' })?.attempt).toBe(1);
    expect(memory.findDuplicate({ diffFingerprint: 'new', stateFingerprint: 'new' })).toBeUndefined();
    expect(memory.findDuplicate({})).toBeUndefined();
    expect(memory.records).toHaveLength(3);
  });

  it('counts rejected duplicates', () => {
    const memory = new AttemptMemory();
    memory.noteDuplicateRejected();
    memory.noteDuplicateRejected();
    expect(memory.duplicatesRejected).toBe(2);
  });
});
