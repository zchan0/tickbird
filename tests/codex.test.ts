import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodex } from '../packages/core/src/codex';

const response = (payload: unknown) => ({ type: 'response_item', payload });
const event = (payload: unknown) => ({ type: 'event_msg', payload });
const msg = (role: string, text: string, extra = {}) => response({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra });
const parse = (...records: unknown[]) => parseCodex({ file: '/fixture/codex.jsonl', projectPath: '/project', text: records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') });
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RZ0AAAAASUVORK5CYII=';

test('session identity remains the first metadata identity when fork history contains parent metadata', () => {
  const result = parse(
    { type: 'session_meta', payload: { id: 'fork-session', cwd: '/project', forked_from_id: 'parent-session' } },
    { type: 'session_meta', payload: { id: 'parent-session', cwd: '/project' } },
    event({ type: 'task_started', turn_id: 'first-turn' }), msg('user', 'First request'),
    event({ type: 'task_complete', turn_id: 'first-turn' }),
    event({ type: 'task_started', turn_id: 'second-turn' }), msg('user', 'Second request')
  );
  assert.equal(result.id, 'fork-session');
  assert.ok(result.items.every(item => item.sessionId === 'fork-session'));
  assert.deepEqual(result.items.filter(item => item.kind === 'request').map(item => item.turnId), ['first-turn', 'second-turn']);
  assert.equal(result.coverage.filter(entry => entry.kind === 'session_meta').length, 2);
  assert.match(result.warnings.join('\n'), /继承历史/);
});

test('completed turn boundaries do not capture later unassigned records or infer a request from a later context', () => {
  const result = parse(
    { type: 'session_meta', payload: { id: 'session', cwd: '/project' } },
    event({ type: 'task_started', turn_id: 'first' }), msg('user', 'First request'),
    event({ type: 'task_complete', turn_id: 'first' }),
    msg('user', 'Request recorded before a new boundary'),
    { type: 'turn_context', payload: { turn_id: 'second' } },
    msg('assistant', 'Second turn process', { phase: 'commentary' }),
    event({ type: 'task_aborted', turn_id: 'second' }),
    msg('assistant', 'Unassigned public record', { phase: 'commentary' })
  );
  assert.deepEqual(result.items.filter(item => item.kind === 'request').map(item => item.turnId), ['first', undefined]);
  assert.deepEqual(result.items.filter(item => item.kind === 'message').map(item => item.turnId), ['second', undefined]);
  assert.ok(result.items.every(item => item.sessionId === 'session'));
});

test('late records keep their explicit old turn without retargeting the active turn', () => {
  const result = parse(
    event({ type: 'task_started', turn_id: 'old' }),
    event({ type: 'task_complete', turn_id: 'old' }),
    event({ type: 'task_started', turn_id: 'current' }),
    msg('assistant', 'Late old record', { phase: 'commentary', internal_chat_message_metadata_passthrough: { turn_id: 'old' } }),
    event({ type: 'task_complete', turn_id: 'old' }),
    msg('assistant', 'Current process', { phase: 'commentary' }),
    event({ type: 'task_started' }),
    msg('assistant', 'No reliable new turn identity', { phase: 'commentary' })
  );
  assert.deepEqual(result.items.filter(item => item.kind === 'message').map(item => item.turnId), ['old', 'current', undefined]);
});

test('observed turn_aborted schema is a traceable interruption, not unsupported or proof that all work stopped', () => {
  const result = parse(
    event({type:'task_started',turn_id:'interrupted-turn'}),
    response({type:'function_call',name:'exec_command',call_id:'running-command',arguments:'{"cmd":"fixture only, never executed"}'}),
    response({type:'function_call_output',call_id:'running-command',output:JSON.stringify({session_id:77,output:'Partial fixture output'})}),
    event({type:'sub_agent_activity',agent_path:'/root/fixture-child',kind:'running'}),
    // Field shape matches the current project log's real interruption event.
    event({type:'turn_aborted',turn_id:'interrupted-turn',reason:'interrupted',started_at:'2026-09-07T00:00:00Z',completed_at:'2026-09-07T00:00:01Z',duration_ms:1000}),
    msg('assistant','Later unassigned process',{phase:'commentary'})
  );
  const interruption = result.items.find(item => item.title === '回合中断'); assert.ok(interruption);
  assert.equal(interruption.kind,'notice'); assert.equal(interruption.turnId,'interrupted-turn');
  assert.equal(interruption.status,'unknown'); assert.equal(interruption.availability,'none'); assert.equal(interruption.detail,undefined);
  assert.deepEqual(interruption.sources,[{file:'/fixture/codex.jsonl',line:5}]);
  assert.match(interruption.summary,/不代表已启动的命令或子任务全部停止/);
  assert.equal(result.items.find(item => item.kind === 'tool')?.status,'running');
  assert.equal(result.items.find(item => item.kind === 'subagent')?.status,'running');
  assert.equal(result.items.find(item => item.kind === 'message')?.turnId,undefined);
  const coverage = result.coverage.filter(entry => entry.source.line === 5);
  assert.equal(coverage.length,1); assert.equal(coverage[0].kind,'turn_aborted');
  assert.equal(coverage[0].disposition,'displayed'); assert.equal(coverage[0].itemId,interruption.id);
  assert.ok(!result.coverage.some(entry => entry.kind === 'event:turn_aborted' || entry.disposition === 'unsupported'));
});

test('late interrupted-turn results still update their own calls without ending a newer active turn', () => {
  const result = parse(
    event({type:'task_started',turn_id:'old'}),
    response({type:'function_call',name:'exec_command',call_id:'old-call',arguments:'{}'}),
    event({type:'turn_aborted',turn_id:'old',reason:'interrupted'}),
    event({type:'task_started',turn_id:'current'}),
    response({type:'function_call',name:'exec_command',call_id:'current-call',arguments:'{}'}),
    event({type:'turn_aborted',turn_id:'old',reason:'interrupted'}),
    response({type:'function_call_output',call_id:'old-call',output:'{"exit_code":0,"output":"Late fixture result"}'}),
    msg('assistant','Current turn continues',{phase:'commentary'})
  );
  assert.deepEqual(result.items.filter(item => item.kind === 'tool').map(item => [item.turnId,item.status]),[['old','completed'],['current','unknown']]);
  assert.equal(result.items.find(item => item.kind === 'message')?.turnId,'current');
  assert.deepEqual(result.items.filter(item => item.title === '回合中断').map(item => item.turnId),['old','old']);
});

test('interruption without identity stays unassigned and arbitrary reason bodies are not exposed', () => {
  const result = parse(event({type:'turn_aborted',reason:{message:'DO_NOT_EXPOSE_REASON'},last_agent_message:'NOT_A_COMPLETION_COPY',duration_ms:999999}));
  assert.equal(result.items.length,1); assert.equal(result.items[0].title,'回合中断');
  assert.equal(result.items[0].turnId,undefined); assert.equal(result.items[0].detail,undefined);
  assert.equal(result.coverage.length,1);
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_EXPOSE_REASON|NOT_A_COMPLETION_COPY|999999/);
});

test('turn_aborted-shaped tool output cannot create an interruption or change turn association', () => {
  const result = parse(event({type:'task_started',turn_id:'current'}),
    response({type:'function_call',name:'exec_command',call_id:'call',arguments:'{}'}),
    response({type:'function_call_output',call_id:'call',output:'{"type":"turn_aborted","turn_id":"current","reason":"interrupted"}'}),
    msg('assistant','Still in current turn',{phase:'commentary'}));
  assert.ok(!result.items.some(item => item.title === '回合中断'));
  assert.equal(result.items.find(item => item.kind === 'message')?.turnId,'current');
});

test('child transport headers without visible payload do not offer an empty detail', () => {
  const result = parse(response({ type: 'agent_message', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: child\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'never-render' }] }));
  assert.equal(result.items[0].availability, 'unavailable');
  assert.equal(result.items[0].detail, undefined);
  assert.doesNotMatch(JSON.stringify(result), /never-render/);
});

