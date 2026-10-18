import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = join(root, '.build', 'source-evidence');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, 'run-'));
const report = { startedAt: new Date().toISOString(), status: 'blocked', commands: [] };

// The CLI contract's statuses, declared by the caller as the other journeys
// take them, and refused by name when missing.
function declared(name) {
  const value = process.env[name];
  if (!value?.trim() || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} is required: the exit status the CLI contract names for it, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

async function command(binary, args) {
  const entry = { binary, args, cwd: root, stdout: '', stderr: '' };
  report.commands.push(entry);
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { entry.stdout += chunk; });
    child.stderr.on('data', chunk => { entry.stderr += chunk; });
    child.on('error', error => { entry.error = error.message; reject(error); });
    child.on('close', (code, signal) => { entry.exitCode = code; entry.signal = signal; resolve(entry); });
  });
}

let success;
let failure;
async function git(args) {
  const result = await command('git', args);
  if (result.exitCode !== success) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// The committed revision, the uncommitted patch and every untracked file of
// the qualified paths, so a run whose source changed while it ran is refused.
async function sourceState() {
  const paths = ['src', 'tests/context', 'package.json'];
  const revision = (await git(['rev-parse', 'HEAD'])).trim();
  const patch = await git(['diff', '--binary', 'HEAD', '--', ...paths]);
  const added = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths])).split('\0').filter(Boolean);
  const additions = [];
  for (const path of added) additions.push({ path, content: await readFile(join(root, path), 'utf8') });
  return { revision, patch, additions };
}

try {
  success = declared('COMPETITORS_TEST_SUCCESS_EXIT');
  failure = declared('COMPETITORS_TEST_FAILURE_EXIT');
  report.source = await sourceState();
  report.status = 'running';
  const result = await command(process.execPath, ['--test', '--test-reporter=tap', 'tests/context/source.test.mjs', 'tests/context/gathering.test.mjs']);
  await writeFile(join(directory, 'tests.tap'), result.stdout);
  await writeFile(join(directory, 'tests.stderr'), result.stderr);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  report.sourceAfter = await sourceState();
  report.sourceUnchanged = JSON.stringify(report.source) === JSON.stringify(report.sourceAfter);
  report.status = result.exitCode === success && report.sourceUnchanged ? 'passed' : 'failed';
  if (!report.sourceUnchanged) report.error = 'Source changed during the run; qualification refused';
} catch (error) {
  report.error = error.message;
  report.status = report.status === 'running' ? 'failed' : 'blocked';
  process.stderr.write(`${error.message}\n`);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, '\t')}\n`);
  process.stdout.write(`Source evidence report: ${directory}\n`);
}
// A run that did not pass ends with the declared failure status; one whose
// statuses were never declared ends on the refusal above, uncaught.
if (report.status !== 'passed') {
  if (failure === undefined) throw new Error(report.error);
  process.exitCode = failure;
}
