import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SessionData, TimelineItem } from '../packages/core/src/model';
import { actionRows, actionRowSections, hasReadableEvidence, outlineCoverage, outlineTurn, resolveOutlineEvidence, visibleTurnGroups, type OutlineNode } from '../packages/core/src/outline';
import { groupSessionTurns, type TurnGroup } from '../packages/core/src/timeline';
import { parseCodex } from '../packages/core/src/codex';

function item(id: string, overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id, sessionId: 'session', turnId: 'turn-1', kind: 'tool', title: 'Read', summary: '来源中的摘要',
    status: 'completed', availability: 'available', result: 'not-observed', sources: [{ file: '/fixture/log.jsonl', line: 1 }],
    detail: { title: '当时读取', blocks: [{ kind: 'json', label: '当时调用参数', text: JSON.stringify({ file_path: '/project/file.ts' }) }] },
    ...overrides,
  };
}
const turn = (items: TimelineItem[]): TurnGroup => ({ key: 'turn:turn-1', turnId: 'turn-1', ordinal: 1, request: '本轮问题', items });
const originals = (nodes: OutlineNode[]): TimelineItem[] => nodes.flatMap(node => node.kind === 'actions' ? node.items : [node.item]);
const asSession = (items: TimelineItem[]): SessionData => ({ id: 'session', provider: 'codex', projectPath: '/project', title: '会话', items, coverage: [], warnings: [] });

