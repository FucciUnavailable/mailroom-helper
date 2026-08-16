import type { InboundEmailPayload } from "../schemas";

/**
 * Turns the receiving mail server's `Authentication-Results` header into the
 * two booleans the risk rules actually ask about.
 *
 * This lives here rather than in Make on purpose. Neither the Gmail nor the
 * IMAP module hands you SPF and DKIM verdicts — they are buried in a header
 * that has to be pattern-matched, and pattern-matching in a Make expression is
 * exactly the kind of logic that belongs in a tested function. Make forwards
 * the raw header; the decision is made here.
 *
 * It matters more than it looks. `unverified_sender_requesting_account_data`
 * is the rule that ESCALATEs a spoofable sender instead of putting a plausible
 * draft in front of a human who will click yes. If the ingestion side ever
 * hardcodes `spfPass: true` because the real value was awkward to extract,
 * that rule is decoration.
 *
 * A missing header therefore reads as *not authenticated*, not as unknown.
 * Failing closed is the only safe default for a signal whose whole job is to
 * gate account data.
 */

export interface AuthVerdicts {
  spfPass: boolean;
  dkimPass: boolean;
}

/**
 * Matches `spf=pass` / `dkim=pass` with optional surrounding whitespace.
 *
 * The trailing `\b` is what keeps `spf=softfail` and `dkim=passthrough` from
 * reading as a pass, and the leading `\b` stops `dkim=pass` from satisfying a
 * lookup for a differently-named method.
 */
function methodPassed(header: string, method: "spf" | "dkim"): boolean {
  return new RegExp(String.raw`\b${method}\s*=\s*pass\b`, "i").test(header);
}

export function parseAuthenticationResults(
  header: string | undefined,
): AuthVerdicts {
  if (header === undefined) return { spfPass: false, dkimPass: false };

  return {
    spfPass: methodPassed(header, "spf"),
    dkimPass: methodPassed(header, "dkim"),
  };
}

/**
 * Resolves the verdicts for a payload.
 *
 * Explicit booleans win when present — the fixtures set them directly, and a
 * future ingestion path that can produce them properly should not be forced
 * through a string. Otherwise the raw header is parsed. Neither present means
 * unauthenticated.
 */
export function resolveAuthentication(
  payload: InboundEmailPayload,
): AuthVerdicts {
  const parsed = parseAuthenticationResults(payload.authenticationResults);

  return {
    spfPass: payload.spfPass ?? parsed.spfPass,
    dkimPass: payload.dkimPass ?? parsed.dkimPass,
  };
}
