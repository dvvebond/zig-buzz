const PREFIX_SECRET_PATTERN =
  /\b(?:brap1_|nsec1|sprt_tok_|sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{8,}\b/g;
const ASSIGNMENT_SECRET_PATTERN =
  /\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*)([^\s,;]+)/gi;

export function redactSensitiveText(
  value: string,
  explicitSecrets: readonly string[] = [],
): string {
  let redacted = value;
  const unique = [...new Set(explicitSecrets)]
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of unique) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted
    .replace(PREFIX_SECRET_PATTERN, "[REDACTED]")
    .replace(
      ASSIGNMENT_SECRET_PATTERN,
      (_match, name: string, separator: string) =>
        `${name}${separator}[REDACTED]`,
    );
}