test('empty thinking markers move to traceable background while public prose and failed notices remain visible', () => {
  const phase = item('phase', { kind: 'notice', title: '思考', status: 'info', availability: 'none', detail: undefined });
  const data = [item('read-before'), phase, item('read-after'), { ...phase, id: 'failed-phase', status: 'failed' as const },
    { ...phase, id: 'public-prose', kind: 'message' as const, summary: '先核对启动入口' }];
  const result = outlineTurn(turn(data));
  assert.deepEqual(result.background, [phase]);
  assert.deepEqual(originals(result.nodes).map(item => item.id), ['read-before', 'read-after', 'failed-phase', 'public-prose']);
  assert.equal(result.nodes.filter(node => node.kind === 'actions').length, 2, 'Do not merge actions across the recorded phase boundary');
  assert.equal(outlineCoverage(asSession(data)).find(entry => entry.itemId === 'phase')!.surface, 'ledger-only');
});
function rowsFor(items: TimelineItem[]) {
  const group = outlineTurn(turn(items)).nodes.find(node => node.kind === 'actions');
  assert.ok(group && group.kind === 'actions');
  return actionRows(group);
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('outline is a deterministic projection retaining every source object and evidence reference without mutation', () => {
  const source = freezeDeep(turn([
    item('start', { kind: 'notice', title: '回合开始', status: 'running', availability: 'none', detail: undefined }),
    item('request', { kind: 'request' }), item('context', { kind: 'context' }),
    item('narrative', { kind: 'message' }), item('read-1'), item('read-2'),
    item('answer', { kind: 'answer' }),
    item('end', { kind: 'notice', title: '回合结束', availability: 'none', detail: undefined }),
  ]));
  const before = JSON.stringify(source);
  const result = outlineTurn(source);
  const routed = [...result.background, ...result.boundaries, ...originals(result.nodes)];
  assert.equal(routed.length, source.items.length);
  assert.equal(new Set(routed.map(value => value.id)).size, source.items.length);
  for (const original of source.items) {
    const rendered = routed.find(value => value.id === original.id);
    assert.equal(rendered, original);
    assert.equal(rendered?.sources, original.sources);
    assert.equal(rendered?.detail, original.detail);
  }
  assert.deepEqual(outlineTurn(source), result);
  assert.equal(JSON.stringify(source), before);
});

test('request and attached context move into background and interrupt contiguous action groups', () => {
  const question = item('request', { kind: 'request', summary: '用户实际的问题' });
  const context = item('context', { kind: 'context', summary: '附带的 IDE 背景' });
  const result = outlineTurn(turn([item('before'), question, item('between'), context, item('after')]));
  assert.deepEqual(result.background, [question, context]);
  assert.deepEqual(result.nodes.map(node => node.kind), ['actions', 'actions', 'actions']);
  assert.deepEqual(originals(result.nodes).map(value => value.id), ['before', 'between', 'after']);
});

test('ordinary lifecycle markers become boundaries but interruption, missing content, unsupported records and errors remain visible', () => {
  const start = item('start', { kind: 'notice', title: '回合开始', status: 'running', availability: 'none', detail: undefined });
  const end = item('end', { kind: 'notice', title: '回合结束', availability: 'none', detail: undefined });
  const visible = [
    item('abort', { kind: 'notice', title: '回合中断', status: 'unknown', availability: 'none', detail: undefined }),
    item('missing', { kind: 'notice', title: '结果不可取得', status: 'unknown', availability: 'unavailable', detail: undefined }),
    item('unsupported', { kind: 'notice', title: '待支持：新内容类型', status: 'unknown', availability: 'unavailable', detail: undefined }),
    item('failed-tool', { status: 'failed' }),
    item('failed-change', { kind: 'file-change', status: 'failed' }),
    item('error', { kind: 'notice', title: '来源报告错误', status: 'failed' }),
  ];
  const result = outlineTurn(turn([start, ...visible, end]));
  assert.deepEqual(result.boundaries, [start, end]);
  assert.deepEqual(result.nodes.map(node => node.kind), ['record', 'record', 'record', 'actions', 'record']);
  assert.deepEqual(originals(result.nodes), visible);
});

test('parsed turn_aborted remains a visible source-backed interruption without an empty detail action', () => {
  const session = parseCodex({file:'/fixture/interruption.jsonl',projectPath:'/project',text:[
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn-1'}},
    {type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call',arguments:'{}'}},
    {type:'event_msg',payload:{type:'turn_aborted',turn_id:'turn-1',reason:'interrupted'}},
  ].map(record => JSON.stringify(record)).join('\n')});
  const group = groupSessionTurns(session)[0];
  const outline = outlineTurn(group);
  const interruption = session.items.find(item => item.title === '回合中断'); assert.ok(interruption);
  assert.deepEqual(outline.nodes.map(node => node.kind),['actions','record']);
  assert.ok(outline.nodes.some(node => node.kind === 'record' && node.item === interruption));
  assert.ok(!outline.boundaries.includes(interruption));
  assert.equal(hasReadableEvidence(interruption),false);
  assert.equal(resolveOutlineEvidence(session,interruption.id)?.item,interruption);
  assert.equal(outlineCoverage(session).find(entry => entry.itemId === interruption.id)?.surface,'evidence-or-notice');
  assert.equal(interruption.sources[0].line,3);
});

test('lifecycle labels do not hide a failed state or evidence availability boundary', () => {
  const visible = ['回合开始', '回合结束'].flatMap((title, index) => [
    item(`failed-${index}`, { kind: 'notice', title, status: 'failed', availability: 'none', detail: undefined }),
    item(`unavailable-${index}`, { kind: 'notice', title, availability: 'unavailable', detail: undefined }),
    item(`partial-${index}`, { kind: 'notice', title, availability: 'partial' }),
    item(`evidence-${index}`, { kind: 'notice', title, availability: 'available' }),
  ]);
  const result = outlineTurn(turn(visible));
  assert.deepEqual(result.boundaries, []);
  assert.deepEqual(result.nodes.map(node => node.kind), visible.map(() => 'record'));
  assert.deepEqual(originals(result.nodes), visible);
});

test('only the exact content-free informational child interaction marker becomes activity metadata', () => {
  const marker = item('interaction', {
    kind: 'subagent', title: '/root/child', summary: '已记录活动：interacted。', status: 'info', availability: 'none', detail: undefined,
  });
  const visible = [
    ...(['failed', 'completed', 'running', 'unknown'] as const).map(status => ({ ...marker, id: `state-${status}`, status })),
    ...(['available', 'partial', 'unavailable'] as const).map(availability => ({ ...marker, id: `content-${availability}`, availability })),
    { ...marker, id: 'detail-empty', detail: { title: '已有详情边界', blocks: [] } },
    { ...marker, id: 'detail-return', detail: { title: '子任务返回', blocks: [{ kind: 'text' as const, label: '返回', text: '核对完成' }] } },
    { ...marker, id: 'different-kind', kind: 'notice' as const },
    { ...marker, id: 'public-explanation', kind: 'message' as const },
    { ...marker, id: 'actual-return', summary: '来自子 Agent 的记录；只读查看。' },
    { ...marker, id: 'additional-content', summary: '已记录活动：interacted。另有公开说明。' },
    { ...marker, id: 'call', title: 'collaboration/spawn_agent', summary: '调用已记录；尚无最终结果。' },
  ];
  const source = freezeDeep(turn([item('before'), marker, item('after'), ...visible]));
  const result = outlineTurn(source);
  assert.deepEqual(result.boundaries, [marker]);
  assert.equal(result.boundaries[0], marker);
  assert.deepEqual(originals(result.nodes).map(value => value.id), ['before', 'after', ...visible.map(value => value.id)]);
  assert.deepEqual(result.nodes.slice(0, 2).map(node => node.kind === 'actions' ? node.items.map(value => value.id) : node.item.id), [['before'], ['after']]);
  for (const original of visible) assert.equal(originals(result.nodes).find(value => value.id === original.id), original);
  const routes = outlineCoverage({
    id: 'session', provider: 'codex', title: '会话', projectPath: '/project', items: source.items, coverage: [], warnings: [],
  });
  assert.equal(routes.length, source.items.length);
  assert.deepEqual(routes.filter(route => route.surface === 'activity-metadata'), [
    { itemId: marker.id, turnKey: source.key, surface: 'activity-metadata' },
  ]);
  for (const original of visible) assert.notEqual(routes.find(route => route.itemId === original.id)?.surface, 'activity-metadata');
});

test('public explanations are narrative body while answers, questions and child-task returns keep distinct records', () => {
  const explanation = item('explanation', { kind: 'message', summary: '我先核对公开接口，再检查实现。' });
  const records = [item('answer', { kind: 'answer' }), item('question', { kind: 'question' }), item('child', { kind: 'subagent' })];
  const result = outlineTurn(turn([explanation, ...records]));
  assert.equal(result.nodes[0].kind, 'narrative');
  assert.equal(result.nodes[0].kind === 'narrative' && result.nodes[0].item, explanation);
  assert.equal(result.nodes[0].kind === 'narrative' && result.nodes[0].item.summary, explanation.summary);
  assert.deepEqual(result.nodes.slice(1).map(node => node.kind), ['record', 'record', 'record']);
  assert.deepEqual(originals(result.nodes).slice(1), records);
});

test('contiguous actions retain mixed states while narrative, failure and lifecycle boundaries split groups', () => {
  const result = outlineTurn(turn([
    item('completed-1'), item('completed-change', { kind: 'file-change' }),
    item('running-1', { status: 'running' }), item('running-2', { status: 'running' }),
    item('unknown', { status: 'unknown' }),
    item('narrative', { kind: 'message' }), item('after-narrative'),
    item('failure', { status: 'failed' }), item('after-failure'),
    item('end', { kind: 'notice', title: '回合结束', availability: 'none', detail: undefined }), item('after-end'),
  ]));
  assert.deepEqual(result.nodes.map(node => node.kind === 'actions' ? node.items.map(value => value.id) : node.item.id), [
    ['completed-1', 'completed-change', 'running-1', 'running-2', 'unknown'],
    'narrative', ['after-narrative', 'failure', 'after-failure'], ['after-end'],
  ]);
  const groups = result.nodes.filter(node => node.kind === 'actions');
  assert.equal(new Set(groups.map(group => group.key)).size, groups.length);
  for (const group of groups) assert.equal(group.key, `actions:${group.items[0].id}`);
});

test('informational source events may fold beside completed calls without upgrading their original status', () => {
  const completed = item('completed');
  const info = item('source-info', { title: 'Web 来源', status: 'info', availability: 'none', detail: undefined });
  const more = item('completed-again');
  const pending = item('pending', { status: 'unknown' });
  const running = item('running', { status: 'running' });
  const after = item('info-after', { status: 'info' });
  const result = outlineTurn(freezeDeep(turn([completed, info, more, pending, running, after])));
  assert.deepEqual(result.nodes.map(node => node.kind === 'actions' ? node.items.map(value => value.id) : node.item.id), [
    ['completed', 'source-info', 'completed-again', 'pending', 'running', 'info-after'],
  ]);
  const first = result.nodes[0];
  assert.equal(first.kind, 'actions');
  if (first.kind !== 'actions') return;
  assert.deepEqual(first.items.map(value => value.status), ['completed', 'info', 'completed', 'unknown', 'running', 'info']);
  assert.equal(first.items[1], info);
  assert.equal(info.status, 'info', 'A folded result event is not promoted to a successful execution');
});

test('duplicate exact action keys count original calls without merging distinct paths or dropping source order', () => {
  const other = item('other-target', { detail: { title: '当时读取', blocks: [{ kind: 'json', label: '当时调用参数', text: JSON.stringify({ file_path: '/different/file.ts' }) }] } });
  const first = item('same-1');
  const second = item('same-2');
  const third = item('same-3');
  const result = outlineTurn(turn([first, other, second, third]));
  assert.equal(result.nodes.length, 1);
  const group = result.nodes[0];
  assert.equal(group.kind, 'actions');
  if (group.kind !== 'actions') return;
  assert.deepEqual(group.items, [first, other, second, third]);
  assert.equal(group.entries.length, 2, 'Same basename is not the same recorded target');
  assert.deepEqual(group.entries[0].items, [first, second, third]);
  assert.deepEqual(group.entries[1].items, [other]);
  assert.notEqual(group.entries[0].description.key, group.entries[1].description.key);
  assert.equal(group.entries.reduce((count, entry) => count + entry.items.length, 0), group.items.length);
  assert.equal(group.entries[0].items[1], second, 'Grouping retains the original evidence ID and object');
});

test('session grouping followed by outline keeps identical actions in separate turns and unknown spans', () => {
  const source: SessionData = {
    id: 'session', provider: 'codex', projectPath: '/project', title: '会话', coverage: [], warnings: [],
    items: [item('one'), item('unknown', { turnId: undefined }), item('two', { turnId: 'turn-2' }), item('late-one')],
  };
  const groups = groupSessionTurns(source);
  const result = groups.map(group => outlineTurn(group));
  assert.deepEqual(result.map(outline => originals(outline.nodes).map(value => value.id)), [['one', 'late-one'], ['unknown'], ['two']]);
  assert.equal(result.flatMap(outline => originals(outline.nodes)).length, source.items.length);
  result.forEach((outline, index) => originals(outline.nodes).forEach(value => assert.equal(value.turnId, groups[index].turnId)));
});

test('outline coverage gives every original item exactly one metadata-only presentation route', () => {
  const sensitiveContent = 'fixture-private-content-must-not-enter-metadata';
  const source = freezeDeep<SessionData>({
    id: 'session', provider: 'codex', projectPath: '/project', title: sensitiveContent,
    warnings: [sensitiveContent], coverage: [{ source: { file: sensitiveContent, line: 8 }, kind: 'text', disposition: 'displayed', reason: sensitiveContent }],
    items: [
      item('start', { kind: 'notice', title: '回合开始', status: 'running', availability: 'none', detail: undefined }),
      item('request', { kind: 'request', summary: sensitiveContent }), item('context', { kind: 'context', summary: sensitiveContent }),
      item('narrative', { kind: 'message', summary: sensitiveContent }), item('read-1'), item('read-2'),
      item('failure', { status: 'failed', summary: sensitiveContent }),
      item('end', { kind: 'notice', title: '回合结束', availability: 'none', detail: undefined }),
      item('unknown-span', { turnId: undefined, kind: 'notice', title: sensitiveContent, availability: 'unavailable', detail: undefined }),
      item('second-turn', { turnId: 'turn-2', detail: { title: sensitiveContent, blocks: [{ kind: 'text', label: '证据', text: sensitiveContent }] } }),
    ],
  });
  const before = JSON.stringify(source);
  const routes = outlineCoverage(source);
  assert.equal(routes.length, source.items.length);
  assert.equal(new Set(routes.map(route => route.itemId)).size, source.items.length);
  assert.deepEqual([...routes.map(route => route.itemId)].sort(), source.items.map(value => value.id).sort());
  assert.deepEqual(Object.fromEntries(routes.map(route => [route.itemId, route.surface])), {
    request: 'turn-request', context: 'ledger-only',
    start: 'turn-boundary-metadata', end: 'turn-boundary-metadata', narrative: 'public-narrative',
    'read-1': 'action-detail', 'read-2': 'action-detail',
    failure: 'action-detail', 'unknown-span': 'evidence-or-notice', 'second-turn': 'action-detail',
  });
  for (const route of routes) {
    const fields = ['itemId', 'turnKey', 'surface'];
    if (route.groupKey) fields.push('groupKey');
    if (route.surface === 'action-detail') fields.push('rowIds');
    assert.deepEqual(Object.keys(route).sort(), fields.sort());
    assert.ok(Object.entries(route).every(([key, value]) => key === 'rowIds' ? Array.isArray(value) && value.every(id => typeof id === 'string') : typeof value === 'string'));
    if (route.groupKey) assert.ok(route.groupKey.startsWith('actions:'));
  }
  assert.equal(routes.find(route => route.itemId === 'read-1')?.groupKey, routes.find(route => route.itemId === 'read-2')?.groupKey);
  assert.equal(routes.find(route => route.itemId === 'unknown-span')?.turnKey, 'unassigned:unknown-span');
  assert.equal(routes.find(route => route.itemId === 'second-turn')?.turnKey, 'turn:turn-2');
  assert.ok(!JSON.stringify(routes).includes(sensitiveContent));
  assert.deepEqual(outlineCoverage(source), routes);
  assert.equal(JSON.stringify(source), before, 'Presentation metadata does not rewrite parser coverage or source content');
});

test('semantic rows combine exact atom keys while retaining original object order, states and deterministic IDs', () => {
  const first = item('first');
  const different = item('different', { detail: { title: '读取其他文件', blocks: [{ kind: 'json', label: '当时调用参数', text: JSON.stringify({ file_path: '/elsewhere/file.ts' }) }] } });
  const pending = item('pending', { status: 'running', availability: 'partial' });
  const last = item('last', { status: 'unknown' });
  const source = freezeDeep([first, different, pending, last]);
  const before = JSON.stringify(source);
  const rows = rowsFor(source);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].items, [first, pending, last]);
  assert.deepEqual(rows[0].items.map(value => value.status), ['completed', 'running', 'unknown']);
  assert.deepEqual(rows[0].items.map(value => value.availability), ['available', 'partial', 'available']);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].items[1], pending);
  assert.equal(rows[1].items[0], different);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.deepEqual(rowsFor(source), rows);
  assert.deepEqual(rowsFor([...source, item('appended')]).map(row => row.id), rows.map(row => row.id));
  assert.equal(JSON.stringify(source), before);
});

