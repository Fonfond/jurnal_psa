/**
 * Normalize a human-entered site name for matching: lower case, ё→е,
 * collapse all whitespace, trim. This is intentionally the same rule on the
 * client autocomplete and on the server sync matcher.
 */
export function normalizeSiteName(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}
