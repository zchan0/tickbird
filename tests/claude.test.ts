import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../packages/core/src/claude';

const parse = (records: unknown[]) => parseClaude({ file: '/fixture/cl.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });
const row = (type: string, content: unknown, extra = {}) => ({ type, sessionId: 'cl', cwd: '/fixture', message: { role: type, content }, ...extra });
const tool = (id: string, name = 'Bash') => row('assistant', [{ type: 'tool_use', id, name, input: { command: 'fixture not executed' } }]);
const result = (id: string, isError: boolean, extra = {}) => row('user', [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'Fixture output' }], extra);

test('explicit same-session Claude ai-title overrides request fallback without becoming a timeline item', () => {
  const records = [row('user', 'file:///fixture/prototype.html Please review'),
    {type:'ai-title',aiTitle:'Prototype.html 设计评审',sessionId:'cl'}, row('user', 'Follow-up request')];
  const original = JSON.stringify(records);
  const data = parse(records);
  assert.equal(data.title, 'Prototype.html 设计评审');
  assert.equal(data.titleSource, 'claude-ai-title');
  assert.equal(data.id, 'cl');
  assert.equal(data.items.length, 2);
  assert.equal(data.coverage.filter(entry => entry.source.line === 2).length, 1);
  assert.equal(data.coverage.find(entry => entry.source.line === 2)?.disposition, 'excluded');
  assert.ok(!JSON.stringify(data.items).includes('Prototype.html 设计评审'));
  assert.equal(JSON.stringify(records), original);
});
test('Claude title uses last valid matching metadata and rejects foreign, malformed or oversized names', () => {
  const data = parse([row('user', 'Fallback'),
    {type:'ai-title',sessionId:'cl',aiTitle:'First name'},
    {type:'ai-title',sessionId:'other',aiTitle:'Foreign name'},
    {type:'ai-title',sessionId:'cl',aiTitle:'  Latest name  '},
    {type:'ai-title',sessionId:'cl',aiTitle:' '},
    {type:'ai-title',sessionId:'cl',aiTitle:42},
    {type:'ai-title',sessionId:'cl',aiTitle:'x'.repeat(513)},
    {type:'ai-title',sessionId:'cl',aiTitle:'Unexpected\nmultiline'},
    {type:'ai-title',aiTitle:'Unbound name'},
    {type:'ai-title',sessionId:'',aiTitle:'Empty identity'},
    row('assistant', 'Public process', {aiTitle:'Not title metadata'})]);
  assert.equal(data.title, 'Latest name');
  assert.equal(data.titleSource, 'claude-ai-title');
  assert.equal(data.coverage.filter(entry => entry.kind === 'ai-title').length, 9);
  assert.equal(data.items.length, 2);
  assert.equal(parse([row('user','Fallback'), {type:'ai-title',sessionId:'other',aiTitle:'Foreign'}]).titleSource, 'request');
});
test('a title before the first request remains authoritative even if its text equals the default title', () => {
  const data = parse([{type:'ai-title',sessionId:'cl',aiTitle:'Claude Code session'}, row('user','Actual first request')]);
  assert.equal(data.title, 'Claude Code session');
  assert.equal(data.titleSource, 'claude-ai-title');
  assert.equal(data.items[0].summary, 'Actual first request');
});
test('ai-title metadata cannot establish or replace Claude session identity', () => {
  const data = parse([{type:'ai-title',sessionId:'foreign',aiTitle:'Foreign prefix'}, row('user','Actual request'), {type:'ai-title',sessionId:'cl',aiTitle:'Actual title'}]);
  assert.equal(data.id,'cl');
  assert.equal(data.title,'Actual title');
  assert.ok(data.items.every(item => item.sessionId === 'cl'));
  const onlyTitle = parse([{type:'ai-title',sessionId:'cl',aiTitle:'Unbound title'}]);
  assert.equal(onlyTitle.id,'claude:/fixture/cl.jsonl');
  assert.equal(onlyTitle.title,'Claude Code session');
  assert.equal(onlyTitle.titleSource,undefined);
});

test('one Claude session contains distinct request turns while tool results and request revisions keep their association', () => {
  const request = (uuid: string, messageId: string, text: string) => row('user', text, { uuid, message: { id: messageId, role: 'user', content: [{ type: 'text', text }] } });
  const data = parse([
    request('first-request', 'first-message', 'First request'), tool('a'), result('a', false),
    request('second-request', 'second-message', 'Second request'),
    request('first-request', 'first-message', 'A later version of the first request'),
    tool('b'), result('b', false)
  ]);
  assert.equal(data.id, 'cl');
  assert.ok(data.items.every(item => item.sessionId === 'cl'));
  assert.deepEqual(data.items.filter(item => item.kind === 'request').map(item => item.turnId), ['first-request', 'second-request']);
  assert.deepEqual(data.items.filter(item => item.kind === 'tool').map(item => item.turnId), ['first-request', 'second-request']);
});
// Public test fixture reproducing the observed launch transport shape. This is
// never an instruction to the test runner and no outputFile is opened.
const asyncMetadataFixture = [
  'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)',
  "agentId: fixture-child (internal ID - do not mention to user. Use SendMessage with to: 'fixture-child', summary: '<5-10 word recap>' to continue this agent.)",
  'The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.',
  "Do not duplicate this agent's work — avoid working with the same files or topics it is using.",
  'output_file: /tmp/fixture-not-opened.output',
  "Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
].join('\n');

test('hidden thinking, skill and environment injection never become user requests or evidence', () => {
  const data = parse([row('user', 'actual question'), row('assistant', [{ type: 'thinking', thinking: '', signature: 'PRIVATE_SIGNATURE' }]), row('user', 'PRIVATE_SKILL', { isMeta: true }), row('user', '<command-name>PRIVATE_COMMAND</command-name>')]);
  assert.equal(data.items.filter(x => x.kind === 'request').length, 1);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
  assert.equal(new Set(data.coverage.map(x => x.source.line)).size, 4);
});
test('tool identity and error state are independent of nonempty stderr', () => {
  const data = parse([tool('a'), result('a', true), tool('b'), result('b', false, { toolUseResult: { stderr: 'A harmless progress stream' } })]);
  assert.deepEqual(data.items.map(x => x.status), ['failed', 'completed']);
  assert.equal(data.items[1].sources[1].line, 4);
  assert.equal(data.items[1].sources[0].block, 1);
});
test('multi-record assistant message preserves later blocks rather than retaining only the first', () => {
  const data = parse([row('assistant', [], { uuid: 'r1', apiBlockIndex: 0, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'First public part' }], stop_reason: 'end_turn' } }),
    row('assistant', [], { uuid: 'r2', apiBlockIndex: 1, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'Second public part' }], stop_reason: 'end_turn' } })]);
  assert.equal(data.items.length, 1);
  assert.match(JSON.stringify(data.items), /First public part/); assert.match(JSON.stringify(data.items), /Second public part/);
});
test('async start is running; completion notification is not a user request', () => {
  const data = parse([tool('task', 'Agent'), result('task', false, { toolUseResult: { status: 'async_launched', agentId: 'child' } }), row('user', '<task-notification><task-id>child</task-id><status>completed</status></task-notification>')]);
  // The call, and a row where the agent heard back: what follows is its answer to the notification.
  assert.equal(data.items.length, 2); assert.equal(data.items[0].kind, 'subagent'); assert.equal(data.items[0].status, 'completed');
  assert.deepEqual([data.items[1].kind, data.items[1].noticeType, data.items[1].taskTool, data.items[1].status], ['notice', 'task-notification', 'Agent', 'completed']);
  assert.deepEqual(data.items[0].backgroundTask, { id: 'child', state: 'returned' });
  assert.match(data.items[0].summary, /完成通知/);
  assert.doesNotMatch(data.items[0].summary, /尚未完成/);
  assert.equal(data.items[0].availability, 'partial');
  const started = parse([tool('task', 'Agent'), result('task', false, { toolUseResult: { status: 'async_launched', agentId: 'child' } })]);
  assert.equal(started.items[0].status, 'running');
  assert.deepEqual(started.items[0].backgroundTask, { id: 'child', state: 'running' });
});
test('AskUserQuestion preserves structured answers as read-only evidence', () => {
  const data = parse([tool('q', 'AskUserQuestion'), result('q', false, { toolUseResult: { questions: [{ question: 'Which option?' }], answers: { choice: 'A' } } })]);
  assert.equal(data.items[0].kind, 'question'); assert.match(JSON.stringify(data.items[0].detail), /Which option/);
});
test('API errors, unknown content and malformed records are not hidden or called successful', () => {
  const data = parse([row('assistant', [{ type: 'text', text: 'Authentication failed' }], { isApiErrorMessage: true }), row('user', [{ type: 'future_audio', data: 'DO_NOT_DUMP' }])]);
  assert.equal(data.items[0].status, 'failed'); assert.equal(data.items[1].availability, 'unavailable');
  assert.doesNotMatch(JSON.stringify(data), /DO_NOT_DUMP/);
  const broken = parseClaude({ file: '/fixture', projectPath: '/fixture', text: '{incomplete\n' });
  assert.equal(broken.coverage[0].disposition, 'unsupported');
});
test('known PNG is retained from bytes but referenced image is explicitly unavailable', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RZ0AAAAASUVORK5CYII=';
  const data = parse([tool('read', 'Read'), row('user', [{ type: 'tool_result', tool_use_id: 'read', is_error: false, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'image', source: { type: 'url', url: 'https://example.invalid/private.png' } }] }])]);
  assert.equal(data.items[0].availability, 'partial'); assert.equal(data.items[0].detail?.blocks.filter(x => x.kind === 'image').length, 1);
  assert.doesNotMatch(JSON.stringify(data), /example.invalid/);
});

