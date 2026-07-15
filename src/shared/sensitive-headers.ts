export const REDACTED_HEADER_VALUE = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
]);

const SENSITIVE_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "session",
  "key",
];

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    (SENSITIVE_HEADER_NAMES.has(normalized) ||
      SENSITIVE_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment)))
  );
}

export function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) =>
      isSensitiveHeaderName(key) ? [key, REDACTED_HEADER_VALUE] : [key, value],
    ),
  );
}