test('one wrapper can map to multiple semantic rows and repeated input occurrences are not counted as source calls', () => {
  const wrapper = item('wrapper', { title: 'exec', detail: { title: '原始编排', blocks: [{ kind: 'code', label: '记录中的调用参数', text:
    'await tools.web__run({search_query:[{q:"sidecar docs"}]}); await tools.exec_command({cmd:"cat /project/file.ts"}); await tools.web__run({search_query:[{q:"sidecar docs"}]});' }] } });
  const rows = rowsFor([wrapper]);
  assert.equal(rows.length, 2);
  assert.match(rows[0].description.label, /Web.*搜索/);
  assert.equal(rows[0].count, 2, 'Two recorded input occurrences, not two proven executions');
  assert.equal(rows[0].items.length, 1);
  assert.equal(rows[0].items[0], wrapper);
  assert.match(rows[1].description.label, /读取/);
  const routes = outlineCoverage(asSession([wrapper]));
  assert.equal(routes.length, 1, 'One original source record gets one coverage entry even when it appears in two rows');
  assert.deepEqual(routes[0].rowIds, sectionsFor([wrapper]).flatMap(section => section.rows.map(row => row.id)));
});

test('Web source-result records retain their own row and evidence even without invocation atoms', () => {
  const first = item('web-source-1', { title: 'Web 来源', status: 'info', detail: { title: '来源片段', blocks: [{ kind: 'text', label: '来源', text: 'https://example.test/one — 当时的片段' }] } });
  const second = { ...first, id: 'web-source-2' };
  const group = outlineTurn(turn([first, second])).nodes[0];
  assert.equal(group.kind, 'actions');
  if (group.kind !== 'actions') return;
  const rows = actionRows(group);
  assert.equal(rows.length, 1);
  assert.match(rows[0].description.label, /来源结果/);
  assert.equal(rows[0].count, 2);
  assert.deepEqual(rows[0].items, [first, second]);
  const fallback = actionRows({ ...group, entries: group.entries.map(entry => ({ ...entry, description: { ...entry.description, entries: [] } })) });
  assert.equal(fallback.length, 1);
  assert.match(fallback[0].description.label, /来源结果/);
  assert.deepEqual(fallback[0].items, [first, second]);
  assert.equal(fallback[0].count, 2);
  assert.deepEqual(resolveOutlineEvidence(asSession([first, second]), rows[0].id)?.items, [first, second]);
});

