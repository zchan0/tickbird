import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCodexSessionTitle, explicitSessionTitle } from '../packages/core/src/session-title';
import { loadSession } from '../packages/core/src/sessions';
import type { SessionData } from '../packages/core/src/model';
import { tempDir } from './temp';

const session = (): SessionData => ({id:'fixture-codex',provider:'codex',projectPath:'/fixture',title:'First request fallback',titleSource:'request',items:[],coverage:[],warnings:[]});
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
async function fixture(t: {after: (fn: () => Promise<void>) => void}) {
  const directory = tempDir('session-title');
  t.after(() => rm(directory, {recursive:true,force:true}));
  return {directory,index:join(directory,'session_index.jsonl')};
}
test('Codex names come only from exact matching index IDs and do not mutate source data', async t => {
  const {index} = await fixture(t);
  const input = jsonl([{id:'foreign',thread_name:'Unrelated title'}, {id:'fixture-codex',thread_name:'Reviewed session name',updated_at:'2026-09-06'}]);
  await writeFile(index,input);
  const source = Object.freeze(session());
  const before = JSON.stringify(source);
  const result = await applyCodexSessionTitle(source,index);
  assert.equal(result.title,'Reviewed session name');
  assert.equal(result.titleSource,'codex-index');
  assert.equal(result.id,source.id); assert.equal(result.projectPath,source.projectPath); assert.equal(result.provider,source.provider);
  assert.equal(result.items,source.items); assert.equal(result.coverage,source.coverage); assert.equal(result.warnings,source.warnings);
  assert.equal(JSON.stringify(source),before);
  assert.equal(await readFile(index,'utf8'),input);
});
test('last valid matching index row wins; invalid schemas, titles and foreign IDs do not rename', async t => {
  const {index} = await fixture(t);
  await writeFile(index,jsonl([
    {id:'fixture-codex',thread_name:'First'}, {id:'fixture-codex',thread_name:'  Latest  ',updated_at:'earlier timestamp'},
    {id:'fixture-codex',thread_name:''}, {id:'fixture-codex',thread_name:{title:'Nested'}},
    {id:'fixture-codex',thread_name:'x'.repeat(513)}, {id:'fixture-codex',thread_name:'Bad\u0000title'},
    {id:'foreign',thread_name:'Foreign'}, {sessionId:'fixture-codex',thread_name:'Wrong identity key'},
    {id:'fixture-codex',title:'Wrong title key'}, ['fixture-codex','Array title'], null,
  ]));
  const result = await applyCodexSessionTitle(session(),index);
  assert.equal(result.title,'Latest');
  assert.equal(result.titleSource,'codex-index');
  await writeFile(index,jsonl([{id:'foreign',thread_name:'Foreign'}]));
  const source = session(); assert.equal(await applyCodexSessionTitle(source,index),source);
});
test('missing, malformed, nonregular, symlinked and oversized index falls back without error', async t => {
  const {directory,index} = await fixture(t);
  const source = session();
  assert.equal(await applyCodexSessionTitle(source,index),source);
  await writeFile(index,jsonl([{id:source.id,thread_name:'Partial title'}]) + '{unfinished');
  assert.equal(await applyCodexSessionTitle(source,index),source);
  const folder = join(directory,'directory-index'); await mkdir(folder);
  assert.equal(await applyCodexSessionTitle(source,folder),source);
  const link = join(directory,'linked-index'); await symlink(index,link);
  assert.equal(await applyCodexSessionTitle(source,link),source);
  await truncate(index,4 * 1024 * 1024 + 1);
  assert.equal(await applyCodexSessionTitle(source,index),source);
});
test('Claude sessions and empty identities never adopt a Codex index title', async t => {
  const {index} = await fixture(t);
  await writeFile(index,jsonl([{id:'fixture-codex',thread_name:'Codex name'}, {id:'',thread_name:'Empty identity title'}]));
  const claude = {...session(),provider:'claude' as const};
  assert.equal(await applyCodexSessionTitle(claude,index),claude);
  const empty = {...session(),id:''}; assert.equal(await applyCodexSessionTitle(empty,index),empty);
});
test('explicit title text is bounded plain display data, not a coercible object', () => {
  assert.equal(explicitSessionTitle('  A name  '),'A name');
  assert.equal(explicitSessionTitle('a'.repeat(512))?.length,512);
  for(const value of ['', '  ', 'a'.repeat(513), 'a\nb', null, [], {toString:()=>{throw new Error('Must not invoke')}}]) assert.equal(explicitSessionTitle(value),undefined);
});
test('validated custom fixture log loading retains request fallback without consulting the real account index', async t => {
  const {directory} = await fixture(t);
  const file = join(directory,'fixture.jsonl');
  const id = '01a00000-0000-7000-8000-0000000000c2';
  await writeFile(file,jsonl([
    {type:'session_meta',payload:{id,cwd:directory,source:'cli'}},
    {type:'event_msg',payload:{type:'user_message',message:'Test-owned request fallback'}},
  ]));
  const result = await loadSession({id,provider:'codex',file,projectPath:directory,updatedAt:0,activity:'unverified'});
  assert.equal(result.id,id); assert.equal(result.title,'Test-owned request fallback');
  assert.notEqual(result.titleSource,'codex-index');
});