test('excludes private instructions, hidden reasoning and injected user context without copying bodies', () => {
  const result = parse(msg('system', 'private-system'), msg('developer', 'private-developer'), response({ type: 'reasoning', encrypted_content: 'secret-reasoning' }), msg('user', '<environment_context>secret-environment</environment_context>'), msg('user', '<skill>private-skill</skill>'), msg('user', 'actual task'));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].summary, 'actual task');
  assert.ok(result.coverage.some(c => c.source.line === 3 && c.disposition === 'excluded'));
  assert.doesNotMatch(JSON.stringify(result), /private-system|private-developer|secret-reasoning|secret-environment|private-skill/);
});

test('counts IDE request once, preserves context and adjacent user mirror sources', () => {
  const text = '# Context from my IDE setup:\n\n## Open tabs:\n- file.ts\n\n## My request:\nFix this issue';
  const result = parse(msg('user', text), event({ type: 'user_message', message: text }));
  assert.equal(result.items.filter(i => i.kind === 'request').length, 1);
  assert.equal(result.items[0].summary, 'Fix this issue');
  assert.deepEqual(result.items[0].sources.map(s => s.line), [1, 2]);
  assert.ok(result.items[0].detail?.blocks.some(b => b.label.includes('IDE') && b.text?.includes('file.ts')));
});