test('original IDs resolve unchanged while every semantic row resolves a separate semantic header with original evidence', () => {
  const original = freezeDeep(item('wrapper', { title: 'exec', detail: { title: '原始编排标题', blocks: [{ kind: 'code', label: '记录中的调用参数', text: 'await tools.exec_command({cmd:"cat /project/file.ts"});' }] } }));
  const source = freezeDeep(asSession([original]));
  const before = JSON.stringify(source);
  const row = rowsFor(source.items)[0];
  assert.equal(resolveOutlineEvidence(source, original.id)?.item, original);
  const evidence = resolveOutlineEvidence(source, row.id);
  assert.ok(evidence);
  assert.notEqual(evidence.item, original);
  assert.equal(evidence.item.id, row.id);
  assert.equal(evidence.item.title, row.description.label);
  assert.notEqual(evidence.item.title, 'exec');
  assert.equal(evidence.items?.[0], original);
  assert.deepEqual(evidence.item.detail?.blocks, [], 'Synthetic header does not copy or overwrite original result blocks');
  assert.equal(evidence.item.sessionId, source.id);
  assert.equal(evidence.item.turnId, original.turnId);
  assert.equal(JSON.stringify(source), before);
  assert.equal(resolveOutlineEvidence(source, 'unknown-row'), undefined);
  const foreign = { ...original, id: 'foreign-item', sessionId: 'another-session' };
  assert.equal(resolveOutlineEvidence(asSession([foreign]), foreign.id), undefined, 'Direct original-ID lookup must not bypass the bound-session identity check');
});

