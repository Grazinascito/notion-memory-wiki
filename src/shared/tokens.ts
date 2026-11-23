export const TOKEN_CHARS_DIVISOR = 2.8;

export const TOKEN_CAPS = {
  CLI_SURFACE: 280,
  MCP_SURFACE_V11: 550,
  CATALOG_WARN: 380,
  CATALOG_HARD: 420,
  CATALOG_OVERFLOW_DB_COUNT: 30,
  GUIDE_HARD: 400,
  LEVEL0_TOTAL_HARD: 1500,
} as const;

/**
 * Portuguese-calibrated conservative upper-bound token estimator.
 * Accented Portuguese and Markdown/TOON punctuation produce more tokens per
 * character than plain English, so chars / 2.8 bounds actual model counts safely.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / TOKEN_CHARS_DIVISOR);
}
