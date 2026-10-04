// Pattern rules for the leak scan (Argus F5). These run with NO keys loaded, so they also catch
// old/rotated keys, bad pastes and other credentials that the exact-value comparison cannot see.
// Findings report rule + location + match length only; the matched text is never printed.

export interface PatternRule { id: string; re: RegExp; describe: string; check?: (m: RegExpExecArray) => boolean }
export interface PatternHit { rule: string; line: number; length: number }

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

const looksRandom = (v: string, minEntropy: number) => entropy(v) >= minEntropy && /[A-Za-z]/.test(v) && /[0-9]/.test(v);

export const PATTERN_RULES: PatternRule[] = [
  // Provider key shapes. xAI keys use an "xai-" prefix (https://docs.x.ai/docs/tutorial);
  // Google API keys are "AIza" + 35 chars, and Google's newer auth keys start "AQ." (https://ai.google.dev/gemini-api/docs/api-key).
  { id: "xai_key", re: /\bxai-[A-Za-z0-9]{20,}/g, describe: "xAI API key shape" },
  { id: "google_aiza_key", re: /\bAIza[0-9A-Za-z_-]{35}/g, describe: "Google API key (AIza...) shape" },
  { id: "google_aq_key", re: /\bAQ\.[A-Za-z0-9_-]{20,}/g, describe: "Google auth key (AQ. style) shape" },
  // Credentials in transit.
  { id: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, describe: "Bearer token value" },
  { id: "auth_header_value", re: /\b(?:authorization|proxy-authorization|x-goog-api-key|x-api-key)["']?\s*[:=]\s*["']?(?!\[REDACTED)(?!Bearer\b)([A-Za-z0-9._~+/-]{16,})/gi, describe: "auth header with a literal value (not [REDACTED])" },
  { id: "key_env_assignment", re: /\b(?:XAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*["']?(?![$<{[])([^\s"'`]{8,})/g, describe: "key env var assigned a literal value" },
  { id: "url_key_param", re: /[?&](?:key|api_key|apikey|access_token|token)=([A-Za-z0-9._-]{16,})/gi, describe: "credential in a URL query parameter" },
  { id: "url_credentials", re: /\bhttps?:\/\/[^\s/:@"'<>]+:[^\s/@"'<>]{6,}@/g, describe: "user:password in a URL" },
  { id: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, describe: "PEM private key block" },
  { id: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})/g, describe: "GitHub token shape" },
  { id: "sk_token", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, describe: "sk- style API key" },
  // Generic: a secret-ish name assigned a long, high-entropy value.
  {
    id: "generic_high_entropy_kv",
    re: /\b[A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?([A-Za-z0-9+/_.=-]{20,})/gi,
    describe: "secret-named key=value with a high-entropy value (>= 3.5 bits/char, letters+digits)",
    check: (m) => looksRandom(m[1], 3.5),
  },
];

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

export function scanText(text: string, rules: PatternRule[] = PATTERN_RULES): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const r of rules) {
    r.re.lastIndex = 0;
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      if (!r.check || r.check(m)) hits.push({ rule: r.id, line: lineOf(text, m.index), length: m[0].length });
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }
  return hits;
}

/**
 * Synthetic samples for the positive/negative controls. Built at runtime from random characters so no
 * key-shaped literal exists in this repo (the scanner would otherwise flag its own source).
 */
export function syntheticSamples(): { positive: Record<string, string>; negative: string[] } {
  const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  // n random characters, ending in a letter+digit pair so every sample has both.
  const rnd = (n: number) => Array.from({ length: n }, () => ALNUM[Math.floor(Math.random() * ALNUM.length)]).join("") + "7a";
  const tok = rnd(30);
  const dash = "-";
  return {
    positive: {
      xai_key: `x${"ai"}${dash}${tok}`,
      google_aiza_key: `AI${"za"}${rnd(33)}`,
      google_aq_key: `A${"Q"}.${tok}`,
      bearer_token: `Authorization: Bear${"er"} ${tok}`,
      auth_header_value: `"x-goog-api-${"key"}": "${tok}"`,
      key_env_assignment: `export GEMINI_API_${"KEY"}=${tok}`,
      url_key_param: `https://example.com/v1/models?k${"ey"}=${tok}`,
      url_credentials: ["https://user:", tok, "@github.com/org/repo.git"].join(""),
      private_key_block: `${"-----"}BEGIN RSA PRIV${"ATE"} KEY${"-----"}`,
      github_token: `gh${"p"}_${rnd(34)}`,
      sk_token: `s${"k"}${dash}${tok}`,
      generic_high_entropy_kv: `client_sec${"ret"} = "${tok}"`,
    },
    negative: [
      `"authorization": "[REDACTED]"`,
      `"x-goog-api-key": "[REDACTED]"`,
      "Authorization: `Bearer ${v}`",
      `"total_output_tokens": 1549`,
      `export XAI_API_KEY=$XAI_API_KEY`,
      `"interaction_id": "v1_ChZITG5CYXRpZE1wWExfUFVQOGNTN2NREhZITG5CYXRpZE1wWExfUFVQOGNTN2NR"`,
      `origin https://github.com/MADVenturesLLC/red-social-room.git`,
    ],
  };
}

/** Every rule must fire on its sample and no rule may fire on the negatives. Returns failures (empty = ok). */
export function patternSelfTest(): string[] {
  const { positive, negative } = syntheticSamples();
  const failures: string[] = [];
  for (const r of PATTERN_RULES) {
    const sample = positive[r.id];
    if (!sample) { failures.push(`${r.id}: no sample`); continue; }
    if (!scanText(sample, [r]).length) failures.push(`${r.id}: did not fire on its sample`);
  }
  for (const [i, n] of negative.entries()) {
    const h = scanText(n);
    if (h.length) failures.push(`negative #${i} flagged by ${h.map((x) => x.rule).join(",")}`);
  }
  return failures;
}
