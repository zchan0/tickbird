import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runRoot = await mkdtemp(join(tmpdir(), 'sidecar-product-host-'));
const fixture = join(runRoot, 'workspace');
const userData = join(runRoot, 'user-data');
const extensions = join(runRoot, 'extensions');
const codex = join(runRoot, 'codex');
const claude = join(runRoot, 'claude');
const claudeProject = join(claude, fixture.replace(/[^a-zA-Z0-9_-]/g, '-'));
await Promise.all([mkdir(fixture), mkdir(join(userData, 'User'), { recursive: true }), mkdir(extensions), mkdir(codex), mkdir(claudeProject, { recursive: true })]);
await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
  'window.restoreWindows': 'none', 'workbench.startupEditor': 'none',
  'workbench.editor.closeEmptyGroups': true, 'security.workspace.trust.enabled': false,
  'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off'
}));
await writeFile(join(fixture, 'AGENT_PLACEHOLDER.txt'), 'Test-owned editor, not a real Agent. No messages or commands are executed.\n');
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
await writeFile(join(codex, 'fixture.jsonl'), jsonl([
  { type: 'session_meta', payload: { id: 'cx-fixture', cwd: fixture, source: 'cli' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Fixture: inspect test failure' } },
  { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'call-1', arguments: '{"cmd":"fixture test - never executed"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 1\nAssertionError: fixture expected 2, actual 1' } },
  { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'call-2', arguments: '{"cmd":"fixture recheck - never executed"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-2', output: 'Warning: truncated output\nProcess exited with code 0\n6 tests passed' } },
  { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'patch-1', success: true, changes: { 'fixture.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new' } } } }
]));
await writeFile(join(claudeProject, 'fixture.jsonl'), jsonl([
  { type: 'user', uuid: 'cl-user', sessionId: 'cl-fixture', cwd: fixture, message: { role: 'user', content: 'Fixture: inspect result' } },
  { type: 'assistant', uuid: 'cl-call', sessionId: 'cl-fixture', cwd: fixture, message: { id: 'cl-msg', role: 'assistant', content: [{ type: 'tool_use', id: 'cl-tool', name: 'Bash', input: { command: 'fixture only, never executed' } }] } },
  { type: 'user', uuid: 'cl-output', sessionId: 'cl-fixture', cwd: fixture, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cl-tool', is_error: false, content: 'Fixture completed. One known result.' }] } }
]));
const code = process.env.SIDECAR_CODE_CLI || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
// Each run opens its own window: the project fixture, then a window with no folder.
async function launch(name, tests, folder) {
  const resultFile = join(runRoot, `result-${name}.json`);
  const args = ['--new-window', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${join(root, tests)}`, ...(folder ? [folder] : [])];
  const child = spawn(code, args, { stdio: 'inherit', env: { ...process.env, SIDECAR_TEST_RESULT: resultFile,
    SIDECAR_TEST_CODEX_ROOT: codex, SIDECAR_TEST_CLAUDE_ROOT: claude } });
  console.log(JSON.stringify({ run: name, runRoot, resultFile, launcherPid: child.pid }));
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  let result;
  const deadline = Date.now() + 60000;
  while (!result && exitCode === 0 && Date.now() < deadline) {
    try { result = JSON.parse(await readFile(resultFile, 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!result) console.error(`No authoritative host result for ${name}. Retained run directory: ${runRoot}`);
  return result;
}
const project = await launch('project', 'dist/tests/host/run.js', fixture);
const empty = project?.passed ? await launch('empty-window', 'dist/tests/host/empty.js') : undefined;
if (project) {
  await mkdir(join(root, '.test-artifacts'), { recursive: true });
  await writeFile(join(root, '.test-artifacts', 'host-latest.json'), JSON.stringify({ ...project, emptyWindow: empty, runRoot }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: project.passed && Boolean(empty?.passed),
    checks: [...project.checks, ...(empty?.checks ?? [])].map(check => ({ name: check.name, passed: check.passed })),
    artifact: '.test-artifacts/host-latest.json' }, null, 2));
}
process.exitCode = project?.passed && empty?.passed ? 0 : 1;
