import { t } from './i18n';
/**
 * How a recorded call ended, from fields the harness actually wrote. Nothing is
 * executed and no exit code is guessed; absent evidence stays absent.
 */
export type OutcomeKind = 'ok' | 'empty' | 'failed' | 'denied' | 'interrupted';
export interface CallOutcome {
  kind: OutcomeKind;
  /** Only when the source recorded one. */
  exitCode?: number;
  /** Claude `toolDenialKind`, e.g. `user-rejected`. */
  denial?: string;
}

// A search that finds nothing exits 1. That is an empty result, not a failure.
// `find` exits 0 when it matches nothing, so its exit 1 is a real error: only
// tools that use exit 1 to mean "no match" belong here.
const SEARCH = /^(rg|grep|egrep|fgrep|ag|ack)$/;

/** Exit code → outcome. Only a single-stage search command reads exit 1 as empty. */
export function commandOutcome(command: string, exitCode: number | undefined): OutcomeKind | undefined {
  if (exitCode === undefined) return undefined;
  if (exitCode === 0) return 'ok';
  if (exitCode !== 1) return 'failed';
  // Blank out quoted text first: a pipe inside an `rg` pattern is not a stage.
  const masked = command.replace(/'[^']*'|"[^"]*"/g, match => ' '.repeat(match.length));
  const stages = masked.split(/\s*(?:&&|\|\||[;|\n])\s*/).filter(stage => stage.trim());
  // A chained command's exit 1 can come from any stage (`false && rg …`).
  if (stages.length !== 1) return 'failed';
  const head = stages[0].trim().split(/\s+/)[0] ?? '';
  return SEARCH.test(head.split('/').pop() ?? '') ? 'empty' : 'failed';
}

const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM' };

/**
 * There is no single standard for exit codes. POSIX and the shells fix only a
 * few values; 1–125 are whatever the program decided. Decode the conventional
 * ones and say so plainly for the rest — the returned text is the reason.
 */
export function exitReason(code: number | undefined): string {
  if (code === undefined || code === 0) return '';
  if (code === 127) return t('command not found', '命令未找到');
  if (code === 126) return t('found but not executable', '找到了但不可执行');
  if (code === 128) return t('128 means different things in different tools (git uses it for a fatal error); see the output', '128 在不同工具里含义不同（git 用它表示 fatal 错误），看返回内容');
  if (code > 128 && code < 160) {
    const signal = code - 128;
    const name = `${signal}${SIGNALS[signal] ? ' ' + SIGNALS[signal] : ''}`;
    return t(`killed by signal ${name}`, `被信号 ${name} 终止`);
  }
  if (code === 2) return t('most commands use 2 for a usage or argument error', '多数命令用 2 表示用法或参数错误');
  if (code >= 1 && code <= 125) return t('a failure code of the command\'s own; see the output', '该命令自定的失败码，具体含义看返回内容');
  return t('an unusual exit code', '非常规退出码');
}

/** Claude writes a failed Bash result as `Error: Exit code N\n<output>` (the
 *  tool_result content carries the same line without `Error: `). */
export function claudeExitPrefix(text: string): { exitCode: number; body: string } | undefined {
  const match = /^(?:Error: )?Exit code (\d+)\n?/.exec(text);
  return match ? { exitCode: Number(match[1]), body: text.slice(match[0].length) } : undefined;
}
