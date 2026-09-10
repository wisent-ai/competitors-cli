import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

test('discover merges duplicate evidence, excludes the caller and refuses missing records', () => {
  const work = join(homedir(), '.stado', 'work');
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(join(work, 'competitors-discovery-'));
  const recordsPath = join(directory, 'records.json');
  const records = JSON.stringify([
    { name: 'Alternative', domain: 'alternative.example', url: 'https://alternative.example/product', observedAt: '2026-01-01T00:00:00Z' },
    { name: 'Alternative', domain: 'www.alternative.example', url: 'https://alternative.example/pricing', observedAt: '2026-01-01T00:00:00Z' },
    { name: 'Our Product', domain: 'own.example', observedAt: '2026-01-01T00:00:00Z' },
  ]);
  writeFileSync(recordsPath, records);
  try {
    const result = spawnSync(process.execPath, [cli, 'discover', '--records', recordsPath, '--own-domain', 'own.example'], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.candidates.map((candidate) => ({
      name: candidate.name,
      domains: candidate.domains,
      evidence: candidate.evidence.map((entry) => entry.url),
    })), [{
      name: 'Alternative',
      domains: ['alternative.example'],
      evidence: ['https://alternative.example/product', 'https://alternative.example/pricing'],
    }]);
    assert.equal(readFileSync(recordsPath, 'utf8'), records);

    const missing = spawnSync(process.execPath, [cli, 'discover'], { cwd: directory, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), '--records <records.json> is required');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
