/**
 * Deterministic keyword matching. No LLM is involved: exact and whole-word phrase
 * matching over normalised text, never loose substring matching ("ok" must not
 * match "book").
 */

export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation and emoji become spaces
    .replace(/\s+/g, ' ')
    .trim();
}

export type MatchType = 'exact' | 'phrase';

export interface KeywordRule {
  id: string;
  name: string;
  matchType: MatchType;
  patterns: string[];
  priority: number;
  enabled: boolean;
  channelId: string | null;
  replyText: string | null;
  setLabel: string | null;
  handover: boolean;
  cooldownSeconds: number;
}

/** Returns the pattern that matched, or null. */
export function matchPattern(text: string, matchType: MatchType, patterns: string[]): string | null {
  const t = normalize(text);
  if (!t) return null;
  const padded = ` ${t} `;
  for (const p of patterns) {
    const n = normalize(p);
    if (!n) continue;
    if (matchType === 'exact' ? t === n : padded.includes(` ${n} `)) return p;
  }
  return null;
}

export interface RuleMatch {
  rule: KeywordRule;
  pattern: string;
}

/**
 * Picks at most one rule: the lowest priority number that matches, is enabled,
 * applies to the channel and is not cooling down for this conversation.
 */
export function pickRule(
  text: string,
  rules: KeywordRule[],
  opts: { channelId: string; lastHitAt?: (ruleId: string) => Date | undefined; now?: Date } = { channelId: '' },
): RuleMatch | null {
  const now = opts.now ?? new Date();
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  for (const rule of sorted) {
    if (!rule.enabled) continue;
    if (rule.channelId && rule.channelId !== opts.channelId) continue;
    const pattern = matchPattern(text, rule.matchType, rule.patterns);
    if (!pattern) continue;
    const last = opts.lastHitAt?.(rule.id);
    if (rule.cooldownSeconds > 0 && last && now.getTime() - last.getTime() < rule.cooldownSeconds * 1000) continue;
    return { rule, pattern };
  }
  return null;
}