test('the folding trial resolves attention evidence separately without overwriting source availability boundaries', () => {
  const complete = item('complete');
  const pending = item('pending', { status: 'unknown', availability: 'partial', detail: { ...complete.detail!, notice: '仅取得部分输出' } });
  const missing = item('missing', { status: 'info', availability: 'unavailable' });
  const source = freezeDeep(asSession([complete, pending, missing]));
  const legacyRow = rowsFor(source.items)[0];
  const rows = sectionsFor(source.items).flatMap(section => section.rows);
  assert.ok(rows.every(row => row.id !== legacyRow.id), 'A trial subset cannot reuse an existing aggregate identity');
  const legacyEvidence = resolveOutlineEvidence(source, legacyRow.id)!;
  assert.deepEqual(legacyEvidence.items, [complete, pending, missing], 'Previously issued aggregate IDs still resolve their complete original source set');
  assert.equal(legacyEvidence.item.availability, 'partial');
  assert.equal(legacyEvidence.item.status, 'unknown');
  assert.equal(legacyEvidence.items?.[2].availability, 'unavailable');
  assert.deepEqual(rows.map(row => row.items), [[complete], [pending], [missing]]);
  const evidence = resolveOutlineEvidence(source, rows[1].id)!;
  assert.deepEqual(evidence.items, [pending]);
  assert.equal(evidence.items?.[0].detail?.notice, '仅取得部分输出');
  assert.equal(resolveOutlineEvidence(source, rows[2].id), undefined);
  assert.equal(evidence.item.availability, 'partial');
  assert.equal(evidence.item.status, 'unknown');
  assert.deepEqual(evidence.item.sources, pending.sources);
  assert.equal(complete.status, 'completed');
  assert.equal(pending.status, 'unknown');
});

test('no-content semantic rows cannot resolve to empty details; safe readable evidence is required', () => {
  const empty = item('empty', { detail: { title: '空', blocks: [{ kind: 'text', label: '空白', text: '   ' }] } });
  const unavailable = item('unavailable', { availability: 'unavailable' });
  for (const value of [empty, unavailable]) {
    assert.equal(hasReadableEvidence(value), false);
    assert.equal(resolveOutlineEvidence(asSession([value]), rowsFor([value])[0].id), undefined);
    assert.equal(resolveOutlineEvidence(asSession([value]), value.id)?.item, value, 'Original identity resolution is separate from opening authorization');
  }
  const invalidImage = item('svg', { detail: { title: '无效图像', blocks: [{ kind: 'image', label: '图像', mime: 'image/svg+xml', data: 'PHN2Zy8+' }] } });
  assert.equal(hasReadableEvidence(invalidImage), false);
  const partial = item('partial', { availability: 'partial' });
  assert.equal(hasReadableEvidence(partial), true);
  assert.ok(resolveOutlineEvidence(asSession([partial]), rowsFor([partial])[0].id));
});

function sectionsFor(items: TimelineItem[]) {
  return outlineTurn(turn(items)).nodes.flatMap(node => node.kind === 'actions' ? actionRowSections(node) : []);
}