test('only known automatic attachment kinds are excluded; unknown attachment is explicit', () => {
  const data = parse([{ type: 'attachment', attachment: { type: 'total_tokens_reminder', text: 'PRIVATE_REMINDER' } }, { type: 'attachment', attachment: { type: 'future_upload', content: 'PRIVATE_ATTACHMENT' } }]);
  assert.equal(data.coverage.find(c => c.source.line === 1)?.disposition, 'excluded');
  assert.equal(data.coverage.find(c => c.source.line === 2)?.disposition, 'unsupported');
  assert.equal(data.items[0].availability, 'unavailable');
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
});

test('unsupported input remains partial after a readable tool result is appended', () => {
  const data = parse([tool('unknown', 'FutureTool'), result('unknown', false)]);
  assert.equal(data.items[0].availability, 'partial');
  assert.match(JSON.stringify(data.items[0].detail), /Fixture output/);
  assert.ok(data.coverage.some(c => c.kind === 'tool-input:FutureTool' && c.disposition === 'unsupported'));
});

test('a multi-text user message without message.id remains one request', () => {
  const data = parse([row('user', [{ type: 'text', text: 'First request part' }, { type: 'text', text: 'Additional request context' }])]);
  assert.equal(data.items.filter(i => i.kind === 'request').length, 1);
  assert.match(JSON.stringify(data.items[0].detail), /First request part/);
  assert.match(JSON.stringify(data.items[0].detail), /Additional request context/);
  assert.deepEqual(data.items[0].sources.map(s => s.block), [1, 2]);
});

