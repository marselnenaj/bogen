/**
 * Masks secrets in what `bogen report` writes: tokens, keys, cookies and Tailscale logins. Bogen keeps its secrets
 * in owner-only files and never logs them, so this is the second line, for a token in an error message, a header in
 * a log line or a key in an environment. It masks known shapes and cannot recognise every secret, which is why the
 * report says to read it before sharing it.
 */

export const MASK = '[redacted]';
export const LOGIN_MASK = '[login]';

/** Object keys whose value is a secret itself, whatever it looks like. */
const SECRET_KEY = /(^|[_-])?(token|tokens|tokenhash|hash|secret|password|passwd|passphrase|api[_-]?key|private[_-]?key|cookie|set-cookie|authorization|code)$/i;
/** Object keys whose value is a Tailscale login, or a list of them. */
const LOGIN_KEY = /(^|[_-])?(login|logins|ownerlogin|loginname|user[_-]?login)$/i;

const PATTERNS: [RegExp, string][] = [
  // PEM private keys, whole.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  // Headers: authorization, cookies, the login tailscale serve passes on.
  [/\b((?:proxy-)?authorization\s*[:=]\s*"?)[^\r\n"]+/gi, `$1${MASK}`],
  [/\b((?:set-)?cookie\s*[:=]\s*"?)[^\r\n"]+/gi, `$1${MASK}`],
  [/\b(tailscale-user-(?:login|name)\s*[:=]\s*"?)[^\r\n",]+/gi, `$1${LOGIN_MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  // Credentials in a URL, and secrets in its query (`/?token=` opens the editor with the server token).
  [/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${MASK}@`],
  [/([?&#](?:token|key|secret|code|access_token|auth)=)[^&\s"'#]+/gi, `$1${MASK}`],
  // Command lines: `--token <t>`, `--token=<t>`.
  [/(--(?:token|key|secret|password)[= ])(?!\[redacted)\S+/gi, `$1${MASK}`],
  // A secret field in JSON, an environment, a config or a form: BOGEN_TOKEN=..., "figmaToken": "...".
  [/(\b[A-Za-z0-9_-]*?(?:token|secret|password|passwd|passphrase|api[_-]?key|private[_-]?key)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\s,;&"'}\]]+)/gi, `$1"${MASK}"`],
  // Token formats with a recognisable prefix.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bfigd_[A-Za-z0-9_-]{10,}/g, MASK],
  [/\btskey-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  // Tailscale logins: an e-mail address, or name@github and the like.
  [/\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, LOGIN_MASK],
  [/\b[A-Za-z0-9._%+-]+@(?:github|passkey|gitlab|apple|google)\b(?!\.)/g, LOGIN_MASK],
  // The tailnet's own name in a MagicDNS name: omarchy.tail1234.ts.net keeps the machine, not the tailnet.
  [/\b([a-z0-9-]+)\.[a-z0-9-]+\.ts\.net\b/gi, '$1.[tailnet].ts.net'],
];

/** `text` with every recognised secret masked, and the home folder shown as `~`. */
export function redactText(text: string, home?: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  if (home && home.length > 1) out = out.split(home).join('~');
  return out;
}

/** A copy of a JSON value with secret keys emptied, logins masked and every string passed through `redactText`. */
export function redactValue(value: unknown, home?: string): unknown {
  if (typeof value === 'string') return redactText(value, home);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, home));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const empty = item === null || item === undefined || item === '' || typeof item === 'boolean' || typeof item === 'number';
      if (SECRET_KEY.test(key) && !empty) out[key] = MASK;
      else if (LOGIN_KEY.test(key) && !empty) out[key] = Array.isArray(item) ? item.map(() => LOGIN_MASK) : LOGIN_MASK;
      else out[key] = redactValue(item, home);
    }
    return out;
  }
  return value;
}