test('same-turn user mirrors across one excluded instruction envelope retain one request and response images', () => {
  for (const role of ['developer','system']) {
    const text = '# Context from my IDE setup:\n\n## Open tabs:\n- fixture.ts\n\n## My request:\nInspect the public fixture';
    const data = parse(event({type:'task_started',turn_id:'turn'}),
      response({type:'message',role:'user',content:[{type:'input_text',text},{type:'input_image',image_url:`data:image/png;base64,${tinyPng}`}],internal_chat_message_metadata_passthrough:{turn_id:'turn'}}),
      msg(role,'PRIVATE_INSTRUCTION_NOT_COPIED',{internal_chat_message_metadata_passthrough:{turn_id:'turn'}}),
      event({type:'user_message',message:text,images:['data:image/png;base64,EVENT_IMAGE_VARIANT_IS_NOT_A_DEDUP_KEY'],local_images:[]}));
    const requests = data.items.filter(item => item.kind === 'request');
    assert.equal(requests.length,1);
    assert.equal(requests[0].summary,'Inspect the public fixture');
    assert.deepEqual(requests[0].sources.map(source => source.line),[2,4]);
    assert.deepEqual(requests[0].detail?.blocks.filter(block => block.kind === 'image').map(block => block.data),[tinyPng]);
    assert.equal(data.coverage.find(entry => entry.kind === 'user:mirror')?.disposition,'merged');
    assert.match(data.coverage.find(entry => entry.kind === 'user:mirror')?.reason ?? '',/仅间隔一条/);
    assert.equal(data.coverage.find(entry => entry.kind === 'message:images')?.disposition,'unsupported');
    assert.ok(data.coverage.some(entry => entry.source.line === 3 && entry.disposition === 'excluded'));
    assert.doesNotMatch(JSON.stringify(data),/PRIVATE_INSTRUCTION_NOT_COPIED|EVENT_IMAGE_VARIANT_IS_NOT_A_DEDUP_KEY/);
  }
});

test('the instruction-gap mirror rule does not merge repeats, changed text, unknown or different turns, or intervening work', () => {
  const start = event({type:'task_started',turn_id:'turn'});
  const hidden = msg('developer','PRIVATE_GAP');
  const userEvent = (message = 'Public request') => event({type:'user_message',message});
  const scenarios = [
    [start,msg('user','Public request'),hidden,msg('user','Public request')], // Same channel is a distinct request.
    [start,userEvent(),hidden,userEvent()],
    [start,msg('user','Public request'),hidden,userEvent('Changed request')],
    [msg('user','Public request'),hidden,userEvent()], // No known turn identity.
    [start,msg('user','Public request'),msg('developer','PRIVATE_GAP',{internal_chat_message_metadata_passthrough:{turn_id:'other'}}),userEvent()],
    [start,msg('user','Public request'),hidden,event({type:'user_message',message:'Public request',turn_id:'other'})],
    [start,msg('user','Public request'),hidden,hidden,userEvent()], // Only one excluded envelope is supported.
    [start,msg('user','Public request'),response({type:'function_call',name:'exec_command',call_id:'fixture',arguments:'{}'}),userEvent()],
    [start,msg('user','Public request'),msg('assistant','Public process',{phase:'commentary'}),userEvent()],
    [start,msg('user','Public request'),event({type:'agent_reasoning',text:'PRIVATE_REASONING'}),userEvent()],
  ];
  for (const records of scenarios) {
    const data = parse(...records);
    assert.equal(data.items.filter(item => item.kind === 'request').length,2);
    assert.doesNotMatch(JSON.stringify(data),/PRIVATE_GAP|PRIVATE_REASONING/);
  }
});

test('instruction-gap mirrors keep role/phase and existing citation matching constraints', () => {
  const start = event({type:'task_started',turn_id:'turn'});
  const hidden = msg('developer','PRIVATE_GAP');
  const phaseMismatch = parse(start,msg('user','Public request',{phase:'original'}),hidden,event({type:'user_message',message:'Public request'}));
  assert.equal(phaseMismatch.items.filter(item => item.kind === 'request').length,2);
  const citation = parse(start,msg('user','Public request\n<oai-mem-citation>fixture citation</oai-mem-citation>'),hidden,event({type:'user_message',message:'Public request'}));
  assert.equal(citation.items.filter(item => item.kind === 'request').length,1);
  assert.deepEqual(citation.items.find(item => item.kind === 'request')?.sources.map(source => source.line),[2,4]);
});