test('explicitly identical blocks merge but revised UUID or apiBlockIndex text remains available', () => {
  const make = (text: string) => row('assistant', [], { uuid: 'same', apiBlockIndex: 0, message: { id: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  const data = parse([make('First version'), make('First version'), make('Corrected version')]);
  assert.equal(data.items.length, 1);
  assert.deepEqual(data.items[0].sources.map(s => s.line), [1, 2, 3]);
  const detail = data.items[0].detail!;
  assert.equal(detail.blocks.filter(b => b.text === 'First version').length, 1);
  assert.equal(detail.blocks.filter(b => b.text === 'Corrected version').length, 1);
  assert.match(detail.notice ?? '', /不同版本/);
});

test('a later end_turn promotes the same message instead of creating another answer', () => {
  const make = (stop: string) => row('assistant', [], { uuid: stop, apiBlockIndex: 0, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'Public answer' }], stop_reason: stop } });
  const data = parse([make('tool_use'), make('end_turn')]);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].kind, 'answer');
  assert.match(JSON.stringify(data.items[0].detail), /Public answer/);
});

test('orphan result keeps readable error evidence while its missing association is explicit', () => {
  const data = parse([row('user', [{ type: 'tool_result', tool_use_id: 'missing', is_error: true, content: 'Exact error evidence' }])]);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].status, 'failed');
  assert.match(data.items[0].title, /未配对/);
  assert.match(JSON.stringify(data.items[0].detail), /Exact error evidence/);
  assert.equal(data.warnings.length, 1);
});

