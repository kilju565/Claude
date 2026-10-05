import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDirectory } from '../src/directory.ts';

test('lists full names alphabetically', () => {
  const directory = buildDirectory([
    { id: 1, username: 'zoe', profile: { firstName: 'Zoe', lastName: 'Adams' } },
    { id: 2, username: 'al', profile: { firstName: 'Al', lastName: 'Baker' } },
  ]);
  assert.deepEqual(directory, ['Al Baker', 'Zoe Adams']);
});

test('falls back to the username when a user has no profile', () => {
  const directory = buildDirectory([
    { id: 1, username: 'zoe', profile: { firstName: 'Zoe', lastName: 'Adams' } },
    { id: 3, username: 'svc-backup' },
  ]);
  assert.deepEqual(directory, ['svc-backup', 'Zoe Adams']);
});
