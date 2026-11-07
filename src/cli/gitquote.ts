/**
 * `git diff --name-only` (without -z) wraps names that contain non-ASCII or special characters in double quotes and
 * writes them as C escapes ("caf\303\251.ts"). Left as-is, `git diff --name-only | ceasefire check --stdin` would look
 * for a file that does not exist and report "clear". This turns such a name back into the real one.
 */
const SIMPLE: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };

export function unquoteGitPath(line: string): string {
  if (line.length < 2 || !line.startsWith('"') || !line.endsWith('"')) return line;
  const body = line.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      const m = /^[0-7]{1,3}/.exec(body.slice(i + 1)) as RegExpExecArray;
      bytes.push(parseInt(m[0], 8) & 0xff);
      i += m[0].length;
    } else if (next !== undefined && next in SIMPLE) {
      bytes.push(SIMPLE[next] as number);
      i += 1;
    } else {
      return line; // not git's quoting: leave it alone
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