test('structured exit state wins over stderr or quoted stdout status text', () => {
  const data = parse([tool('a'), result('a', false, { toolUseResult: { exitCode: 1, stdout: 'Process exited with code 0' } }), tool('b'), result('b', false, { toolUseResult: { exit_code: 0, stderr: 'progress only', stdout: 'Process exited with code 1' } })]);
  assert.deepEqual(data.items.map(i => i.status), ['failed', 'completed']);
});

test('embedded system reminders are excluded while neighboring public user and tool text survive', () => {
  const data = parse([row('user', '<system-reminder>PRIVATE_USER_RULE</system-reminder>\nActual request'), tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', is_error: false, content: 'Actual file fragment\n<system-reminder>PRIVATE_TOOL_RULE</system-reminder>' }]), row('user', [{ type: 'text', text: 'PRIVATE_SKILL' }], { isMeta: true })]);
  assert.equal(data.items.filter(i => i.kind === 'request').length, 1);
  assert.match(JSON.stringify(data.items), /Actual request/);
  assert.match(JSON.stringify(data.items), /Actual file fragment/);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
  assert.ok(data.coverage.some(c => c.source.line === 4 && c.source.block === 1 && c.disposition === 'excluded'));
});

test('malformed message shape is unsupported and all source rows remain accounted for', () => {
  const data = parse([row('user', { unfamiliar: 'PRIVATE_OBJECT' }), row('assistant', [{ type: 'redacted_thinking', data: 'PRIVATE_THINKING' }, { type: 'future-block', content: 'PRIVATE_BLOCK' }])]);
  assert.ok(data.coverage.some(c => c.kind === 'user:structured-message' && c.disposition === 'unsupported'));
  assert.equal(new Set(data.coverage.map(c => c.source.line)).size, 2);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
});

test('same tool identity with revised input preserves both recorded versions without implying retry', () => {
  const make = (command: string) => row('assistant', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command } }]);
  const data = parse([make('first command'), make('changed command')]);
  assert.equal(data.items.length, 1);
  assert.match(JSON.stringify(data.items[0].detail), /first command/);
  assert.match(JSON.stringify(data.items[0].detail), /changed command/);
  assert.match(data.items[0].detail?.notice ?? '', /不推断为再次执行/);
});

test('public tool text keeps whitespace and literal inline reminder markup', () => {
  const text = '    indented source code\nconst fixture = "<system-reminder>literal fixture</system-reminder>";\n';
  const data = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', is_error: false, content: text }])]);
  assert.ok(data.items[0].detail?.blocks.some(b => b.text === text));
});

test('ToolSearch reference names are readable source metadata, not tool execution or loaded definitions', () => {
  const data = parse([tool('search', 'ToolSearch'), row('user', [{ type: 'tool_result', tool_use_id: 'search', is_error: false, content: [{ type: 'tool_reference', tool_name: 'mcp__example__read' }, { type: 'tool_reference', tool_name: 'mcp__example__inspect' }] }])]);
  const refs = data.items[0].detail!.blocks.filter(b => b.label === 'ToolSearch 返回的工具引用（不代表调用）');
  assert.deepEqual(refs.map(b => b.text), ['mcp__example__read', 'mcp__example__inspect']);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].availability, 'available');
  assert.equal(data.coverage.filter(c => c.kind.endsWith('.tool_reference') && c.disposition === 'displayed' && c.source.line === 2 && c.source.block === 1).length, 2);
});

test('tool references do not authorize unknown fields, malformed names or unrelated result types', () => {
  const data = parse([tool('search', 'ToolSearch'), row('user', [{ type: 'tool_result', tool_use_id: 'search', content: [{ type: 'tool_reference', tool_name: 'known', definition: 'PRIVATE_DEFINITION' }, { type: 'tool_reference', tool_name: { private: 'PRIVATE_NAME' } }] }]), tool('other'), row('user', [{ type: 'tool_result', tool_use_id: 'other', content: [{ type: 'tool_reference', tool_name: 'PRIVATE_UNRELATED' }] }])]);
  assert.ok(data.items[0].detail?.blocks.some(b => b.text === 'known'));
  assert.equal(data.items[0].availability, 'partial');
  assert.equal(data.coverage.filter(c => c.disposition === 'unsupported').length, 3);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
});

