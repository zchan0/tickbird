/**
 * A shell command as one line that says what it does: the command that does
 * the work, without the set-up before it, the printing around it and the
 * limits piped after it. Read from the recorded text only, never run.
 */

/** A top-level piece of a command, the separator after it, and the here-document it feeds. */
export interface CommandPiece { text: string; sep: string; body?: string }

/** Splits at ; && || | and line ends outside quotes, $( ), ( ) and { }; here-document bodies are attached, not split. */
export function commandPieces(command: string): CommandPiece[] {
  const pieces: CommandPiece[] = [];
  const pending: Array<{ delimiter: string; strip: boolean; piece: number }> = [];
  let quote = '', depth = 0, start = 0;
  const push = (end: number, sep: string) => { pieces.push({ text: command.slice(start, end), sep }); };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) { if (ch === quote) quote = ''; else if (ch === '\\' && quote === '"') i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    // A comment runs to the end of its line.
    if (ch === '#' && (i === 0 || /\s/.test(command[i - 1])) && !depth) { while (i + 1 < command.length && command[i + 1] !== '\n') i++; continue; }
    if (ch === '(' || ch === '{') { depth++; continue; }
    if ((ch === ')' || ch === '}') && depth) { depth--; continue; }
    if (depth) continue;
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const match = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(command.slice(i));
      if (match) { pending.push({ delimiter: match[3], strip: match[1] === '-', piece: pieces.length }); i += match[0].length - 1; continue; }
    }
    const two = command.slice(i, i + 2);
    // A lone & sends a command to the background; in 2>&1 or &> it is part of a redirect.
    const background = ch === '&' && !'<>'.includes(command[i - 1] ?? '') && command[i + 1] !== '>';
    const sep = two === '&&' || two === '||' ? two : ch === ';' || ch === '|' || ch === '\n' ? ch : background ? '&' : '';
    if (!sep) continue;
    push(i, sep);
    i += sep.length - 1; start = i + 1;
    if (sep === '\n' && pending.length) {
      // The bodies start on the next line, one after another, each up to its delimiter line.
      for (const doc of pending.splice(0)) {
        const lines: string[] = [];
        let at = start;
        while (at <= command.length) {
          const end = command.indexOf('\n', at), stop = end < 0 ? command.length : end;
          const line = command.slice(at, stop);
          at = stop + 1;
          if ((doc.strip ? line.trim() : line) === doc.delimiter) break;
          lines.push(line);
        }
        const piece = pieces[doc.piece] ?? pieces.at(-1);
        if (piece) piece.body = lines.join('\n');
        start = Math.min(at, command.length); i = start - 1;
      }
    }
  }
  push(command.length, '');
  return pieces.filter(piece => piece.text.trim());
}

