import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, validateDraft } from '../src/server.js';

test('local draft boundary validates input and marks output as non-executing', () => {
  assert.ok(validateDraft({}));
  const input = { outcome: 'Improve activation', owner: 'pm@example.com', evidenceIds: ['evidence-1'] };
  assert.equal(validateDraft(input), null);
  const draft = createDraft(input);
  assert.equal(draft.status, 'proposed');
  assert.ok(draft.id);
  assert.ok(draft.createdAt);
});