test('the two audited Chrome MCP input shapes are preserved as explicit structures', () => {
  const inputs = [
    { name: 'mcp__claude-in-chrome__tabs_context_mcp', input: { createIfEmpty: true } },
    { name: 'mcp__claude-in-chrome__computer', input: { action: 'zoom', tabId: 0, region: [0, 0, 1, 1] } },
  ];
  const data = parse(inputs.map((value, index) => row('assistant', [{ type: 'tool_use', id: `mcp-${index}`, ...value }])));
  assert.equal(data.items.length, 2);
  for (const [index, item] of data.items.entries()) {
    assert.equal(item.availability, 'available');
    assert.deepEqual(JSON.parse(item.detail!.blocks[0].text!), inputs[index].input);
  }
  assert.ok(!data.coverage.some(c => c.disposition === 'unsupported'));
});

test('audited MCP names do not authorize unknown fields, shapes, or other actions', () => {
  const data = parse([
    row('assistant', [{ type: 'tool_use', id: 'extra', name: 'mcp__claude-in-chrome__tabs_context_mcp', input: { createIfEmpty: false, futurePrivateField: 'DO_NOT_DUMP' } }]),
    row('assistant', [{ type: 'tool_use', id: 'invalid', name: 'mcp__claude-in-chrome__computer', input: { action: 'zoom', tabId: 0, region: ['DO_NOT_DUMP'] } }]),
    row('assistant', [{ type: 'tool_use', id: 'new-action', name: 'mcp__claude-in-chrome__computer', input: { action: 'unknown-future-action', tabId: 0, region: [0, 0, 1, 1] } }]),
  ]);
  assert.equal(data.items[0].availability, 'partial');
  assert.deepEqual(JSON.parse(data.items[0].detail!.blocks[0].text!), { createIfEmpty: false });
  assert.equal(data.items[1].availability, 'unavailable');
  assert.equal(data.items[2].availability, 'unavailable');
  assert.equal(data.coverage.filter(c => c.disposition === 'unsupported').length, 3);
  assert.doesNotMatch(JSON.stringify(data), /DO_NOT_DUMP|futurePrivateField|unknown-future-action/);
});

test('recognized async launch metadata is separated only with matching structured state and identities', () => {
  const data = parse([tool('agent', 'Agent'), row('user', [{ type: 'tool_result', tool_use_id: 'agent', content: [{ type: 'text', text: asyncMetadataFixture }, { type: 'text', text: 'Separate public launch evidence' }] }], { toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'fixture-child', outputFile: '/tmp/fixture-not-opened.output' } })]);
  assert.equal(data.items[0].status, 'running');
  assert.ok(data.coverage.some(c => c.source.line === 2 && c.source.block === 1 && c.kind.startsWith('tool_result:async-launch-runtime-wrapper') && c.disposition === 'excluded'));
  assert.match(JSON.stringify(data.items[0].detail), /Separate public launch evidence/);
  assert.ok(data.items[0].detail?.blocks.some(b => b.label === '当时异步启动状态' && JSON.parse(b.text!).status === 'async_launched'));
  assert.doesNotMatch(JSON.stringify(data.items[0].detail), /never quote or paste|Do NOT Read or tail|fixture-not-opened\.output/);
});

test('ordinary internal words, quoted wrapper prose and unconfirmed async metadata are not filtered', () => {
  const cases = [
    { text: 'The user asked about internal metadata in the public result.', state: { status: 'async_launched', isAsync: true, agentId: 'fixture-child', outputFile: '/tmp/fixture-not-opened.output' } },
    { text: `Quoted example:\n${asyncMetadataFixture}`, state: { status: 'async_launched', isAsync: true, agentId: 'fixture-child', outputFile: '/tmp/fixture-not-opened.output' } },
    { text: asyncMetadataFixture, state: {} },
    { text: asyncMetadataFixture, state: { status: 'async_launched', isAsync: true, agentId: 'different-child', outputFile: '/tmp/fixture-not-opened.output' } },
  ];
  for (const { text, state } of cases) {
    const data = parse([tool('agent', 'Agent'), row('user', [{ type: 'tool_result', tool_use_id: 'agent', content: [{ type: 'text', text }] }], { toolUseResult: state })]);
    assert.ok(data.items[0].detail?.blocks.some(b => b.text === text));
    assert.ok(!data.coverage.some(c => c.kind.startsWith('tool_result:async-launch-runtime-wrapper')));
  }
});