/** Moving into a directory, exporting, defining a function, setting options: set-up, not work. */
const SETUP = [/^cd(\s|$)/, /^(export|local|declare|typeset|readonly|unset|alias|trap|shopt|ulimit|umask)\s/, /^set\s+[-+]/, /^(source|\.)\s/, /^[A-Za-z_][\w-]*\s*\(\)\s*\{/, /^function\s/];
/** Commands that only print or wait between the ones that do the work. */
const FILLER = /^(echo|printf|sleep|true|false|:|pwd|wait|clear|date)(\s|$)/;
/** Loop and branch words around the commands. */
const CONTROL = /^(for|select|case)\s|^(done|fi|esac|\}|\)|;;|else|do|then)$/;
/** Commands piped after the work that only cut its output down. */
const LIMIT = /^(head|tail|cut|sort|uniq|tr|column|cat|less|more|nl|fold)(\s|$)|^grep\s+-v(\s|$)|^sed\s+-n\s+['"]?\d+(,\d+)?p['"]?$/;
const INTERPRETER = /^(python3?(\.\d+)?|node|deno|bun|ruby|perl|bash|sh|zsh|osascript|swift|php)$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|[^\s"'`])*/;

/** The command a piece runs, without the words around it; empty for set-up and control words. */
function work(piece: string): string {
  let text = piece.replace(/\\\n/g, ' ').trim();
  for (;;) {
    const before = text;
    text = text.replace(/^(do|then|else|elif|\{|\(|!)\s+/, '').replace(/^(if|while|until|time|exec|nohup)\s+/, '').trim();
    if (text === before) break;
  }
  if (!text || CONTROL.test(text) || SETUP.some(pattern => pattern.test(text)) || /^(\[\[?|test)\s/.test(text)) return '';
  // Variables set for the command: drop them. Set on their own, they are set-up, unless one runs a command to get its value.
  let rest = text, inner = '';
  for (let match = ASSIGNMENT.exec(rest); match; match = ASSIGNMENT.exec(rest)) {
    const value = /=\$\((.*)\)$|=`(.*)`$/s.exec(match[0]);
    if (value && !inner) inner = value[1] ?? value[2] ?? '';
    rest = rest.slice(match[0].length).trimStart();
  }
  if (!rest) return inner ? work(commandPieces(inner)[0]?.text ?? '') : '';
  return rest.replace(/\s+\d?>&\d\b/g, '').replace(/\s+(?:\d|&)?>\s*\/dev\/null/g, '').trim();
}

const PATH_LITERAL = /(['"])((?:~|\.{1,2}|\/)?[\w.@~+-]*(?:\/[\w.@~+-]+)*\.(?:tsx?|m?js|cjs|json|jsonl|md|py|swift|txt|html?|css|ya?ml|toml|sh|go|rs|plist|csv|log|png|jpe?g|svg|sql|xml|conf|ini|rb|kt|java|c|h|m|mm|cpp))\1/g;
const URL_LITERAL = /https?:\/\/([^/'"\s)]+)/;

/** A script that writes files, by the calls it makes: open(p, 'w'), write_text, writeFileSync. */
const WRITES = /\.write\(|\.write_(?:text|bytes)\(|\bopen\([^)]*,\s*['"][wax]|writeFileSync|appendFileSync|fs\.(?:promises\.)?(?:write|append|rm|unlink|rename)|\bjson\.dump\(|shutil\.(?:copy|move|rmtree)|os\.(?:remove|rename|replace|unlink)|\.unlink\(|File\.write|IO\.write/;

/**
 * What a script is about, from its own text: whether it changes files, and
 * the files it names (or is given); else the site it calls; else its first
 * statement: "edits turn-page.ts", "state.json", "api.github.com". A read is
 * what a script does unless it says otherwise, so only a change is marked.
 */
export function scriptHint(source: string, given: string[] = []): string {
  const names = given.map(file => file.split('/').at(-1)!);
  for (const match of source.matchAll(PATH_LITERAL)) {
    const name = match[2].split('/').at(-1)!;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length) return `${WRITES.test(source) ? 'edits ' : ''}${names.slice(0, 2).join(', ')}${names.length > 2 ? ', …' : ''}`;
  const url = URL_LITERAL.exec(source);
  if (url) return url[1];
  const statement = source.split('\n').map(line => line.trim()).find(line => line
    && !/^(#|\/\/|import\s|from\s+\S+\s+import\s|(const|let|var)\s+\{?[\w\s,{}]*\}?\s*=\s*require\(|['"]use strict['"])/.test(line));
  return statement ? clip(statement.replace(/\s+/g, ' '), 40) : '';
}

const clip = (text: string, room: number): string => text.length > room ? text.slice(0, room - 1) + '…' : text;

/** A here-document's command, said with what it carries: a script by what it works on, a commit by its subject. */
function withBody(text: string, body: string): string {
  const head = text.replace(/\s*<<-?\s*(['"]?)[\w.-]+\1/, '').trim();
  const name = head.split(/\s+/)[0]?.split('/').at(-1) ?? '';
  if (INTERPRETER.test(name)) {
    // Files handed to the script on its command line are what it works on: python3 - "$SP/page.html".
    const given = head.split(/\s+/).slice(1).map(word => word.replace(/^["']|["']$/g, '')).filter(word => !word.startsWith('-') && /\.\w{1,6}$/.test(word));
    const hint = scriptHint(body, given);
    return hint ? `${name} · ${hint}` : `${name} script`;
  }
  if (/^git\s+(-C\s+\S+\s+)?commit\b/.test(head)) {
    const subject = body.split('\n').map(line => line.trim()).find(Boolean);
    if (subject) return `git commit · ${subject}`;
  }
  return head;
}

/**
 * A plain read (cat, head, tail, nl, sed -n 1,9p): the command and the files
 * it names, with the lines it reads where it says: outline.ts:85-135.
 * Nothing for anything else.
 */
function readFiles(job: { run: CommandPiece[]; head: string }): { verb: string; files: string[] } | undefined {
  if (job.run.slice(1).some(piece => !LIMIT.test(piece.text.trim())) || job.run.some(piece => piece.body !== undefined)) return undefined;
  const words = job.head.split(/\s+/).map(word => word.replace(/^(["'])(.*)\1$/, '$2'));
  const verb = words[0];
  if (!/^(cat|head|tail|nl)$/.test(verb) && !(verb === 'sed' && words[1] === '-n')) return undefined;
  let range = '';
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (['-n', '-c', '--lines', '--bytes'].includes(word) && verb !== 'sed') { if (word === '-n' || word === '--lines') range = `:1-${words[i + 1]}`; i++; continue; }
    if (/^-\d+$/.test(word) && verb === 'head') { range = `:1-${word.slice(1)}`; continue; }
    // An option it is not known to have might do more than read (sed -i writes): then it is no plain read.
    if (word.startsWith('-')) { if (!READ_OPTIONS[verb].test(word)) return undefined; continue; }
    const lines = verb === 'sed' ? /^(\d+)(?:,(\d+))?p$/.exec(word) : null;
    if (lines) { range = lines[2] ? `:${lines[1]}-${lines[2]}` : `:${lines[1]}`; continue; }
    if (verb === 'sed' && !files.length && !/\.|\//.test(word)) return undefined;
    files.push(word);
  }
  if (verb === 'tail' || !/^:\d+(-\d+)?$/.test(range)) range = '';
  if (!files.length || files.some(file => /[$*?`(){}<>|;&]/.test(file))) return undefined;
  const names = files.map(file => file.split('/').at(-1)!);
  return { verb, files: names.length === 1 ? [names[0] + range] : names };
}

/** The options of each read command that only change how it reads. */
const READ_OPTIONS: Record<string, RegExp> = {
  cat: /^-(?:[benstuvAET]+|-show-all|-number|-number-nonblank|-squeeze-blank)$/,
  head: /^-(?:[qv]|\d+)$/, tail: /^-(?:[qvr]|\d+|\+\d+)$/, nl: /^-(?:ba|bt|bn|w\d+|s.?)$/, sed: /^-n$/,
};

/** Reads one after another, the files of each command together: cat a.md, b.md; sed outline.ts:85-135. */
function readsText(reads: Array<{ verb: string; files: string[] }>): string {
  const groups: Array<{ verb: string; files: string[] }> = [];
  for (const read of reads) {
    const last = groups.at(-1);
    if (last?.verb === read.verb) last.files.push(...read.files.filter(file => !last.files.includes(file)));
    else groups.push({ verb: read.verb, files: [...read.files] });
  }
  return groups.map(group => `${group.verb} ${group.files.join(', ')}`).join('; ');
}

/** Code given on the command line, -c or -e: by what it works on, as a script is. */
function inlineScript(part: string): string {
  const match = /^(\S+)((?:\s+-(?![ec]\s)\S+)*)\s+(-[ec]|--eval)\s+(["'])([\s\S]*)\4(.*)$/.exec(part);
  const name = match?.[1].split('/').at(-1) ?? '';
  if (match && INTERPRETER.test(name)) {
    const hint = scriptHint(match[5]);
    if (hint) return `${name} ${match[3]} · ${hint}`;
  }
  if (!part.includes('\n')) return part;
  return part.split('\n')[0].trim().replace(/\s*["'][^"']*$/, '') + ' …';
}

/** A long quoted argument (a jq program, a log predicate, a pattern of many words), cut short: what comes after it reads too. */
const shortQuotes = (text: string): string => text
  .replace(/'([^']{41,})'/g, (_, inner: string) => `'${inner.slice(0, 32).trimEnd()}…'`)
  .replace(/"((?:[^"\\]|\\.){41,})"/g, (_, inner: string) => `"${inner.slice(0, 32).trimEnd()}…"`);

interface Job { run: CommandPiece[]; head: string }

/** The pipelines a command runs, each by the command that does its work; set-up and control words left out. */
function jobsOf(command: string): Job[] {
  const runs: CommandPiece[][] = [];
  for (const piece of commandPieces(command)) {
    const last = runs.at(-1);
    if (last && last.at(-1)!.sep === '|') last.push(piece); else runs.push([piece]);
  }
  return runs.map(run => ({ run, head: work(run[0].text) })).filter(job => job.head);
}

/** A command's words as the shell splits them, quotes taken off. */
function words(text: string): string[] {
  const out: string[] = [];
  let word = '', quote = '', active = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && '$`"\\'.includes(text[i + 1] ?? '')) word += text[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; active = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { word += text[++i]; active = true; continue; }
    if (/\s/.test(ch)) { if (active) out.push(word); word = ''; active = false; continue; }
    word += ch; active = true;
  }
  if (active) out.push(word);
  return out;
}

const base = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;
/** Where a search or a listing looked, unless it is where the command runs. */
const where = (paths: string[]): string => {
  const shown = paths.filter(path => !['.', './'].includes(path)).map(base);
  return shown.length ? ` in ${shown.slice(0, 2).join(', ')}${shown.length > 2 ? ', …' : ''}` : '';
};
/** Options of rg and grep that take the next word as their value. */
const SEARCH_VALUES = new Set(['-e', '--regexp', '-f', '--file', '-g', '--glob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '--context', '-m', '--max-count', '--max-depth', '-d', '--directories', '-M', '--max-columns', '--iglob', '-j', '--threads']);

/** A text search (rg, grep, git grep): what it looked for, and where. */
function searchOf(job: Job): string | undefined {
  const all = words(job.head);
  const name = base(all[0] ?? '');
  const list = name === 'git' && all[1] === 'grep' ? all.slice(2) : ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack'].includes(name) ? all.slice(1) : undefined;
  if (!list || list.includes('--files')) return undefined;
  const patterns: string[] = [], paths: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const word = list[i];
    if (word === '-e' || word === '--regexp') { patterns.push(list[++i] ?? ''); continue; }
    if (SEARCH_VALUES.has(word)) { i++; continue; }
    if (word.startsWith('-') && word !== '-') continue;
    if (!patterns.length && !list.some(other => other === '-e' || other === '--regexp')) patterns.push(word); else paths.push(word);
  }
  if (!patterns.length) return undefined;
  // As it reads, not as the regex escapes it: 128 \* 1024 is 128 * 1024.
  const query = patterns.join('|').replace(/\\([|.*+?()[\]{}^$\\])/g, '$1');
  return (query.length > 36 ? query.slice(0, 35) + '…' : query) + where(paths);
}

/** A listing (ls, find, fd, tree, rg --files): what it looked for, and where. */
function listOf(job: Job): string | undefined {
  const all = words(job.head);
  const name = base(all[0] ?? ''), rest = all.slice(1);
  const plain = (skip: Set<string>) => rest.filter((word, index) => !word.startsWith('-') && !skip.has(rest[index - 1] ?? ''));
  if (name === 'ls' || name === 'tree') return plain(new Set(['-L', '-I'])).map(base).join(', ') || '.';
  if (name === 'rg' && rest.includes('--files')) {
    const globs = rest.flatMap((word, index) => ['-g', '--glob', '--iglob'].includes(word) && rest[index + 1] && !rest[index + 1].startsWith('!') ? [rest[index + 1]] : []);
    const paths = plain(new Set(['-g', '--glob', '--iglob', '-t', '--type', '-T', '--max-depth']));
    return globs.length ? `${globs.slice(0, 2).join(', ')}${globs.length > 2 ? ', …' : ''}${where(paths)}` : paths.map(base).join(', ') || '.';
  }
  if (name === 'find') {
    const start = rest.findIndex(word => word.startsWith('-') || word === '(' || word === '!');
    const paths = (start < 0 ? rest : rest.slice(0, start));
    const names = rest.flatMap((word, index) => ['-name', '-iname', '-path'].includes(word) && rest[index + 1] ? [rest[index + 1]] : []);
    if (rest.some(word => ['-exec', '-execdir', '-delete', '-ok'].includes(word))) return undefined;
    return names.length ? `${names.join(', ')}${where(paths)}` : paths.map(base).join(', ') || '.';
  }
  if (name === 'fd') {
    const [pattern, ...paths] = plain(new Set(['-e', '--extension', '-t', '--type', '-d', '--max-depth', '-E', '--exclude']));
    return pattern ? `${pattern}${where(paths)}` : '.';
  }
  return undefined;
}

export interface Explored { tool: 'Read' | 'Search' | 'List'; text: string; more: number }

/**
 * A command that only looks (reads files, searches them, lists them), as the
 * tool it stands for: Read, Search or List, as Codex itself names these. The
 * first of its looks (the files of the reads right after it with it); how
 * many more it makes. Nothing when it does anything else, so a command that also
 * changes or runs something is never hidden under Read.
 */
export function exploreText(command: string, project = '', home = process.env.HOME ?? ''): Explored | undefined {
  const jobs = jobsOf(command).filter(job => !FILLER.test(job.head));
  if (!jobs.length) return undefined;
  const looks: Array<{ tool: Explored['tool']; read?: { verb: string; files: string[] }; text?: string }> = [];
  for (const job of jobs) {
    if (job.run.some(piece => piece.body !== undefined) || /\$\(|`/.test(job.run.map(piece => piece.text).join(' '))) return undefined;
    if (job.run.slice(1).some(piece => !LIMIT.test(piece.text.trim()))) return undefined;
    const read = readFiles(job);
    if (read) { looks.push({ tool: 'Read', read }); continue; }
    const search = searchOf(job);
    if (search) { looks.push({ tool: 'Search', text: search }); continue; }
    const list = listOf(job);
    if (list) { looks.push({ tool: 'List', text: list }); continue; }
    return undefined;
  }
  const tool = looks[0].tool;
  if (tool !== 'Read') return { tool, text: shorten(looks[0].text!, project, home), more: looks.length - 1 };
  // Files read one after another are short: they read together. A search or a listing is one at a time, the rest counted.
  let same = 0;
  while (same < looks.length && looks[same].tool === 'Read') same++;
  const files = [...new Set(looks.slice(0, same).flatMap(look => look.read!.files))];
  return { tool, text: shorten(files.join(', '), project, home), more: looks.length - same };
}

/**
 * A command as it reads best: the first command that does the work, with the
 * commands piped after it that only cut its output down left off, and the
 * project's and the home directory's paths shortened; and how many more
 * commands it runs after.
 */
export function commandText(command: string, project = '', home = process.env.HOME ?? ''): { text: string; more: number } {
  const jobs = jobsOf(command);
  const chosen = jobs.findIndex(job => !FILLER.test(job.head));
  const at = chosen < 0 ? 0 : chosen;
  const job = jobs[at];
  if (!job) return { text: shorten(command.split('\n').find(line => line.trim())?.trim() ?? '', project, home), more: 0 };
  // Files read first, one after another: they are what the command is about.
  const doing = jobs.slice(at).filter(next => !FILLER.test(next.head));
  const reads: Array<{ verb: string; files: string[] }> = [];
  for (const next of doing) { const read = readFiles(next); if (!read) break; reads.push(read); }
  if (reads.length) return { text: shorten(readsText(reads), project, home), more: doing.length - reads.length };
  const parts = [job.head, ...job.run.slice(1).map(piece => piece.text.trim())];
  while (parts.length > 1 && LIMIT.test(parts.at(-1)!)) parts.pop();
  const body = job.run.find(piece => piece.body !== undefined)?.body;
  const text = body !== undefined ? withBody(parts.join(' | '), body) : parts.map(part => shortQuotes(inlineScript(part))).join(' | ');
  const more = jobs.slice(at + 1).filter(next => !FILLER.test(next.head)).length;
  return { text: shorten(text, project, home).replace(/\s+/g, ' '), more };
}

/**
 * Paths as short as they still say which file: inside the project from its
 * root, the home directory as ~, a deep path by its last part (…/x.jsonl), a
 * command by its name (/usr/bin/log → log). Quoted text and web addresses stay.
 */
function shorten(text: string, project: string, home: string): string {
  if (project) text = text.split(project.replace(/\/$/, '') + '/').join('');
  if (home) text = text.split(home + '/').join('~/');
  return text
    .replace(/^(?:~|\/)[^\s'"]*\/([\w.+-]+)(?=\s|$)/, '$1')
    .replace(/(^|\s)(?:~|\.{1,2})?(?:\/?[\w.@+-]+){1}(?:\/[\w.@+-]+){2,}\/([\w.@+-]+)(?=\s|$|[;|)])/g, '$1…/$2');
}
