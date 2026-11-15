/** Published calibration JSON must be parsed on documentation-only changes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

test('docs gate accepts valid published evidence and refuses malformed evidence', () => {
  const document = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const step = document.toJS().jobs.test.steps.find((step: { name: string }) => step.name === 'Documentation, tracker and public identity gates');
  const command = step.run.split('\n').find((line: string) => line.includes('docs/calibration-drift-evidence.json'));
  assert.ok(command);
  const root = mkdtempSync(join(tmpdir(), 'jev-docs-gate-'));
  try {
    mkdirSync(join(root, 'docs'));
    for (const [body, status] of [['{}', 0], ['{broken', 1]] as const) {
      writeFileSync(join(root, 'docs/calibration-drift-evidence.json'), body);
      const result = spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, status, result.stderr);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