test('real completion return stays available after the launch wrapper is separated', () => {
  const notification = '<task-notification><task-id>fixture-child</task-id><status>completed</status><result>Visible finished result</result></task-notification>';
  const data = parse([tool('agent', 'Agent'), row('user', [{ type: 'tool_result', tool_use_id: 'agent', content: [{ type: 'text', text: asyncMetadataFixture }] }], { toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'fixture-child', outputFile: '/tmp/fixture-not-opened.output' } }), row('user', notification)]);
  assert.equal(data.items.length, 2);
  assert.equal(data.items[1].noticeType, 'task-notification');
  assert.equal(data.items[0].status, 'completed');
  assert.ok(data.items[0].detail?.blocks.some(b => b.text === notification));
  assert.deepEqual(data.items[0].sources.map(s => s.line), [1, 2, 3]);
});

test('Claude result observation is separate from readable inputs, explicit empty returns and missing content', () => {
  const inputOnly = parse([tool('a')]).items[0];
  assert.equal(inputOnly.result, 'not-observed');
  assert.equal(inputOnly.availability, 'available');
  for (const content of ['', '   ', [], [{ type: 'text', text: '' }]]) {
    const item = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', content, is_error: false }])]).items[0];
    assert.equal(item.result, 'empty');
    assert.equal(item.status, 'completed');
    assert.ok(item.detail?.blocks.some(b => b.text?.includes('fixture not executed')));
  }
  for (const content of [undefined, null, { new: 'undisplayed content' }]) {
    const data = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', content, is_error: false }])]);
    assert.equal(data.items[0].result, 'unreadable');
    assert.doesNotMatch(JSON.stringify(data), /undisplayed content/);
  }
});

test('Claude output result metadata keeps failures, unknown input and partial output independent', () => {
  for (const [content, expected, isError] of [
    ['', 'empty', true],
    ['Public error', 'readable', true],
    [[{ type: 'text', text: 'Visible output' }, { type: 'unknown', body: 'undisplayed content' }], 'partial', false],
    [[{ type: 'unknown', body: 'undisplayed content' }], 'unreadable', false],
    ['[output truncated]\nPublic fragment', 'partial', false],
  ] as const) {
    const data = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', content, is_error: isError }])]);
    assert.equal(data.items[0].result, expected);
    assert.equal(data.items[0].status, isError ? 'failed' : 'completed');
    assert.doesNotMatch(JSON.stringify(data), /undisplayed content/);
  }
  const data = parse([tool('unknown-input', 'UnconfirmedTool'), result('unknown-input', false)]);
  assert.equal(data.items[0].result, 'readable');
  assert.equal(data.items[0].availability, 'partial');
});

test('Claude supported structured return fields count as output, but status flags alone do not', () => {
  const records = [tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', is_error: false }], { toolUseResult: { stdout: '', stderr: '', exit_code: 0 } })];
  assert.equal(parse(records).items[0].result, 'empty');
  const visible = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a' }], { toolUseResult: { stdout: 'Public stdout', exit_code: 0 } })]);
  assert.equal(visible.items[0].result, 'readable');
  const statusOnly = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a' }], { toolUseResult: { exit_code: 0 } })]);
  assert.equal(statusOnly.items[0].result, 'unreadable');
  assert.equal(statusOnly.items[0].status, 'completed');
});

test('Claude late returns accumulate on the source call without losing prior content or rereading hidden bodies', () => {
  const base = [tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', content: '' }])];
  const readable = [...base, result('a', false), row('user', [{ type: 'tool_result', tool_use_id: 'a', content: [] }])];
  assert.equal(parse(readable).items[0].result, 'readable');
  const data = parse([...readable, row('user', [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'thinking', text: 'PRIVATE_TEST_SENTINEL' }] }])]);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].result, 'partial');
  assert.deepEqual(data.items[0].sources.map(s => s.line), [1, 2, 3, 4, 5]);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_TEST_SENTINEL/);
  const hiddenOnly = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'thinking', text: 'PRIVATE_TEST_SENTINEL' }] }])]);
  assert.equal(hiddenOnly.items[0].result, 'unreadable');
  assert.doesNotMatch(JSON.stringify(hiddenOnly), /PRIVATE_TEST_SENTINEL/);
});

