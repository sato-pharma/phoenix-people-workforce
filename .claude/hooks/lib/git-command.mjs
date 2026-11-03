// Reading a git command out of a shell command's text, word by word. Used by
// `push-typecheck-guard.mjs` and `lib/secret-scan.mjs` (bash-guard C12). It lives here because a hook
// runs on import, so neither guard can import the other.

/** Push flags that take their value as the NEXT token (the `--flag=value` spelling carries it inline). */
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** Global git options that take their value as the NEXT token. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** The command split at its command positions, but never inside a quoted string. */
export function commandSegments(text) {
  const segments = [];
  let current = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if ('\n|;&('.includes(ch)) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

/** Wrappers that still run what they carry: `cmd /c`, a shell's `-c`, `VAR=value`, a leading quote. */
const LAUNCH_WRAPPERS = [
  /^cmd(?:\.exe)?\s+\/[ck]\s+/i,
  /^(?:powershell|pwsh|bash|sh)(?:\.exe)?\s+(?:-{1,2}[\w-]+\s+)*/i,
  /^(?:call|exec|nohup|env)\s+/i,
  /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/,
  /^["']/,
];

export function unwrapped(segment) {
  let text = segment.trim();
  for (let pass = 0; pass < 8; pass++) {
    const before = text;
    for (const wrapper of LAUNCH_WRAPPERS) text = text.replace(wrapper, '').trim();
    if (text === before) break;
  }
  return text;
}

/** argv for one segment, QUOTE-AWARE — every path on this machine has a space in it. */
export function argvTokens(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  const chars = [...String(text)];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '\\' && /\s/.test(chars[i + 1] ?? '')) {
      current += chars[++i]; // bash's `Phoenix\ Workforce` is one word
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/** `2>&1`, `> file`, `2> file` are not arguments of the command they trail. */
export function withoutRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d*>>?$/.test(token)) {
      i += 1; // the file the redirect writes to
      continue;
    }
    if (/^\d*>>?(?:&\d+|\S+)$/.test(token) || /^<\S*$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

/** Is this word the git program, however its path was spelled? */
export const isGitWord = (token) => /^git(?:\.exe)?$/i.test(String(token).replace(/\\/g, '/').split('/').pop());

/**
 * Tokens that start at the word `git`, read as an invocation: `{ sub, args, dir }`, or null when they
 * do not. `dir` is the `-C <dir>` target. Global options before the subcommand are skipped.
 */
export function parseGitTokens(tokens) {
  if (!tokens.length || !isGitWord(tokens[0])) return null;
  let dir = null;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (GIT_VALUE_OPTIONS.has(tokens[i])) {
      if (tokens[i] === '-C') dir = tokens[i + 1] ?? null;
      i += 2;
    } else {
      i += 1;
    }
  }
  return { sub: tokens[i] ?? '', args: tokens.slice(i + 1), dir };
}

/** One segment read as a git invocation that starts it, after any wrapper; null when it is not git. */
export function parseGit(segment) {
  return parseGitTokens(withoutRedirects(argvTokens(unwrapped(segment))));
}

/** `cd <dir>` / `Set-Location <dir>` / `pushd <dir>` — the folder a LATER segment of the command runs in. */
export function changedDirectory(segment) {
  const tokens = argvTokens(unwrapped(segment));
  if (!tokens.length || !/^(?:cd|chdir|pushd|push-location|set-location|sl)$/i.test(tokens[0])) return null;
  const target = tokens.slice(1).find((t) => !/^\/d$/i.test(t) && !/^-(?:literalpath|path)$/i.test(t));
  return target && target !== '-' ? target : null;
}

/**
 * A `git push`'s own words: flags that end the matter (dry run, delete, mirror…), the remote, and the
 * refspecs. `skip` is why the checked-out commit is not what this push sends, or null. `sendsNothing`
 * and `wide` say which kind of skip it is: nothing leaves at all, or more than one ref does.
 */
export function readPush(args) {
  let skip = null;
  let sendsNothing = false;
  let wide = null;
  let sawTags = false;
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const name = token.split('=')[0];
      if (name === '--dry-run' || name === '--help') {
        skip = 'a dry run or help request';
        sendsNothing = true;
      } else if (name === '--delete') {
        skip = 'a branch delete';
        sendsNothing = true;
      } else if (name === '--all' || name === '--mirror') {
        skip = `${name} (it pushes more than the checked-out commit)`;
        wide = name;
      } else if (name === '--tags') sawTags = true;
      if (PUSH_VALUE_FLAGS.has(name) && !token.includes('=')) i += 1;
    } else if (token.startsWith('-') && token.length > 1) {
      if (PUSH_VALUE_FLAGS.has(token)) i += 1;
      else if (/^-[A-Za-z]*n[A-Za-z]*$/.test(token)) {
        skip = 'a dry run';
        sendsNothing = true;
      } else if (/^-[A-Za-z]*d[A-Za-z]*$/.test(token)) {
        skip = 'a branch delete';
        sendsNothing = true;
      } else if (/^-[A-Za-z]*h[A-Za-z]*$/.test(token)) {
        skip = 'a help request';
        sendsNothing = true;
      }
    } else {
      positionals.push(token);
    }
  }
  const [remote = 'origin', ...refspecs] = positionals;
  if (!skip && sawTags && refspecs.length === 0) {
    skip = 'a tag push';
    wide = '--tags';
  }
  return { skip, sendsNothing, wide, remote, refspecs };
}