test('agent_reasoning events are excluded by envelope only and never become visible state or evidence', () => {
  const data = parse(event({type:'task_started',turn_id:'turn'}),
    response({type:'function_call',name:'exec_command',call_id:'fixture',arguments:'{}'}),
    event({type:'agent_reasoning',text:'PRIVATE_REASONING_BODY',content:[{type:'text',text:'PRIVATE_NESTED_BODY'}],status:'completed'}));
  const coverage = data.coverage.filter(entry => entry.source.line === 3);
  assert.equal(coverage.length,1); assert.equal(coverage[0].kind,'event:agent_reasoning');
  assert.equal(coverage[0].disposition,'excluded'); assert.equal(coverage[0].itemId,undefined);
  assert.equal(data.items.length,2);
  assert.equal(data.items.find(item => item.kind === 'tool')?.status,'unknown');
  assert.ok(!data.items.some(item => item.sources.some(source => source.line === 3)));
  assert.doesNotMatch(JSON.stringify(data),/PRIVATE_REASONING_BODY|PRIVATE_NESTED_BODY/);
});

test('assistant mirrors merge locally with citation differences; later equal text remains distinct', () => {
  const result = parse(event({ type: 'agent_message', message: 'Answer', phase: 'final_answer', memory_citation: { entries: [{ path: 'MEMORY.md', lineStart: 1, lineEnd: 2 }] } }), msg('assistant', 'Answer\n<oai-mem-citation>citation</oai-mem-citation>', { phase: 'final_answer' }), event({ type: 'token_count' }), msg('assistant', 'Answer', { phase: 'final_answer' }));
  assert.equal(result.items.filter(i => i.kind === 'answer').length, 2);
  assert.equal(result.items[0].sources.length, 2);
  assert.match(JSON.stringify(result.items[0].detail), /oai-mem-citation/);
});

test('call_id matching preserves failed calls and does not equate call completed with success', () => {
  const result = parse(response({ type: 'function_call', name: 'exec_command', call_id: 'a', status: 'completed', arguments: '{"cmd":"false"}' }), response({ type: 'function_call_output', call_id: 'a', output: '{"exit_code":1,"output":"failure details"}' }), response({ type: 'function_call', name: 'exec_command', call_id: 'b', arguments: '{"cmd":"true"}' }), response({ type: 'function_call_output', call_id: 'b', output: '{"exit_code":0,"output":"done"}' }), response({ type: 'function_call', name: 'exec_command', call_id: 'c', status: 'completed', arguments: '{"cmd":"unknown"}' }));
  assert.deepEqual(result.items.map(i => i.status), ['failed', 'completed', 'unknown']);
  assert.match(JSON.stringify(result.items[0].detail), /failure details/);
});

test('running and truncated output remains partial; waits link by cell_id', () => {
  const result = parse(response({ type: 'custom_tool_call', name: 'exec', call_id: 'a', input: 'await work()' }), response({ type: 'custom_tool_call_output', call_id: 'a', output: 'Script running with cell ID 2\nOutput:\npartial' }), response({ type: 'function_call', name: 'wait', call_id: 'b', arguments: '{"cell_id":"2"}' }), response({ type: 'function_call_output', call_id: 'b', output: 'Script running with cell ID 2\nWarning: truncated output\nfragment' }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'running');
  assert.equal(result.items[0].availability, 'partial');
  assert.equal(result.items[0].sources.length, 4);
  assert.match(result.items[0].detail?.notice ?? '', /截断/);
});

test('patch is historical evidence and unavailable changes remain explicit', () => {
  const result = parse(event({ type: 'patch_apply_end', success: true, status: 'completed', changes: { 'a.ts': { type: 'update', unified_diff: '@@\n-old\n+new' }, 'deleted.ts': { type: 'delete' } } }));
  const item = result.items[0];
  assert.equal(item.status, 'completed');
  assert.equal(item.availability, 'partial');
  assert.match(item.detail?.provenance ?? '', /不是当前 Git diff/);
  assert.equal(item.detail?.blocks[0].kind, 'patch');
  assert.ok(result.coverage.some(c => c.kind === 'file-change:delete' && c.disposition === 'unsupported'));
});

test('unknown blocks, invalid records, missing attachments and encrypted child replies have source coverage', () => {
  const result = parse('{broken', msg('user', 'task'), response({ type: 'agent_message', author: '/root/child', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nPayload:\n' }, { type: 'encrypted_content', text: 'private-child' }] }), response({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible' }, { type: 'future-block', private: 'do not dump' }, { type: 'input_image', image_url: 'file:///sensitive/image.png' }] }), { type: 'future-record', payload: { secret: 'not public' } });
  assert.equal(result.coverage.find(c => c.source.line === 1)?.disposition, 'unsupported');
  assert.equal(result.items.find(i => i.kind === 'subagent')?.availability, 'unavailable');
  assert.ok(result.coverage.some(c => c.source.line === 4 && c.source.block === 3 && c.disposition === 'unsupported'));
  assert.doesNotMatch(JSON.stringify(result), /private-child|do not dump|not public|sensitive\/image/);
  for (const line of [1, 2, 3, 4, 5]) assert.ok(result.coverage.some(c => c.source.line === line));
});