test('Claude launch wrapper metadata and later notification remain source-call observations', () => {
  const records = [tool('agent', 'Agent'), row('user', [{ type: 'tool_result', tool_use_id: 'agent', content: [{ type: 'text', text: asyncMetadataFixture }] }], { toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'fixture-child', outputFile: '/tmp/fixture-not-opened.output' } })];
  const launch = parse(records);
  assert.equal(launch.items[0].result, 'readable');
  assert.equal(launch.items[0].status, 'running');
  assert.doesNotMatch(JSON.stringify(launch.items), /internal metadata/);
  const data = parse([...records, row('user', '<task-notification><task-id>fixture-child</task-id><status>completed</status><result>Public result</result></task-notification>')]);
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].result, 'readable');
  assert.equal(data.items[0].status, 'completed');
});

test('Claude unparsed sibling result payloads cannot hide behind empty or readable content', () => {
  for (const content of ['', 'Visible output']) {
    const data = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', content, is_error: false }], { toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: true, new_payload: { body: 'UNPARSED_PAYLOAD_SENTINEL' } } })]);
    assert.equal(data.items[0].result, content ? 'partial' : 'unreadable');
    assert.equal(data.items[0].status, 'completed');
    const coverage = data.coverage.filter(c => c.kind === 'tool-result:additional-fields');
    assert.equal(coverage.length, 1); assert.equal(coverage[0].source.line, 2); assert.equal(coverage[0].source.block, 1);
    assert.equal(coverage[0].itemId, data.items[0].id); assert.equal(coverage[0].disposition, 'unsupported');
    assert.doesNotMatch(JSON.stringify(data), /UNPARSED_PAYLOAD_SENTINEL/);
  }
  const metadataOnly = parse([tool('a'), row('user', [{ type: 'tool_result', tool_use_id: 'a', content: '' }], { toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: true, returnCodeInterpretation: 'normal' } })]);
  assert.equal(metadataOnly.items[0].result, 'empty');
  assert.ok(!metadataOnly.coverage.some(c => c.disposition === 'unsupported'));
});

test('Claude known image and tool-reference payload mirrors require matching visible evidence', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RZ0AAAAASUVORK5CYII=';
  for (const visible of [true, false]) {
    const read = parse([tool('read', 'Read'), row('user', [{ type: 'tool_result', tool_use_id: 'read', content: visible ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] : '' }], { toolUseResult: { type: 'image', file: { base64: png, type: 'image/png', originalSize: 1, dimensions: {} } } })]);
    assert.equal(read.items[0].result, visible ? 'readable' : 'unreadable');
    const references = parse([tool('search', 'ToolSearch'), row('user', [{ type: 'tool_result', tool_use_id: 'search', content: visible ? [{ type: 'tool_reference', tool_name: 'Fixture' }] : '' }], { toolUseResult: { matches: ['Fixture'], query: 'fixture', total_deferred_tools: 1 } })]);
    assert.equal(references.items[0].result, visible ? 'readable' : 'unreadable');
    for (const data of [read, references]) assert.equal(data.coverage.filter(c => c.kind === 'tool-result:additional-fields').length, visible ? 0 : 1);
  }
});

test('a thinking summary Claude Code shows in its UI becomes process text; its signature never does', () => {
  const summary = '我在修复第3条切换会话报错的问题：新规则是切换会话时自动关闭临时预览。';
  const block = { type: 'thinking', thinking: summary + '\n\n', signature: 'PRIVATE_SIGNATURE' };
  const data = parse([row('user', 'question'),
    row('assistant', [block], { apiBlockIndex: 0, message: { id: 'm', role: 'assistant', content: [block] } }),
    row('assistant', [block], { apiBlockIndex: 0, message: { id: 'm', role: 'assistant', content: [block] } })]);
  const said = data.items.filter(item => item.kind === 'message');
  assert.equal(said.length, 1, 'The same block written twice is one item');
  assert.equal(said[0].title, '思考摘要'); assert.equal(said[0].summary, summary);
  assert.equal(said[0].sources.length, 2);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_SIGNATURE/);
  assert.ok(!data.items.some(item => item.title === '思考'), 'No empty phase marker next to the summary');
});

