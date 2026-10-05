import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = join(root, '.build', 'source-evidence');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, 'run-'));
const report = { startedAt: new Date().toISOString(), status: 'blocked', commands: [] };
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
async function git(args, permitted = [0]) {
  const result = await command('git', args);
  if (!permitted.includes(result.exitCode)) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
async function sourceState() {
  const paths = ['src', 'tests/context', 'package.json'];
  const revision = (await git(['rev-parse', 'HEAD'])).trim();
  const patch = await git(['diff', '--binary', 'HEAD', '--', ...paths]);
  const added = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths])).split('\0').filter(Boolean);
  const additions = [];
  for (const path of added) additions.push(await git(['diff', '--no-index', '--binary', '--', '/dev/null', path], [0, 1]));
  return { revision, patch, additions };
}
try {
  report.source = await sourceState();
  report.status = 'running';
  const result = await command(process.execPath, ['--test', '--test-reporter=tap', 'tests/context/source.test.mjs']);
  await writeFile(join(directory, 'tests.tap'), result.stdout);
  await writeFile(join(directory, 'tests.stderr'), result.stderr);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  report.sourceAfter = await sourceState();
  report.sourceUnchanged = JSON.stringify(report.source) === JSON.stringify(report.sourceAfter);
  report.status = result.exitCode === 0 && report.sourceUnchanged ? 'passed' : 'failed';
  if (!report.sourceUnchanged) report.error = 'Source changed during the run; qualification refused';
  process.exitCode = report.status === 'passed' ? 0 : 1;
} catch (error) {
  report.error = error.message;
  report.status = report.status === 'running' ? 'failed' : 'blocked';
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Source evidence report: ${directory}\n`);
}