test('short fully shown commentary has no empty detail; answers and inline media are retained', () => {
  const result = parse(msg('assistant', 'Checking files', { phase: 'commentary' }), response({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'See result' }, { type: 'input_image', image_url: `data:image/png;base64,${tinyPng}` }] }));
  assert.equal(result.items[0].availability, 'none');
  assert.equal(result.items[0].detail, undefined);
  assert.ok(result.items[1].detail?.blocks.some(b => b.kind === 'image' && b.mime === 'image/png'));
});

test('MCP isError survives a same-call response mirror', () => {
  const result = parse(response({ type: 'function_call', namespace: 'mcp', name: 'query', call_id: 'a', arguments: '{}' }), event({ type: 'mcp_tool_call_end', call_id: 'a', result: { Ok: { isError: true, content: [{ type: 'text', text: 'denied' }] } } }), response({ type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'denied' }] }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'failed');
  assert.equal(result.items[0].detail?.blocks.filter(b => b.text === 'denied').length, 1);
});

test('identified standalone CUA runtime instructions are excluded in MCP and response mirrors, preserving actual failure', () => {
  const runtime = '## Computer Use\n\nControl native apps and browsers on the user’s computer by reading or operating UI.\n## API\nPRIVATE_RUNTIME_GUIDANCE\n## Workflow\nWorkflow\n# Computer/Browser Use Confirmation Policy\nPolicy\n## Confirmation Behavior Guidelines\n- Repeat confirmations unless the action, destination, data, amount, permissions, legal terms, or risk materially changes.\n';
  const result = parse(response({ type: 'function_call', namespace: 'mcp__cua_repl', name: 'js', call_id: 'cua', arguments: '{}' }),
    event({ type: 'mcp_tool_call_end', call_id: 'cua', invocation: { server: 'cua_repl', tool: 'js' }, result: { Ok: { isError: true, content: [{ type: 'text', text: 'No browser is available' }, { type: 'text', text: runtime }] } } }),
    response({ type: 'function_call_output', call_id: 'cua', output: [{ type: 'input_text', text: 'No browser is available' }, { type: 'input_text', text: runtime }] }));
  assert.equal(result.items[0].status, 'failed');
  assert.equal(result.items[0].detail?.blocks.filter(b => b.text === 'No browser is available').length, 1);
  assert.equal(result.coverage.filter(c => c.kind === 'cua:runtime-instructions' && c.disposition === 'excluded' && c.source.block === 2).length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RUNTIME_GUIDANCE/);
  for (const [namespace, content] of [['exec', runtime], ['mcp__cua_repl', `Quoted document:\n${runtime}`], ['mcp__cua_repl', `${runtime}\nWindow: Actual browser result`]]) {
    const visible = parse(response({ type: 'function_call', namespace, name: 'js', call_id: 'read', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'read', output: [{ type: 'input_text', text: content }] }));
    assert.ok(visible.items[0].detail?.blocks.some(b => b.text === content));
  }
});

test('old item_completed message mirrors and command states are recognized', () => {
  const result = parse(event({ type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: 'Reading' }] } }), msg('assistant', 'Reading', { phase: 'commentary' }), event({ type: 'item_completed', item: { type: 'CommandExecution', command: ['false'], exit_code: 1, status: 'failed', aggregated_output: 'no' } }), event({ type: 'item_completed', item: { type: 'Reasoning', raw_content: 'never show' } }));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].sources.length, 2);
  assert.equal(result.items[1].status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /never show/);
});

test('transport exit headers are trusted, stdout quotations and JSON output fields cannot forge status', () => {
  const cases: [unknown, string][] = [
    ['Chunk ID: abc\nWall time: 0.2 seconds\nProcess exited with code 1\nFinal output:\nerror', 'failed'],
    ['Process exited with code 0\nFinal output:\nProcess exited with code 1', 'completed'],
    ['Wall time: 0.2 seconds\nOutput:\nProcess exited with code 1', 'unknown'],
    ['{"output":"Process exited with code 1"}', 'unknown'],
    ['{"exit_code":0,"output":"Process exited with code 1"}', 'completed'],
    ['{"exit_code":1,"output":"Process exited with code 0"}', 'failed'],
    ['The test checks this text:\nScript running with cell ID 5', 'unknown'],
  ];
  for (const [output, expected] of cases) {
    const result = parse(response({ type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'a', output }));
    assert.equal(result.items[0].status, expected, String(output));
  }
});