test('runtime attachments are excluded; a message typed mid-turn stays in that turn as the reader\'s words', () => {
  const attachment = (value: unknown) => ({ type: 'attachment', sessionId: 'cl', cwd: '/fixture', attachment: value });
  const data = parse([row('user', 'first question', { uuid: 'u1' }), tool('a'),
    attachment({ type: 'environment', text: 'PRIVATE_ENV' }), attachment({ type: 'silent_turn_reminder', text: 'PRIVATE_REMINDER' }),
    attachment({ type: 'queued_command', prompt: '继续', origin: { kind: 'human' }, commandMode: 'prompt' }),
    attachment({ type: 'queued_command', prompt: '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>' })]);
  assert.doesNotMatch(JSON.stringify(data.items), /PRIVATE_/);
  assert.ok(!data.items.some(item => item.title.startsWith('待核对')));
  const requests = data.items.filter(item => item.kind === 'request');
  assert.deepEqual(requests.map(item => item.summary), ['first question', '继续']);
  assert.equal(requests[1].turnId, requests[0].turnId, 'Absorbed into the running turn, not a new one');
  assert.ok(data.items.some(item => item.noticeType === 'task-notification' && item.title === '后台任务通知'));
});

test('a screenshot pasted with a request is attached to that request, not left as an unsupported block', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
  const data = parse([row('user', [{ type: 'text', text: 'look at [Image #1]' }, image], { uuid: 'u1' }), row('user', [image], { uuid: 'u2' })]);
  const requests = data.items.filter(item => item.kind === 'request');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].detail!.blocks.filter(block => block.kind === 'image').length, 1);
  assert.equal(requests[1].summary, '（仅附图）'); assert.notEqual(requests[1].turnId, requests[0].turnId);
  assert.ok(!data.items.some(item => item.title.startsWith('待核对')));
});

test('the harness marks the end of a turn: turn_duration closes it with its duration; an interrupt stops it', () => {
  const data = parse([row('user', 'question', { uuid: 'u1' }), tool('a'),
    { type: 'system', subtype: 'turn_duration', durationMs: 42000, sessionId: 'cl', cwd: '/fixture' },
    row('user', 'next', { uuid: 'u2' }), row('user', [{ type: 'text', text: '[Request interrupted by user]' }])]);
  const end = data.items.find(item => item.title === '回合结束')!;
  assert.equal(end.durationMs, 42000); assert.equal(end.status, 'completed'); assert.equal(end.turnId, 'u1');
  const stop = data.items.find(item => item.title === '回合中断')!;
  assert.equal(stop.turnId, 'u2');
  assert.equal(data.items.filter(item => item.kind === 'request').length, 2);
});

test('a background task reporting back is one notice in its own words, not an empty subtask', () => {
  const notify = (status: string, summary: string) => row('user', `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/b1.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`);
  const data = parse([row('user', 'question', { uuid: 'u1' }),
    notify('completed', 'Background command "Run real VS Code host tests" completed (exit code 0)'),
    notify('failed', 'Background command "Render replay page" failed with exit code 144'),
    notify('completed', 'Stopped watching Artifact: "Sidecar notes" (connection lost)')]);
  const notes = data.items.filter(item => item.noticeType === 'task-notification');
  assert.deepEqual(notes.map(item => [item.taskTool, item.title, item.status, item.exitCode]), [
    ['Bash', 'Run real VS Code host tests', 'completed', 0], ['Bash', 'Render replay page', 'failed', 144], ['Artifact', 'Sidecar notes', 'completed', undefined]]);
  assert.ok(!data.items.some(item => item.kind === 'subagent'));
  assert.doesNotMatch(JSON.stringify(notes.map(item => item.detail?.blocks.map(block => block.text))), /<task-notification>/);
});

test('a request resent under the same parent marks the earlier one interrupted before any reply', () => {
  const data = parse([row('user', 'question', { uuid: 'u1', parentUuid: 'p0' }), row('user', 'question again', { uuid: 'u2', parentUuid: 'p0' })]);
  const stop = data.items.find(item => item.title === '回合中断')!;
  assert.equal(stop.turnId, 'u1'); assert.match(stop.summary, /回应前中断/);
  assert.equal(data.items.filter(item => item.kind === 'request').length, 2);
  const closed = parse([row('user', 'question', { uuid: 'u1', parentUuid: 'p0' }), row('user', [{ type: 'text', text: '[Request interrupted by user]' }], { uuid: 'x', parentUuid: 'u1' }),
    row('user', 'question again', { uuid: 'u2', parentUuid: 'p0' })]);
  assert.equal(closed.items.filter(item => item.title === '回合中断').length, 1, 'A turn the source already stopped is not stopped twice');
});
