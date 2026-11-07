// page-lab/block@1 and page-lab/profile@1 — the fixtures, both ways.
//
// A validator that can only say yes is decoration, so every *-bad-* fixture must FAIL and say
// which rule it broke, and every *-good-* fixture must PASS. An empty fixture dir fails too: a
// moved or renamed folder must not go green over zero files.
//
//   node --test plugins/page-lab/tests/

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildBlock,
  loadBlockSchema,
  loadProfileSchema,
  validate,
} from '../scripts/lib/envelope.mjs';

const FIX = fileURLToPath(new URL('../scripts/fixtures/', import.meta.url));

function fixtures(kind) {
  const dir = join(FIX, kind);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert.ok(files.length >= 4, `${dir}: expected fixtures, found ${files.length}`);
  return files.map((f) => ({ f, obj: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

for (const [kind, load] of [
  ['block', loadBlockSchema],
  ['profile', loadProfileSchema],
]) {
  test(`${kind} fixtures: good pass, bad fail`, () => {
    let good = 0;
    let bad = 0;
    for (const { f, obj } of fixtures(kind)) {
      const r = validate(obj, load());
      if (f.startsWith(`${kind}-good-`)) {
        good++;
        assert.deepEqual(r.errors, [], `${f} must pass`);
      } else if (f.startsWith(`${kind}-bad-`)) {
        bad++;
        assert.equal(r.valid, false, `${f} must FAIL — the rule it exercises is gone`);
      } else {
        assert.fail(`${f}: unclassified — name it ${kind}-good-* or ${kind}-bad-*`);
      }
    }
    assert.ok(good >= 2 && bad >= 4, `${kind}: ${good} good / ${bad} bad`);
  });
}

test('buildBlock fills identity and origin, invents nothing', () => {
  const b = buildBlock({
    url: 'https://example.com/x?y=1',
    reason: 'http-429',
    evidence: { detector: 'status', rule: 'status.429', status: 429 },
    profile: 'lab',
    runId: 'r1',
    queuePos: 3,
  });
  assert.equal(b.schema, 'page-lab/block@1');
  assert.equal(b.origin, 'https://example.com');
  assert.match(b.measuredAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(b.notes, []);
  assert.deepEqual(validate(b, loadBlockSchema()).errors, []);

  const thin = buildBlock({ url: 'https://example.com/' });
  assert.equal('reason' in thin, false, 'no default reason');
  assert.equal('evidence' in thin, false, 'no default evidence');
  assert.equal('queuePos' in thin, false, 'no guessed queue position');
  assert.equal(validate(thin, loadBlockSchema()).valid, false);
});