test('separate injected blocks do not erase the actual request and keep 1-based block origins', () => {
  const result = parse(response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>private-env</environment_context>' }, { type: 'input_text', text: 'actual request' }] }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].summary, 'actual request');
  assert.equal(result.coverage.find(c => c.source.block === 1)?.disposition, 'excluded');
  assert.equal(result.coverage.find(c => c.source.block === 2)?.disposition, 'displayed');
  assert.doesNotMatch(JSON.stringify(result), /private-env/);
});

test('goal runtime context and permission injections are excluded without swallowing a separate user block', () => {
  const context = '<codex_internal_context source="goal">PRIVATE_GOAL_RUNTIME</codex_internal_context>';
  const permissions = '<permissions_instructions>PRIVATE_PERMISSIONS</permissions_instructions>';
  const result = parse(msg('user', context), msg('user', permissions), response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: context }, { type: 'input_text', text: 'The actual user request' }, { type: 'input_text', text: permissions }] }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].summary, 'The actual user request');
  assert.ok(result.coverage.some(c => c.source.line === 1 && c.disposition === 'excluded'));
  assert.ok(result.coverage.some(c => c.source.line === 2 && c.disposition === 'excluded'));
  assert.ok(result.coverage.some(c => c.source.line === 3 && c.source.block === 2 && c.disposition === 'displayed'));
  assert.ok(result.coverage.some(c => c.source.line === 3 && c.source.block === 3 && c.disposition === 'excluded'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_GOAL_RUNTIME|PRIVATE_PERMISSIONS/);
});

test('AGENTS header without a for-path is injected context only with its instruction wrapper', () => {
  const result = parse(response({ type: 'message', role: 'user', content: [
    { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>PRIVATE_GUIDANCE</INSTRUCTIONS>' },
    { type: 'input_text', text: '先运行起来我看下现在的效果' },
  ] }));
  assert.deepEqual(result.items.map(item => item.summary), ['先运行起来我看下现在的效果']);
  assert.equal(result.coverage.find(entry => entry.source.block === 1)?.disposition, 'excluded');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_GUIDANCE/);
  const ordinary = '# AGENTS.md instructions\n请解释这个文件为什么会出现';
  assert.equal(parse(msg('user', ordinary)).items[0].summary, ordinary);
});

test('quoted internal-context tag names in ordinary user prose remain user content', () => {
  const text = 'Please explain the tags <codex_internal_context source="goal">example</codex_internal_context> and <permissions_instructions>example</permissions_instructions>.';
  const result = parse(msg('user', text));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].summary, text);
  assert.equal(result.coverage.find(c => c.source.block === 1)?.disposition, 'displayed');
});

test('a response mirror preserves media and unsupported blocks absent from the text event', () => {
  const result = parse(event({ type: 'agent_message', message: 'result', phase: 'final_answer' }), response({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'result' }, { type: 'input_image', image_url: `data:image/png;base64,${tinyPng}` }, { type: 'new-block', secret: 'hidden' }] }));
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].detail?.blocks.some(b => b.kind === 'image'));
  assert.ok(result.coverage.some(c => c.kind === 'new-block' && c.disposition === 'unsupported' && c.source.block === 3));
  assert.doesNotMatch(JSON.stringify(result), /"secret"/);
});

