import test from 'node:test';
import assert from 'node:assert/strict';
import { actionPresentation, describeAction, type ActionType } from '../packages/core/src/actions';
import type { TimelineItem } from '../packages/core/src/model';

const call = (title: string, input?: unknown, status: TimelineItem['status'] = 'unknown'): TimelineItem => ({
  id: 'item', sessionId: 'session', turnId: 'turn', kind: 'tool', title, summary: 'Recorded tool call', status, sources: [{ file: 'fixture.jsonl', line: 1 }],
  availability: input === undefined ? 'none' : 'available', ...(input === undefined ? {} : { detail: { title, blocks: [{ kind: 'code', label: '记录中的调用参数', text: typeof input === 'string' ? input : JSON.stringify(input) }] } }),
});
test('unwraps a literal skill read without claiming activation or success', () => {
  const item = call('functions/exec', 'text(await tools.exec_command({cmd:"sed -n \'1,240p\' /Users/example/.agents/skills/openai-docs/SKILL.md"}));', 'failed');
  const description = describeAction(item);
  assert.equal(description.label, 'Skill · openai-docs');
  assert.deepEqual(description.targets, ['/Users/example/.agents/skills/openai-docs/SKILL.md']);
  assert.equal(description.entries[0].count, 1);
  assert.equal(item.status, 'failed');
  assert.ok(!('status' in description.entries[0]));
  assert.equal(describeAction(call('exec_command', {cmd: "sed -n '1,240p' /Users/example/.codex/skills/.system/openai-docs/SKILL.md"})).label, 'Skill · openai-docs');
});
test('multiple static calls preserve first-seen order, repeated counts and distinct targets', () => {
  const description = describeAction(call('functions.exec', `
    const result = await tools.exec_command({cmd: 'cat src/a.ts'});
    text(result);
    await Promise.all([tools.exec_command({cmd: 'cat src/b.ts'}), tools.exec_command({cmd: 'cat src/a.ts'})]);
    text(await tools.web__run({search_query: [{q: 'VS Code API'}], open: [{ref_id: 'https://code.visualstudio.com/api'}]}));
  `));
  assert.deepEqual(description.entries.map(entry => [entry.label, entry.count]), [
    ['读取 · a.ts', 2], ['读取 · b.ts', 1], ['Web · 搜索资料 · VS Code API', 1], ['Web · 打开来源 · code.visualstudio.com', 1],
  ]);
  assert.notEqual(description.entries[0].key, description.entries[1].key);
});
test('JS strings, comments, regexes and dormant function bodies cannot spoof actual direct calls', () => {
  const description = describeAction(call('exec', `
    // await tools.exec_command({cmd: 'cat /skills/fake/SKILL.md'});
    const quoted = "await tools.web__run({search_query: [{q: 'fake'}]})";
    const pattern = /tools.web__run/;
    function dormant() { return tools.web__run({search_query: [{q: 'not called'}]}); }
    text(await tools.exec_command({cmd: 'npm test'}));
  `));
  assert.deepEqual(description.entries.map(entry => entry.label), ['编排调用（未解析）', '验证 · npm test']);
  assert.ok(description.unresolved);
  assert.ok(!description.label.includes('fake'));
  assert.ok(!description.label.includes('not called'));
});
test('conditional, looping, dynamic calls and malformed wrappers stay explicitly unparsed', () => {
  for (const source of [
    'if (ready) await tools.web__run({search_query: [{q: "maybe"}]});',
    'for (const query of queries) await tools.web__run({search_query: [{q: query}]});',
    'await tools[toolName]({});',
    'await tools.exec_command({cmd: command});',
    'await tools.exec_command({cmd: `cat ${path}`});',
    'await tools.exec_command({cmd: "cat nope"}',
  ]) {
    const label = describeAction(call('functions/exec', source)).label;
    assert.match(label, /(?:编排调用|命令)（未解析）/);
    assert.ok(!label.includes('maybe'));
  }
});
test('shadowing or replacing tools cannot spoof trusted tool actions', () => {
  for (const source of [
    'const tools = fake; await tools.web__run({search_query:[{q:"spoofed"}]});',
    'tools.exec_command = fake; await tools.exec_command({cmd:"cat /skills/fake/SKILL.md"});',
    'const { tools } = fake; await tools.web__run({});',
  ]) assert.equal(describeAction(call('functions/exec', source)).label, '编排调用（未解析）');
});
test('tool output and updated parameter versions are not interpreted as new commands', () => {
  const item = call('functions/exec', 'text(await tools.exec_command({cmd:"npm run build"}));');
  item.detail!.blocks.push({kind: 'code', label: '当时返回的内容', text: 'await tools.exec_command({cmd:"cat /skills/fake/SKILL.md"});'});
  item.detail!.blocks.push({kind: 'json', label: '同一调用 ID 的另一组记录参数', text: '{"cmd":"npm test"}'});
  assert.equal(describeAction(item).label, '构建 · npm run build');
});
test('quoted shell text does not become a file read, nested shell or interpolation is not interpreted', () => {
  for (const command of ['echo "cat /skills/fake/SKILL.md"', "printf '%s' 'tools.web__run({})'", 'sh -c "cat /skills/fake/SKILL.md"', 'cat "$(echo /skills/fake/SKILL.md)"']) {
    assert.ok(describeAction(call('exec_command', {cmd: command})).label.startsWith('命令'));
    assert.ok(!describeAction(call('exec_command', {cmd: command})).label.startsWith('Skill'));
  }
  for (const command of ["sed 'w /tmp/output' /skills/fake/SKILL.md", 'echo ready; if ready; then cat /skills/fake/SKILL.md; fi']) {
    assert.ok(describeAction(call('exec_command', {cmd: command})).label.startsWith('命令'));
  }
});
test('shell reads, searches, tests, builds and git have compact semantic labels', () => {
  assert.equal(describeAction(call('exec_command', {cmd: "rg -n 'turnId' packages/core/src"})).label, '搜索代码 · turnId · src');
  assert.equal(describeAction(call('exec_command', {cmd: "head -n 20 src/model.ts && tail -n 10 src/actions.ts"})).label, '读取 · model.ts；读取 · actions.ts');
  assert.equal(describeAction(call('exec_command', {cmd: 'npm run check'})).label, '验证 · npm run check');
  assert.equal(describeAction(call('exec_command', {cmd: 'git diff --stat'})).label, '查看改动');
  assert.equal(describeAction(call('exec_command', {cmd: 'rg --files -g *.ts src'})).label, '查找文件 · *.ts · src');
});
test('Claude known tool input and direct tools share semantic vocabulary', () => {
  const item = call('Read', {file_path: '/repo/.agents/skills/grilling/SKILL.md'});
  item.detail!.blocks[0].label = '当时调用参数'; item.detail!.blocks[0].kind = 'json';
  assert.equal(describeAction(item).label, 'Skill · grilling');
  assert.equal(describeAction(call('Skill', {skill: 'grilling'})).label, 'Skill · grilling');
  assert.notEqual(describeAction(item).entries[0].key, describeAction(call('Skill', {skill: 'grilling'})).entries[0].key);
  assert.equal(describeAction(call('Edit', {file_path: '/repo/src/model.ts', old_string: 'a', new_string: 'b'})).label, '修改文件 · model.ts');
  assert.equal(describeAction(call('Agent', {description: 'Audit coverage'})).label, '分派子任务 · Audit coverage');
  assert.equal(describeAction(call('AskUserQuestion', {questions: [{question:'Choose layout?'}]})).label, '等待确认 · Choose layout?');
});
test('patch targets are read only from recorded patch headers, no file content interpreted', () => {
  const input = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n+await tools.web__run({});\n*** Add File: src/b.ts\n+ok\n*** End Patch';
  assert.equal(describeAction(call('apply_patch', input)).label, '修改文件 · a.ts、b.ts');
});
test('command event input is classified; unpaired output stays an honest fallback', () => {
  const item = call('命令执行记录');
  item.detail = {title: 'command', blocks: [{kind:'code', label:'当时命令', text:'node --test dist/tests/actions.test.js'}, {kind:'text',label:'当时返回',text:'cat /skills/fake/SKILL.md'}]};
  assert.equal(describeAction(item).label, '测试 · node --test dist/tests/actions.test.js');
  assert.equal(describeAction(call('未配对工具结果')).label, '未配对工具结果');
});
test('same basename in different paths does not group as a repeated action', () => {
  const a = describeAction(call('Read', {file_path: '/repo/a/model.ts'}));
  const b = describeAction(call('Read', {file_path: '/repo/b/model.ts'}));
  assert.equal(a.label, b.label);
  assert.notEqual(a.key, b.key);
});
test('compact summary is bounded without dropping detailed semantic entries', () => {
  const input = Array.from({length:20}, (_, i) => `await tools.exec_command({cmd:'cat path/file-${i}.ts'});`).join('\n');
  const action = describeAction(call('functions/exec', input));
  assert.equal(action.entries.length, 20);
  assert.ok(action.label.length <= 240);
});
test('opaque web references stay out of labels but retain exact link identity', () => {
  const open = describeAction(call('web__run', {open: [{ref_id:'turn2search1'}]}));
  const click1 = describeAction(call('web__run', {click: [{ref_id:'turn3view0',id:1}]}));
  const click2 = describeAction(call('web__run', {click: [{ref_id:'turn3view0',id:2}]}));
  assert.equal(open.label, 'Web · 打开来源');
  assert.deepEqual(open.targets, ['turn2search1']);
  assert.equal(click1.label, 'Web · 打开来源');
  assert.notEqual(click1.key, click2.key);
  assert.equal(describeAction(call('Web 来源')).label, 'Web · 来源结果');
});
test('search display omits home paths and bounds patterns without weakening identity', () => {
  const pattern = 'tickbird|sidecar|codex|claude|longer|pattern|more';
  const first = describeAction(call('exec_command', {cmd:`rg -n '${pattern}' /Users/example/.codex/memories/MEMORY.md`}));
  assert.ok(!first.label.includes('/Users/'));
  assert.ok(first.label.includes('MEMORY.md'));
  assert.ok(first.label.length < 64);
  assert.ok(first.targets!.includes(pattern));
  const a = describeAction(call('exec_command', {cmd:'rg --files -g *.ts src'}));
  const b = describeAction(call('exec_command', {cmd:'rg --files -g *.js src'}));
  assert.notEqual(a.key, b.key);
  const web = describeAction(call('web__run', {search_query:[{q:'site:developers.openai.com Codex VS Code extension IDE'}]}));
  assert.equal(web.label, 'Web · 搜索资料 · Codex VS Code extension IDE');
  assert.ok(web.targets![0].startsWith('site:developers.openai.com'));
});
test('complex commands identify purpose or executable without dumping shell input', () => {
  const command = 'rg -n "tickbird|sidecar|codex|claude" /Users/example/.codex/memories/MEMORY.md | head -80';
  const action = describeAction(call('exec_command', {cmd: command}));
  assert.equal(action.label, '搜索代码（含管道）');
  assert.deepEqual(action.targets, [command]);
  assert.equal(describeAction(call('exec_command', {cmd: "printf '%s' 'tools.web__run({})'"})).label, '命令 · printf');
  assert.equal(describeAction(call('exec_command', {cmd: 'pwd && rg --files | head -80'})).label, '命令 · pwd（含管道）');
});
test('child completion and acquired return are distinguishable without merging child identities', () => {
  const completed: TimelineItem = { ...call('/root/audit'), kind: 'subagent', status: 'completed' };
  assert.equal(describeAction(completed).label, '子任务完成 · /root/audit');
  const returned: TimelineItem = { ...completed, status: 'info', detail: { title: '返回', blocks: [{ kind: 'text', label: '子 Agent 返回', text: '已核对来源。' }] } };
  assert.equal(describeAction(returned).label, '子任务返回 · /root/audit');
  assert.equal(returned.status, 'info');
});
test('opaque Bash input may use its recorded purpose, never description-shaped output or inferred success', () => {
  const input = { command: 'for item in *; do echo "$item"; done | head -5', description: 'Identify the active editor workspace' };
  const value = call('Bash', input, 'unknown');
  assert.equal(describeAction(value).label, '命令 · Identify the active editor workspace');
  assert.equal(value.status, 'unknown');
  assert.equal(describeAction(call('Bash', { command: 'cat /skills/openai-docs/SKILL.md', description: 'Custom purpose' })).label, 'Skill · openai-docs');
  const output = call('Bash');
  output.detail = { title: 'output', blocks: [{ kind: 'json', label: '当时返回', text: JSON.stringify(input) }] };
  assert.ok(!describeAction(output).label.includes(input.description));
});
test('presentation exposes strong action tokens and removes only redundant known prefixes', () => {
  const cases: [string, unknown, ActionType, string][] = [
    ['Bash', {command:'node -e "console.log(1)"', description:'Check a recorded runtime property'}, 'BASH', 'Check a recorded runtime property'],
    ['Read', {file_path:'/repo/src/model.ts'}, 'READ', 'model.ts'],
    ['exec_command', {cmd:'cat /repo/.agents/skills/openai-docs/SKILL.md'}, 'SKILL', 'openai-docs'],
    ['Skill', {skill:'grilling'}, 'SKILL', 'grilling'],
    ['web__run', {open:[{ref_id:'turn2search1'}]}, 'WEB', '打开来源'],
    ['exec_command', {cmd:'npm test'}, 'TEST', 'npm test'],
    ['exec_command', {cmd:'npm run build'}, 'BUILD', 'npm run build'],
    ['Edit', {file_path:'/repo/a.ts'}, 'EDIT', 'a.ts'],
    ['Write', {file_path:'/repo/a.ts'}, 'WRITE', 'a.ts'],
    ['Grep', {pattern:'turnId',path:'/repo/src'}, 'SEARCH', '搜索代码 · turnId · src'],
    ['view_image', {path:'/repo/result.png'}, 'IMAGE', 'result.png'],
  ];
  for (const [tool, input, type, label] of cases) {
    const description = describeAction(call(tool, input));
    assert.deepEqual(actionPresentation(description.entries[0]), {type,label});
  }
});
test('presentation keeps opaque shell and unresolved orchestration visibly distinct', () => {
  const shell = describeAction(call('exec_command', {cmd:'rg pattern /repo/src | head -80'})).entries[0];
  assert.deepEqual(actionPresentation(shell), {type:'BASH',label:'搜索代码（含管道）'});
  const unknown = describeAction(call('functions/exec', 'await tools[name]({});')).entries[0];
  assert.deepEqual(actionPresentation(unknown), {type:'UNKNOWN',label:'编排调用（未解析）'});
  const dynamicCommand = describeAction(call('exec_command', {cmd:'cat "$path"'})).entries[0];
  assert.deepEqual(actionPresentation(dynamicCommand), {type:'BASH',label:'cat（动态参数）'});
});
test('presentation is pure and preserves original identities, targets and counts', () => {
  const entry = describeAction(call('functions/exec', 'await tools.exec_command({cmd:"cat /repo/a.ts"}); await tools.exec_command({cmd:"cat /repo/a.ts"});')).entries[0];
  const before = JSON.stringify(entry);
  Object.freeze(entry.targets); Object.freeze(entry);
  assert.deepEqual(actionPresentation(entry), {type:'READ',label:'a.ts'});
  assert.equal(JSON.stringify(entry), before);
  assert.equal(entry.count, 2);
  assert.deepEqual(entry.targets, ['/repo/a.ts']);
});
test('presentation does not derive categories from user-controlled labels or malformed keys', () => {
  for (const key of ['not-json', '{}', '[]', '[42]', '["future:action",[]]', '["tool:custom",[]]']) {
    assert.deepEqual(actionPresentation({key,label:'Skill · test passed',count:1}), {type:'TOOL',label:'Skill · test passed'});
  }
  const mappings: [string, ActionType][] = [
    ['file-change','FILE'], ['subagent:spawn_agent','AGENT'], ['subagent','AGENT'], ['question','ASK'],
    ['git:diff','GIT'], ['dependencies','INSTALL'], ['tool:wait','WAIT'], ['search:tools','SEARCH'],
  ];
  for (const [kind,type] of mappings) assert.equal(actionPresentation({key:JSON.stringify([kind,[]]),label:'Recorded action',count:1}).type,type);
});
