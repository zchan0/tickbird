// One release, from this checkout to GitHub and back onto this machine:
//   npm run release -- 0.8.1        (or patch, minor, major: the next after the latest release)
//   1. Check: on main, nothing uncommitted, nothing on GitHub this checkout lacks, and
//      something under 未发布 in CHANGELOG.md.
//   2. Prepare: turn 未发布 into the version's section, set the version everywhere
//      (set-version), run the tests, commit "0.8.1".
//   3. Push main, retrying when GitHub drops the connection, and wait for CI on that commit.
//   4. Tag v0.8.1, push the tag, and wait for the Release workflow to publish it, its notes
//      the version's section of CHANGELOG.md.
//   5. Install the release on this machine (install:all).
// Stops at the first step that fails and says where. Run it again to go on: each step
// sees what is already done (the version set, the commit pushed, CI passed, the tag out)
// and goes past it.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChangelog, release, section, UNRELEASED, writeChangelog } from './changelog.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const asked = process.argv[2];
if (!/^(\d+\.\d+\.\d+|patch|minor|major)$/.test(asked ?? '')) { console.error('用法：npm run release -- <主版本.次版本.修订号 | patch | minor | major>'); process.exit(1); }

// Inside an agent's session its child marker would reach the tests and the install; a release is not part of a session.
const env = { ...process.env };
delete env.CLAUDE_CODE_CHILD_SESSION;
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const step = text => console.log(`· ${text}`);
const done = text => console.log(`✓ ${text}`);
function stop(text, next) {
  console.error(`✗ ${text}`);
  if (next) console.error(`  ${next}`);
  process.exit(1);
}
/** Runs a command whose output the reader should see as it goes. */
function visible(command, args, failure, next) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.status !== 0) stop(failure, next);
}
/** git push, again a few times: GitHub sometimes drops the connection halfway ("and the repository exists"). */
async function push(...refs) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync('git', ['push', 'origin', ...refs], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return;
    if (attempt === 4) stop(`推送失败：${(result.stderr || '').trim().split('\n').at(-1)}`, `网络恢复后再运行一次 npm run release -- ${version}。`);
    step(`推送没成功，${attempt * 3} 秒后重试`);
    await sleep(attempt * 3000);
  }
}
/**
 * Waits for the run of `workflow` on `sha` to finish. Polls rather than `gh run watch`,
 * which gives up on the first network error; a run takes a few seconds to appear.
 */
async function waitFor(workflow, sha, label) {
  const started = Date.now();
  let id, shown = false;
  while (Date.now() - started < 30 * 60_000) {
    try {
      if (!id) {
        const runs = JSON.parse(gh('run', 'list', '--workflow', workflow, '--commit', sha, '--limit', '1', '--json', 'databaseId,url'));
        if (runs[0]) { id = runs[0].databaseId; step(`${label}：${runs[0].url}`); }
      }
      if (id) {
        const view = JSON.parse(gh('run', 'view', String(id), '--json', 'status,conclusion,jobs'));
        if (view.status === 'completed') {
          if (view.conclusion === 'success') return;
          const failed = view.jobs.filter(job => job.conclusion && job.conclusion !== 'success' && job.conclusion !== 'skipped').map(job => job.name);
          stop(`${label}没有通过：${failed.join('、') || view.conclusion}`, `查看日志：gh run view ${id} --log-failed。修好后提交，再运行一次 npm run release -- ${version}。`);
        }
        if (!shown) { step(`等${label}跑完…`); shown = true; }
      }
    } catch { /* A network hiccup: ask again next time. */ }
    await sleep(15_000);
  }
  stop(`等了 30 分钟，${label}还没跑完`, `在 GitHub 上看看它卡在哪里，然后再运行一次 npm run release -- ${version}。`);
}

// 1. Check.
if (git('branch', '--show-current') !== 'main') stop('不在 main 分支上', '切到 main 再发版。');
if (git('status', '--porcelain')) stop('有没提交的改动', '先提交或收起它们，发版只发已经提交的内容。');
try { git('fetch', '--quiet', 'origin', 'main', '--tags'); } catch { stop('连不上 GitHub', '网络恢复后再运行一次。'); }
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') stop('GitHub 上的 main 有这里没有的提交', '先 git pull，再发版。');
// patch, minor or major: the next version after the latest release.
const latest = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0]?.slice(1) || '0.0.0';
const version = /^\d/.test(asked) ? asked : (([major, minor, patch]) => asked === 'major' ? `${major + 1}.0.0` : asked === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`)(latest.split('.').map(Number));
const tag = `v${version}`;
const released = git('tag', '--list', tag) !== '';
// The version's notes: already its own section when a run before got this far, else what is under 未发布.
const changelog = readChangelog();
const noted = section(changelog, version) !== undefined;
if (!released && !noted && !section(changelog, UNRELEASED.slice(3))) stop(`CHANGELOG.md 的「${UNRELEASED.slice(3)}」下面是空的`, `写下 ${version} 改了什么（使用者看得到的变化），提交后再运行一次 npm run release -- ${version}。`);
done(`检查：main 分支，没有未提交的改动，发布 ${version}${released ? `（${tag} 已经打过）` : ''}`);

if (!released) {
  // 2. Prepare.
  if (!noted) {
    const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    writeChangelog(release(changelog, version, date));
    done(`更新记录：「${UNRELEASED.slice(3)}」改为 ${version} · ${date}`);
  }
  const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (current !== version) {
    visible('npm', ['run', '--silent', 'set-version', '--', version], 'set-version 失败');
  }
  step('跑测试');
  const tests = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const summary = (tests.stdout || '').split('\n').filter(line => /^ℹ (pass|fail) /.test(line)).join('，');
  if (tests.status !== 0) {
    console.error((tests.stdout || '').split('\n').filter(line => /^✖ /.test(line)).slice(0, 10).join('\n'));
    stop(`测试没有通过（${summary}）`, `修好后再运行一次 npm run release -- ${version}。`);
  }
  done(`测试：${summary.replace('ℹ pass', '通过').replace('ℹ fail', '失败')}`);
  if (git('status', '--porcelain')) {
    git('add', '-A');
    git('commit', '-q', '-m', version);
    done(`提交：${version}`);
  } else done(`版本已经是 ${version}，不需要新的提交`);

  // 3. Push main and wait for CI.
  if (git('rev-list', '--count', 'origin/main..HEAD') !== '0') { await push('main'); done('推送 main'); }
  await waitFor('ci.yml', git('rev-parse', 'HEAD'), 'CI');
  done('CI 通过');

  // 4. Tag and wait for the release.
  git('tag', '-a', tag, '-m', `Tickbird ${version}`);
}
if (!git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) { await push(tag); done(`推送标签 ${tag}`); }
await waitFor('release.yml', git('rev-list', '-n', '1', tag), '发布');
let url = '';
try { url = gh('release', 'view', tag, '--json', 'url', '-q', '.url'); } catch { /* Shown below without its address. */ }
done(`发布：${url || tag}`);

// 5. This machine.
step('安装到本机');
visible('npm', ['run', '--silent', 'install:all'], '安装到本机失败', `发布已经完成；修好后运行 npm run install:all。`);
done(`Tickbird ${version} 已发布，本机也已更新`);