test('only explicitly ordinary no-result actions fold; readable results and attention states delimit source-ordered runs', () => {
  const source = freezeDeep([
    item('input-1'), item('input-2', { result: 'empty' }),
    item('output', { result: 'readable' }), item('input-3'),
    item('running', { status: 'running' }), item('input-4'),
    item('unclassified-status', { status: 'unknown', result: undefined }), item('input-5'),
    item('partial-result', { result: 'partial' }), item('input-6'),
    item('unsupported-result', { result: 'unreadable' }), item('input-7'),
    item('unavailable', { availability: 'unavailable' }), item('input-8'),
    item('partial-evidence', { availability: 'partial' }), item('input-9'),
    item('unclassified', { result: undefined }), item('input-10'),
  ]);
  const before = JSON.stringify(source);
  const sections = sectionsFor(source);
  assert.deepEqual(sections.map(section => section.kind), [
    'folded-actions', 'result', 'folded-actions', 'attention', 'folded-actions', 'attention',
    'folded-actions', 'attention', 'folded-actions', 'attention', 'folded-actions', 'attention',
    'folded-actions', 'attention', 'folded-actions', 'attention', 'folded-actions',
  ]);
  assert.equal(sections[0].rows.length, 1);
  assert.equal(sections[0].rows[0].count, 2);
  assert.deepEqual(sections.flatMap(section => section.rows.flatMap(row => row.items)), source);
  assert.equal(new Set(sections.map(section => section.id)).size, sections.length);
  assert.deepEqual(sectionsFor(source), sections);
  assert.equal(JSON.stringify(source), before);
  assert.ok(source.every(original => sections.some(section => section.rows.some(row => row.items.includes(original)))));
});

test('result classification never follows input detail readability and an invalid readable result stays visible', () => {
  const onlyInput = item('only-input');
  assert.ok(hasReadableEvidence(onlyInput));
  assert.equal(sectionsFor([onlyInput])[0].kind, 'folded-actions');
  assert.equal(sectionsFor([item('empty', { result: 'empty' })])[0].kind, 'folded-actions');
  const unverified = item('unverified-input', { status: 'unknown' });
  assert.equal(sectionsFor([unverified])[0].kind, 'folded-actions');
  assert.equal(sectionsFor([unverified])[0].rows[0].items[0].status, 'unknown', 'Folded does not mean completed');
  assert.equal(sectionsFor([{ ...unverified, result: 'empty' }])[0].kind, 'folded-actions');
  assert.equal(sectionsFor([{ ...unverified, result: 'readable' }])[0].kind, 'result');
  assert.equal(sectionsFor([item('reported-readable-without-content', { result: 'readable', detail: undefined })])[0].kind, 'attention');
  const opaque = item('dynamic-wrapper', { title: 'exec', detail: { title: '编排', blocks: [{ kind: 'code', label: '记录中的调用参数', text: 'await tools[name](args);' }] } });
  assert.equal(sectionsFor([opaque])[0].kind, 'attention', 'Unparsed input must not disappear into an ordinary run');
});

test('questions, failures, narrative and turn boundaries keep separate visible nodes between folding runs', () => {
  const records = [item('ask', { kind: 'question' }), item('failure', { status: 'failed' }), item('narrative', { kind: 'message' })];
  const source = [item('before'), records[0], item('between-1'), records[1], item('between-2'), records[2], item('after')];
  const outline = outlineTurn(turn(source));
  assert.deepEqual(outline.nodes.map(node => node.kind), ['actions', 'record', 'actions', 'narrative', 'actions']);
  assert.deepEqual(sectionsFor(source).flatMap(section => section.rows.flatMap(row => row.items)).map(value => value.id), ['before', 'between-1', 'failure', 'between-2', 'after']);
  for (const record of [records[0], records[2]]) assert.ok(outline.nodes.some(node => node.kind !== 'actions' && node.item === record));
  assert.ok(sectionsFor(source).some(section => section.kind === 'attention' && section.rows.some(row => row.items.includes(records[1]))));
  const groups = visibleTurnGroups(asSession([item('turn-1'), item('turn-2', { turnId: 'turn-2' })]));
  assert.equal(groups.length, 2);
  assert.notEqual(sectionsFor(groups[0].items)[0].id, sectionsFor(groups[1].items)[0].id);
});

test('one shared wrapper return gets one source-level result entrance, retaining the input directory IDs and source counts', () => {
  const wrapper = item('wrapper-result', { title: 'exec', detail: { title: '原始编排', blocks: [{ kind: 'code', label: '记录中的调用参数', text:
    'await tools.web__run({search_query:[{q:"sidecar docs"}]}); await tools.exec_command({cmd:"cat /project/file.ts"}); await tools.web__run({search_query:[{q:"sidecar docs"}]});' }] } });
  const inputSections = sectionsFor([wrapper]);
  const observed = freezeDeep({ ...wrapper, result: 'readable' as const, detail: { ...wrapper.detail!, blocks: [...wrapper.detail!.blocks, { kind: 'text' as const, label: '当时结果', text: 'one shared output' }] } });
  const sections = sectionsFor([observed]);
  assert.deepEqual(sections.map(section => section.kind), ['folded-actions', 'result']);
  assert.equal(sections[0].id, inputSections[0].id);
  assert.deepEqual(sections[0].rows.map(row => row.id), inputSections[0].rows.map(row => row.id));
  assert.deepEqual(sections[0].rows.map(row => row.count), [1, 1, 1]);
  assert.equal(sections[1].rows.length, 1);
  const result = sections[1].rows[0];
  assert.equal(result.count, 1, 'The shared result is one source record, not three proven call results');
  assert.deepEqual(result.items, [observed]);
  assert.notEqual(result.description.label, 'exec');
  assert.equal(result.description.label, 'Output');
  assert.equal(result.description.toolName, undefined);
  assert.equal(result.role, 'output');
  const session = asSession([observed]);
  const evidence = resolveOutlineEvidence(session, result.id);
  assert.equal(evidence?.item.title, result.description.label);
  assert.equal(evidence?.items?.[0], observed);
  for (const row of inputSections[0].rows) assert.equal(resolveOutlineEvidence(session, row.id)?.items?.[0], observed);
  const coverage = outlineCoverage(session);
  assert.equal(coverage.length, 1);
  assert.deepEqual(coverage[0].rowIds, sections.flatMap(section => section.rows.map(row => row.id)));
});

