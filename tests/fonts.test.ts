import test from 'node:test';
import assert from 'node:assert/strict';
import { fontDeclarations, fontVariables } from '../packages/vscode/src/fonts';
import { renderSidecar, setFonts } from '../packages/vscode/src/render';

test('the fonts follow chat.* as the agents\' panels do; a default or a bad value leaves VS Code\'s own', () => {
  assert.deepEqual(fontVariables({ size: 16, family: "Maple Mono NF CN Medium, Menlo, 'Courier New', monospace", codeSize: 15, codeFamily: 'default', codeWeight: '500' }), {
    '--tb-font-size': '16px', '--tb-font-family': "Maple Mono NF CN Medium, Menlo, 'Courier New', monospace", '--tb-code-font-size': '15px', '--tb-code-font-weight': '500',
  });
  assert.deepEqual(fontVariables({ size: 13, family: 'default' }), { '--tb-font-size': '13px' });
  assert.deepEqual(fontVariables({ size: 900, family: 'x; } body { display: none', codeWeight: 'heavy' }), { '--tb-font-family': 'x  body  display: none' });
  assert.equal(fontDeclarations({ '--tb-font-size': '16px' }), '--tb-font-size: 16px;');
});

test('a page is drawn in the fonts set last', () => {
  setFonts({ '--tb-font-size': '16px' });
  try {
    const html = renderSidecar({ projectName: 'p', nonce: 'n', session: { id: 's', provider: 'claude', projectPath: '/p', title: 't', warnings: [], coverage: [], items: [] } });
    assert.match(html, /:root \{ --tb-font-size: 16px; \}/);
  } finally { setFonts({}); }
});