test('same-call image mirrors normalize source MIME by bytes and do not duplicate the same image', () => {
  const data = parse(response({ type: 'function_call', call_id: 'img', name: 'read', arguments: '{}' }),
    event({ type: 'mcp_tool_call_end', call_id: 'img', result: { Ok: { content: [{ type: 'image', mimeType: 'image/png', data: tinyPng }], isError: false } } }),
    response({ type: 'function_call_output', call_id: 'img', output: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${tinyPng}` }] }));
  const images = data.items[0].detail!.blocks.filter(b => b.kind === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].mime, 'image/png');
  assert.ok(data.coverage.some(c => c.kind === 'input_image:mime-mismatch'));
});
test('wait final transport return finishes the explicitly linked cell', () => {
  const result = parse(response({ type: 'custom_tool_call', name: 'exec', call_id: 'a', input: 'await work()' }), response({ type: 'custom_tool_call_output', call_id: 'a', output: 'Script running with cell ID 2\nOutput:\n' }), response({ type: 'function_call', name: 'wait', call_id: 'b', arguments: '{"cell_id":"2"}' }), response({ type: 'function_call_output', call_id: 'b', output: 'Script completed\nWall time 1.0 seconds\nOutput:\ndone' }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'completed');
  assert.equal(result.items[0].availability, 'available');
});

test('Codex result observation distinguishes input-only, explicit empty and missing return bodies', () => {
  const call = response({ type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{"cmd":"public fixture input"}' });
  const inputOnly = parse(call).items[0];
  assert.equal(inputOnly.result, 'not-observed');
  assert.equal(inputOnly.availability, 'available');
  for (const output of ['', '   ', [], [{ type: 'text', text: '' }], { output: '', exit_code: 0 }, { content: [], isError: true }]) {
    const item = parse(call, response({ type: 'function_call_output', call_id: 'a', output })).items[0];
    assert.equal(item.result, 'empty', JSON.stringify(output));
    assert.ok(item.detail?.blocks.some(b => b.text?.includes('public fixture input')));
  }
  for (const output of [undefined, null, { exit_code: 0 }, { unknown: 'must not display' }]) {
    const data = parse(call, response({ type: 'function_call_output', call_id: 'a', output }));
    assert.equal(data.items[0].result, 'unreadable', JSON.stringify(output));
    assert.doesNotMatch(JSON.stringify(data), /must not display/);
  }
});

test('Codex result observation is independent of error status and preserves unsupported or truncated output', () => {
  const call = response({ type: 'function_call', name: 'fixture', call_id: 'a', arguments: '{}' });
  for (const [output, expected, status] of [
    [{ output: '', exit_code: 1 }, 'empty', 'failed'],
    [{ output: 'Public error', exit_code: 1 }, 'readable', 'failed'],
    [[{ type: 'text', text: 'Readable result' }, { type: 'unknown', body: 'unsupported body' }], 'partial', 'unknown'],
    [[{ type: 'unknown', body: 'unsupported body' }], 'unreadable', 'unknown'],
    [{ output: '[output truncated]\nPublic fragment', exit_code: 0 }, 'partial', 'completed'],
    [[{ type: 'text', text: 'Annotated result', annotations: [{ new: true }] }], 'partial', 'unknown'],
    [[{ type: 'image', mimeType: 'image/png', data: tinyPng }], 'readable', 'unknown'],
  ] as const) {
    const data = parse(call, response({ type: 'function_call_output', call_id: 'a', output }));
    assert.equal(data.items[0].result, expected);
    assert.equal(data.items[0].status, status);
    assert.doesNotMatch(JSON.stringify(data), /unsupported body/);
  }
});

test('Codex late and wrapper returns accumulate only on their explicitly matched source call', () => {
  const records = [
    response({ type: 'custom_tool_call', name: 'exec', call_id: 'a', input: 'text(await tools.exec_command({cmd:"fixture one"})); text(await tools.exec_command({cmd:"fixture two"}));' }),
    response({ type: 'custom_tool_call_output', call_id: 'a', output: 'Script running with cell ID 2\nWall time 0.1 seconds\nOutput:\n' }),
    response({ type: 'function_call', name: 'wait', call_id: 'b', arguments: '{"cell_id":"2"}' }),
  ];
  assert.equal(parse(...records).items[0].result, 'empty');
  const completed = parse(...records, response({ type: 'function_call_output', call_id: 'b', output: 'Script completed\nOutput:\nShared public wrapper result' }));
  assert.equal(completed.items.length, 1);
  assert.equal(completed.items[0].result, 'readable');
  assert.equal(completed.items[0].status, 'completed');
  assert.match(completed.items[0].detail!.notice!, /不证明内部每个命令/);
  const late = parse(...records,
    response({ type: 'function_call_output', call_id: 'b', output: 'Visible phase' }),
    response({ type: 'function_call_output', call_id: 'b', output: [] }),
    response({ type: 'function_call_output', call_id: 'b', output: [{ type: 'future-output' }] }));
  assert.equal(late.items.length, 1); assert.equal(late.items[0].result, 'partial');
  assert.deepEqual(late.items[0].sources.map(s => s.line), [1, 2, 3, 4, 5, 6]);
  for (const [name, output] of [
    ['exec_command', 'Script completed\nOutput:\n'],
    ['exec', { output: 'Script completed\nOutput:\n', exit_code: 0 }],
    ['exec', 'Quoted public example:\nScript completed\nOutput:\n'],
  ] as const) {
    const item = parse(response({ type: 'function_call', name, call_id: 'quoted', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'quoted', output })).items[0];
    assert.equal(item.result, 'readable', 'Only the actual wrapper transport is omitted from result-content observation');
  }
});

test('Codex output metadata never reads hidden bodies or confuses them with an empty return', () => {
  const call = response({ type: 'function_call', name: 'fixture', call_id: 'a', arguments: '{}' });
  for (const visible of [false, true]) {
    const data = parse(call, response({ type: 'function_call_output', call_id: 'a', output: [
      { type: 'reasoning', text: 'PRIVATE_TEST_SENTINEL' },
      ...(visible ? [{ type: 'text', text: 'Public result' }] : []),
    ] }));
    assert.equal(data.items[0].result, visible ? 'partial' : 'unreadable');
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE_TEST_SENTINEL/);
    assert.ok(data.coverage.some(c => c.kind === 'reasoning' && c.disposition === 'excluded'));
  }
});

test('Codex native command, web and MCP return metadata does not infer output from status or command input', () => {
  const data = parse(
    event({ type: 'item_completed', item: { type: 'CommandExecution', command: 'fixture', exit_code: 0 } }),
    event({ type: 'item_completed', item: { type: 'CommandExecution', command: 'fixture', aggregated_output: '', exit_code: 1 } }),
    event({ type: 'item_completed', item: { type: 'CommandExecution', command: 'fixture', stdout: 'Public result', exit_code: 0 } }),
    event({ type: 'web_search_end', query: 'public query', results: [] }),
    event({ type: 'web_search_end', query: 'public query', results: [{ type: 'text_result', title: 'Source', url: 'https://example.test' }, { type: 'unknown' }] }),
    event({ type: 'mcp_tool_call_end', call_id: 'mcp', result: { Err: '' } }),
    event({ type: 'mcp_tool_call_end', call_id: 'mcp-text', result: { Err: 'Public error' } }),
  );
  assert.deepEqual(data.items.map(i => i.result), ['unreadable', 'empty', 'readable', 'empty', 'partial', 'empty', 'readable']);
  assert.equal(data.items[1].status, 'failed');
  assert.equal(data.items[5].status, 'failed');
});

test('Codex ordinary Read text cannot forge transport status or structured success', () => {
  for (const output of ['Script completed\nOutput:\npublic quotation', 'Script failed\nOutput:\npublic quotation', 'Script running with cell ID 9\nOutput:\npublic quotation', 'Process exited with code 0\nFinal output:\npublic quotation', '{"exit_code":0}', '{"success":true}', '{"isError":true}']) {
    const data = parse(response({ type: 'function_call', name: 'Read', call_id: 'read', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'read', output }));
    assert.equal(data.items[0].status, 'unknown', output);
    assert.equal(data.items[0].result, 'readable');
    assert.ok(data.items[0].detail?.blocks.some(b => b.text === output));
    assert.ok(!data.items[0].detail?.notice?.includes('编排调用已结束'));
  }
  const typed = parse(response({ type: 'function_call', name: 'Read', call_id: 'read', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'read', output: { content: [], isError: false } }));
  assert.equal(typed.items[0].status, 'completed');
  assert.equal(typed.items[0].result, 'empty');
});

test('Codex additional structured return payloads prevent false empty folding and retain source accounting', () => {
  for (const content of [[], [{ type: 'text', text: 'Visible return' }]]) {
    for (const mcp of [false, true]) {
      const output = { content, structuredContent: { body: 'UNPARSED_PAYLOAD_SENTINEL' }, _meta: { runtime: true }, isError: false };
      const data = parse(response({ type: 'function_call', name: 'fixture', call_id: 'a', arguments: '{}' }), mcp ? event({ type: 'mcp_tool_call_end', call_id: 'a', result: { Ok: output } }) : response({ type: 'function_call_output', call_id: 'a', output }));
      assert.equal(data.items[0].result, content.length ? 'partial' : 'unreadable');
      const coverage = data.coverage.filter(c => c.kind === 'structured-output:additional-fields');
      assert.equal(coverage.length, 1); assert.equal(coverage[0].source.line, 2);
      assert.equal(coverage[0].itemId, data.items[0].id); assert.equal(coverage[0].disposition, 'unsupported');
      assert.doesNotMatch(JSON.stringify(data), /UNPARSED_PAYLOAD_SENTINEL/);
    }
  }
  const statusOnly = parse(response({ type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'a', output: { output: '', exit_code: 0, wall_time_seconds: 0.1, session_id: null, chunk_id: 'fixture', original_token_count: 0 } }));
  assert.equal(statusOnly.items[0].result, 'empty');
  assert.ok(!statusOnly.coverage.some(c => c.disposition === 'unsupported'));
  const opaque = parse(response({ type: 'function_call', name: 'unknown_tool', call_id: 'a', arguments: '{}' }), response({ type: 'function_call_output', call_id: 'a', output: '{"new_payload":"UNPARSED_PAYLOAD_SENTINEL"}' }));
  assert.equal(opaque.items[0].result, 'unreadable');
  assert.doesNotMatch(JSON.stringify(opaque), /UNPARSED_PAYLOAD_SENTINEL/);
});

test('a reasoning summary Codex shows in its UI becomes process text; the reasoning body stays out', () => {
  const data = parse(msg('user', 'actual task'),
    response({ type: 'reasoning', summary: [{ type: 'summary_text', text: '**Inspecting recent files**' }], content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }], encrypted_content: 'PRIVATE_ENCRYPTED' }),
    response({ type: 'reasoning', summary: [], encrypted_content: 'PRIVATE_ENCRYPTED' }));
  const said = data.items.filter(item => item.kind === 'message');
  assert.deepEqual(said.map(item => [item.title, item.summary]), [['思考摘要', 'Inspecting recent files']]);
  assert.doesNotMatch(JSON.stringify(data.items), /PRIVATE_/);
});