test('single action result refresh retains evidence identity while Web source results remain source-count rows', () => {
  const input = item('stable-input');
  const previous = sectionsFor([input])[0].rows[0];
  const returned = { ...input, result: 'readable' as const };
  const next = sectionsFor([returned])[0];
  assert.equal(next.kind, 'result');
  assert.equal(next.rows[0].id, previous.id);
  assert.equal(resolveOutlineEvidence(asSession([returned]), previous.id)?.items?.[0], returned);
  const web = item('source-result', { title: 'Web 来源', result: 'readable', status: 'info' });
  const sources = sectionsFor([web, { ...web, id: 'source-result-2' }]);
  assert.deepEqual(sources.map(section => section.kind), ['result', 'result']);
  assert.ok(sources.every(section => section.rows.length === 1 && section.rows[0].count === 1 && section.rows[0].description.label.includes('来源结果')));
});

test('real parsed refresh keeps unchanged later row and section identity when an earlier action becomes failed', () => {
  const response = (payload: object) => ({ type: 'response_item', payload });
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    response({ type: 'function_call', name: 'Read', call_id: 'a', arguments: '{"file_path":"/fixture/first"}' }),
    response({ type: 'function_call', name: 'Read', call_id: 'b', arguments: '{"file_path":"/fixture/later"}' }),
  ];
  const parse = (records: object[]) => parseCodex({ file: '/fixture/refresh.jsonl', projectPath: '/fixture', text: records.map(record => JSON.stringify(record)).join('\n') });
  const project = (session: SessionData) => groupSessionTurns(session).flatMap(group => outlineTurn(group).nodes.flatMap(node => node.kind === 'actions' ? actionRowSections(node) : []));
  const failed = response({ type: 'function_call_output', call_id: 'a', output: { output: 'First call failed', exit_code: 1 } });
  for (const initial of [records, [...records, response({ type: 'function_call_output', call_id: 'a', output: { output: 'First public return', exit_code: 0 } })]]) {
    const before = parse(initial);
    const laterId = before.items.find(item => item.title === 'Read' && item.detail?.blocks.some(block => block.text?.includes('/fixture/later')))!.id;
    const oldSection = project(before).find(section => section.rows.some(row => row.items.some(item => item.id === laterId)))!;
    const oldRow = oldSection.rows.find(row => row.items.some(item => item.id === laterId))!;
    const after = parse([...initial, failed]);
    const nextSection = project(after).find(section => section.rows.some(row => row.items.some(item => item.id === laterId)))!;
    const nextRow = nextSection.rows.find(row => row.items.some(item => item.id === laterId))!;
    assert.equal(nextRow.id, oldRow.id);
    assert.deepEqual(resolveOutlineEvidence(after, oldRow.id)?.items?.map(item => item.id), [laterId]);
    if (initial.length > records.length) assert.equal(nextSection.id, oldSection.id, 'An independently delimited directory keeps its expansion identity');
    assert.equal(outlineCoverage(after).find(entry => entry.itemId === laterId)?.rowIds?.[0], oldRow.id);
  }
});

test('a real late result splitting repeated input sources never reinterprets the prior aggregate display ID as a subset', () => {
  const response = (payload: object) => ({ type: 'response_item', payload });
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    response({ type: 'function_call', name: 'Read', call_id: 'a', arguments: '{"file_path":"/fixture/same"}' }),
    response({ type: 'function_call', name: 'Read', call_id: 'b', arguments: '{"file_path":"/fixture/same"}' }),
  ];
  const parse = (records: object[]) => parseCodex({ file: '/fixture/members.jsonl', projectPath: '/fixture', text: records.map(record => JSON.stringify(record)).join('\n') });
  const rows = (session: SessionData) => groupSessionTurns(session).flatMap(group => outlineTurn(group).nodes.flatMap(node => node.kind === 'actions' ? actionRowSections(node).flatMap(section => section.rows) : []));
  const before = parse(records);
  const aggregate = rows(before)[0];
  assert.equal(aggregate.items.length, 2);
  assert.equal(resolveOutlineEvidence(before, aggregate.id)?.items?.length, 2);
  const after = parse([...records, response({ type: 'function_call_output', call_id: 'a', output: { output: 'Only first result', exit_code: 0 } })]);
  assert.equal(rows(after).length, 2);
  assert.ok(rows(after).every(row => row.id !== aggregate.id));
  assert.equal(resolveOutlineEvidence(after, aggregate.id), undefined, 'A vanished aggregate must be cleared, not silently narrowed');
  assert.deepEqual(rows(after).flatMap(row => row.items.map(item => item.id)), aggregate.items.map(item => item.id));
  assert.equal(aggregate.items.length, 2, 'Previously opened original source collection remains untouched');
  assert.ok(rows(after).every(row => row.id.length < 100), 'Membership identity stays bounded for the DOM and coverage ledger');
});

