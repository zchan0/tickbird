import type { SessionData, TimelineItem } from '../../packages/core/src/model';
export interface PresentationCase { id: string; title: string; session: SessionData; detailId: string }
const call = (title: string, input: unknown, output?: string): TimelineItem => ({
  id: 'tool', sessionId: 'presentation-fixture', turnId: 'turn', kind: 'tool', title, summary: '', timestamp: '2026-09-08T02:14:00Z', status: output === undefined ? 'unknown' : 'completed', result: output === undefined ? 'not-observed' : output ? 'readable' : 'empty', availability: 'available',
  sources: [{ file: '/synthetic/session.jsonl', line: 2 }], detail: { title, blocks: [
    { kind: 'code', label: '记录中的调用参数', text: typeof input === 'string' ? input : JSON.stringify(input) },
    ...(output === undefined ? [] : [{ kind: 'text' as const, label: '当时返回的内容', text: output }]),
  ] },
});
const envelope = (output: string) => JSON.stringify({ chunk_id: 'sample', wall_time_seconds: 0.1, exit_code: 0, output });
const patch = '*** Begin Patch\n*** Update File: packages/core/src/model.ts\n@@\n-export type View = "raw";\n+export type View = "input" | "output";\n*** Add File: tests/view.test.ts\n+assert.equal(view.kind, "output");\n*** End Patch';
const cases: Array<[string, string, TimelineItem[]]> = [
  ['bash', '01 · Bash：命令、参数与输出', [call('exec_command', { cmd: 'npm test', workdir: '/workspace/agent-sidecar' }, 'PASS render.test.ts\nPASS live-view.test.ts\n12 tests passed')]],
  ['bash-read', '02 · Read：识别纯读取，详情保留命令', [call('exec_command', { cmd: "sed -n '1,80p' packages/core/src/model.ts" }, 'export interface SessionData {\n  id: string;\n}')]],
  ['wrapper', '03 · 两个 Bash 与一个调用级 Output', [call('exec', 'text(await tools.exec_command({cmd:"npm run check"}));\ntext(await tools.exec_command({cmd:"npm test"}));', 'Script completed\nWall time 0.1 seconds\nOutput:\n' + envelope('Type check passed') + envelope('12 tests passed'))]],
  ['bash-sequence', '03b · 独立 Bash 逐项顺排，IN / OUT 各限三行', [call('Bash', { command: "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('README.md').read_text())\nprint('done')\nPY", description: '检查说明文档' }, '# Agent Sidecar\n\nRead-only process observer.\nSupports Codex and Claude Code.\nMore output after the third line.'), { ...call('Bash', { command: 'npm test', description: '验证修改' }, 'PASS render.test.ts\nPASS live-view.test.ts\nPASS presentation.test.ts\n20 tests passed\n0 failed'), id: 'test' }]],
  ['patch', '04 · apply_patch：完整路径与逐文件 diff', [call('apply_patch', patch, 'Success. Updated the following files:\nM packages/core/src/model.ts\nA tests/view.test.ts')]],
  ['nested-patch', '05 · exec 包装里的 apply_patch', [call('exec', `text(await tools.apply_patch(${JSON.stringify(patch)}));`, 'Script completed\nWall time 0.1 seconds\nOutput:\nSuccess.')]],
  ['edit', '06 · Edit：替换片段与附加参数', [call('Edit', { file_path: 'packages/core/src/model.ts', old_string: 'const mode = "raw";', new_string: 'const mode = "output";', replace_all: false }, 'Updated')]],
  ['tools', '07 · Read / Grep / WebSearch 是不同工具', [call('Read', { file_path: 'README.md', offset: 1, limit: 60 }, '# Agent Sidecar\nA read-only observer.'), { ...call('Grep', { pattern: 'renderDetail', path: 'packages' }, 'packages/vscode/src/render.ts:820'), id: 'grep' }, { ...call('WebSearch', { query: 'VS Code webview syntax highlighting' }, 'VS Code Extension API'), id: 'web' }]],
  ['no-output', '08 · 只有 Input：没有空 Output 框', [call('Bash', { command: 'npm test' })]],
  ['markdown', '09 · 公开正文与围栏代码', [{ ...call('过程说明', ''), kind: 'message', status: 'info', result: undefined, detail: { title: '过程说明', blocks: [{ kind: 'text', label: '用户请求或公开正文', text: '**先核对数据归属**，然后调整展示。\n\n- 工具是动作\n- 结果放入 Output\n\n```ts\nconst view = { kind: "output", text: result };\n```' }] } }]],
  ['compaction', '10 · 压缩占位只有一句', [{ ...call('上下文已压缩', ''), kind: 'notice', availability: 'none', status: 'info', result: undefined, detail: undefined }]],
  ['compaction-summary', '10b · 有明确可读摘要才提供详情（合成记录）', [{ ...call('上下文已压缩', ''), kind: 'notice', noticeType: 'context-compacted', status: 'info', result: undefined, detail: { title: '压缩摘要', blocks: [{ kind: 'text', label: '压缩摘要', text: '## 已完成\n\n- Bash 按调用顺序显示。\n- 输入和输出分别限高。\n\n## 待确认\n\n审阅窄栏样张。' }] } }]],
  ['file-event', '11 · 独立文件变更事件是结果，不是 FILE 工具', [{ ...call('记录中的文件修改', ''), kind: 'file-change', status: 'completed', result: 'readable', detail: { title: '文件变更', blocks: [{ kind: 'patch', label: 'packages/core/src/model.ts', text: '--- a/packages/core/src/model.ts\n+++ b/packages/core/src/model.ts\n@@ -1 +1 @@\n-const mode = "raw";\n+const mode = "output";' }] } }]],
  ['opaque', '12 · exec [cmd: command]：显示记录中的命令表达式', [call('exec', 'if (needsCheck) await tools.exec_command({cmd: command});', 'Recorded output')]],
  ['semantic-tools', '13 · Skill / Memory / Instructions / Web / Goal / Computer', [
    call('exec_command', { cmd: 'cat /fixture/.codex/skills/.system/openai-docs/SKILL.md' }, '# OpenAI Docs\nRecorded skill definition.'),
    { ...call('exec_command', { cmd: "sed -n '1,20p' /fixture/.codex/memories/MEMORY.md" }, '# Project memory\nRead-only observer.'), id: 'memory' },
    { ...call('exec_command', { cmd: 'cat /fixture/AGENTS.md' }, '# Working agreement\nPreserve unrelated changes.'), id: 'instructions' },
    { ...call('web__run', { search_query: [{ q: 'VS Code webview' }] }, 'VS Code Extension API'), id: 'web-search' },
    { ...call('web__run', { open: [{ ref_id: 'https://code.visualstudio.com/api' }] }, 'Extension API'), id: 'web-open' },
    { ...call('get_goal', {}, '{"objective":"核对工具展示","status":"active"}'), id: 'goal' },
    { ...call('mcp__cua_repl/js', { title: '检查窄栏样例', code: 'await tab.getState();' }, '{"title":"Sidecar 展示样例"}'), id: 'computer' },
    { ...call('mcp__example__lookup_document', { query: 'Workspace guide', limit: 3 }, '{"matches":[]}'), id: 'mcp' },
  ]],
  ['turn-preview', '14 · 目录：只显示对应 turn，问题最多三行', [
    { ...call('过程说明', ''), kind: 'message', status: 'info', result: undefined, detail: { title: '过程说明', blocks: [{ kind: 'text', label: '公开正文', text: '第一轮公开过程。' }] } },
    { ...call('用户请求', ''), id: 'request-2', turnId: 'turn-2', kind: 'request', summary: '优化工具展示。', detail: { title: '用户请求', blocks: [{ kind: 'text', label: '用户请求', text: '优化工具展示。\n读取 Skill、Memory 和 AGENTS.md 时应该能一眼看懂用途。\n网页搜索列出查询内容。\n普通 Bash 继续保留命令与输出。\n超过三行的部分在目录里隐藏。' }] } },
    { ...call('exec_command', { cmd: 'npm test' }, 'Passed'), id: 'turn-2-tool', turnId: 'turn-2' },
  ]],
];
export const presentationCases: PresentationCase[] = cases.map(([id, title, items]) => ({ id, title, detailId: items[0].id,
  session: { id: 'presentation-fixture', provider: 'codex', projectPath: '/synthetic', title, warnings: [], coverage: [], items: [
    { id: 'request', sessionId: 'presentation-fixture', turnId: 'turn', kind: 'request', title: '请求', summary: '核对本次修改及验证结果。', status: 'info', availability: 'none', sources: [{ file: '/synthetic/session.jsonl', line: 1 }] }, ...items,
  ] },
}));

const requestMarkdown = '**核对这次修改**\n\n- 命令仍叫 `Bash`\n- 结果放在 OUT\n\n```ts\nconst view = "readonly";\n```\n\n完整问题保留在详情中，窄栏只限制显示高度。';
presentationCases.push({ id: 'request-markdown', title: '09b · 问题块：Markdown 与正文共用阅读器', detailId: 'request', session: {
  id: 'presentation-fixture', provider: 'claude', projectPath: '/synthetic', title: '问题与过程正文', warnings: [], coverage: [], items: [
    { ...call('用户请求', ''), id: 'request', kind: 'request', summary: '核对这次修改…', status: 'info', result: undefined,
      detail: { title: '用户请求', blocks: [{ kind: 'text', label: '用户请求或公开正文', text: requestMarkdown }] } },
    { ...call('过程说明', ''), id: 'message', kind: 'message', summary: '先看输入与输出的对应关系。', status: 'info', result: undefined,
      detail: { title: '过程说明', blocks: [{ kind: 'text', label: '用户请求或公开正文', text: '先看**输入与输出的对应关系**，再核对 `diff`。' }] } },
  ],
} });