test('shared source-result identities ignore previous run boundaries and semantic atom identity cannot alias', () => {
  const previous = item('previous', { result: 'readable' });
  const wrapper = item('shared-source', { title: 'exec', result: 'readable', detail: { title: '编排', blocks: [{ kind: 'code', label: '记录中的调用参数', text: 'await tools.exec_command({cmd:"cat /fixture/a"}); await tools.exec_command({cmd:"cat /fixture/b"});' }] } });
  const before = sectionsFor([previous, wrapper]);
  const after = sectionsFor([{ ...previous, status: 'failed' }, wrapper]);
  const sharedBefore = before.find(section => section.rows.some(row => row.id.startsWith('action-result:')))!;
  const sharedAfter = after.find(section => section.rows.some(row => row.id.startsWith('action-result:')))!;
  assert.equal(sharedBefore.id, sharedAfter.id);
  assert.equal(sharedBefore.rows[0].id, sharedAfter.rows[0].id);
  assert.equal(resolveOutlineEvidence(asSession([{ ...previous, status: 'failed' }, wrapper]), sharedBefore.rows[0].id)?.items?.[0], wrapper);
  const directory = after.find(section => section.kind === 'folded-actions')!;
  assert.equal(directory.rows.length, 2);
  assert.equal(new Set(directory.rows.map(row => row.id)).size, 2, 'Two semantic atoms sharing one original record need distinct identities');
});

test('display-only empty turns omit ended metadata shells but keep original ordinal, all source items and coverage', () => {
  const start = item('start', { kind: 'notice', title: '回合开始', status: 'running', availability: 'none', detail: undefined });
  const context = item('context-only', { kind: 'context' });
  const marker = item('activity', { kind: 'subagent', summary: '已记录活动：interacted。', status: 'info', availability: 'none', detail: undefined });
  const end = item('end', { kind: 'notice', title: '回合结束', availability: 'none', detail: undefined });
  const actual = item('real-request', { turnId: 'turn-2', kind: 'request' });
  const source = freezeDeep(asSession([start, context, marker, end, actual]));
  const before = JSON.stringify(source);
  const displayed = visibleTurnGroups(source);
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].key, 'turn:turn-2');
  assert.equal(displayed[0].ordinal, 2);
  assert.equal(displayed[0].items[0], actual);
  assert.equal(groupSessionTurns(source).length, 2, 'Source hierarchy is untouched');
  const coverage = outlineCoverage(source);
  assert.equal(coverage.length, source.items.length);
  assert.equal(new Set(coverage.map(entry => entry.itemId)).size, source.items.length);
  assert.deepEqual(coverage.slice(0, 4).map(entry => entry.surface), Array(4).fill('empty-turn-metadata'));
  assert.equal(resolveOutlineEvidence(source, context.id)?.item, context);
  assert.equal(JSON.stringify(source), before);
});

test('empty-turn filtering never hides requests, answer-only, active, interrupted, failed or incomplete/unsupported content', () => {
  const visible = [
    item('request', { kind: 'request', summary: '' }),
    item('answer-only', { kind: 'answer' }),
    item('literal-public-message', { kind: 'message', summary: '暂未取得本轮过程。' }),
    item('active', { kind: 'notice', title: '回合开始', status: 'running', availability: 'none', detail: undefined }),
    item('interrupted', { kind: 'notice', title: '回合中断', status: 'unknown', availability: 'none', detail: undefined }),
    item('failure', { kind: 'notice', title: '回合结束', status: 'failed', availability: 'none', detail: undefined }),
    item('unsupported', { kind: 'notice', title: '待支持：未来格式', status: 'unknown', availability: 'unavailable', detail: undefined }),
    item('context-unavailable', { kind: 'context', availability: 'unavailable', detail: undefined }),
    item('context-partial', { kind: 'context', availability: 'partial' }),
    item('context-running', { kind: 'context', status: 'running' }),
    item('end-evidence', { kind: 'notice', title: '回合结束', availability: 'none' }),
  ];
  for (const original of visible) {
    assert.equal(visibleTurnGroups(asSession([original]))[0]?.items[0], original, original.id);
    assert.notEqual(outlineCoverage(asSession([original]))[0]?.surface, 'empty-turn-metadata', original.id);
  }
  const context = item('unsupported-context', { kind: 'context' });
  const unsupported = asSession([context]);
  unsupported.coverage.push({ source: context.sources[0], kind: 'future', disposition: 'unsupported', reason: '未支持', itemId: context.id });
  assert.equal(visibleTurnGroups(unsupported)[0]?.items[0], context);
  assert.equal(visibleTurnGroups(asSession([item('context-only', { kind: 'context' })])).length, 0);
  assert.deepEqual(visibleTurnGroups(asSession([])), []);
});
