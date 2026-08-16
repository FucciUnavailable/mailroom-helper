import type { ResendHeaders } from "../schemas";

/**
 * Turning a Resend retrieve response into an `inboundEmailPayloadSchema`.
 *
 * All pure, all here rather than in the task, for the same reason
 * `auth-results.ts` exists: this is the layer where a quiet mistake — an HTML
 * body reaching the model as markup, a thread key that changes on every reply —
 * is invisible until it is embarrassing. The task file stays a fetch, a parse,
 * and a trigger.
 *
 * None of this used to be ours. It was Make module 2, a mapping panel full of
 * `split()` and `replace()` that could not be read in review or tested at all.
 * Moving it here is the same trade the project makes everywhere else: Make
 * where connectors are hard, TypeScript where logic is.
 */

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup. Returns undefined for an absent header. */
export type HeaderLookup = (name: string) => string | undefined;

/**
 * Flattens either header shape into one lookup.
 *
 * Header names are case-insensitive per RFC 5322 and every provider picks a
 * different casing (`Message-ID` vs `Message-Id` vs `message-id`), so the key
 * is lowercased on both sides. Repeats are joined with a newline: the only
 * repeatable header we read is `Received`, which we don't, and joining keeps
 * `Authentication-Results` from silently losing a hop's verdict when a relay
 * adds its own.
 */
export function headerLookup(headers: ResendHeaders): HeaderLookup {
  const flat = new Map<string, string[]>();

  const push = (name: string, value: string) => {
    const key = name.trim().toLowerCase();
    const existing = flat.get(key);
    if (existing) existing.push(value);
    else flat.set(key, [value]);
  };

  if (Array.isArray(headers)) {
    for (const { name, value } of headers) push(name, value);
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) push(name, item);
      else push(name, value);
    }
  }

  return (name) => flat.get(name.trim().toLowerCase())?.join("\n");
}

/**
 * The four loop-guard headers, with absent ones omitted rather than blanked.
 *
 * `isAutomatedSender` tests presence, not value, so an empty string would read
 * as "a machine sent this" and silence a real customer. Omission is the
 * contract; see the note in make/README.md.
 */
export function loopGuardHeaders(lookup: HeaderLookup): Record<string, string> {
  const guards: Record<string, string> = {};

  const copy = (key: string, header: string) => {
    const value = lookup(header);
    if (value !== undefined) guards[key] = value;
  };

  copy("autoSubmitted", "Auto-Submitted");
  copy("precedence", "Precedence");
  copy("listUnsubscribe", "List-Unsubscribe");
  copy("listId", "List-Id");

  return guards;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export interface Address {
  email: string;
  name?: string;
}

const ADDRESS_PATTERN = /^\s*(.*?)\s*<([^>]+)>\s*$/;

/**
 * Parses `Name <a@b.com>` and bare `a@b.com` alike.
 *
 * Not an RFC 5322 parser — that grammar allows comments, folding, and quoted
 * pairs, and implementing it properly is a library, not a helper. This handles
 * the two forms a real inbox produces and returns the input unchanged as the
 * address when it matches neither, so a strange sender fails at the zod
 * boundary with the original string in the error rather than here.
 */
export function parseAddress(raw: string): Address {
  const match = ADDRESS_PATTERN.exec(raw);

  if (match === null) return { email: raw.trim() };

  const [, rawName = "", email = ""] = match;
  // A display name containing a comma or a colon arrives quoted.
  const name = rawName.replace(/^"(.*)"$/s, "$1").trim();

  return name === "" ? { email: email.trim() } : { email: email.trim(), name };
}

/** Address-only list, for the `to` field. Empty entries are dropped. */
export function parseAddressList(raw: readonly string[]): string[] {
  return raw
    .map((entry) => parseAddress(entry).email)
    .filter((email) => email !== "");
}

// ---------------------------------------------------------------------------
// Threading
// ---------------------------------------------------------------------------

const REPLY_PREFIX = /^\s*((re|fwd?|aw|antwort|rv|sv)\s*(\[\d+\])?\s*:\s*)+/i;

/**
 * Strips reply/forward prefixes, lowercases, collapses whitespace.
 *
 * The prefix set is deliberately wider than `Re:`/`Fwd:` — a reply from a
 * German or Scandinavian client comes back as `AW:` or `SV:`, and a subject
 * that normalises differently on the reply starts a second thread for the same
 * conversation, which is exactly the bug threading exists to prevent.
 */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(REPLY_PREFIX, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** First `<...>` token in a References/In-Reply-To header. */
export function firstMessageId(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const match = /<[^<>\s]+>/.exec(header);
  return match?.[0];
}

/**
 * The stable conversation key.
 *
 * `References` is the correct answer when it exists: its first entry is the
 * root of the thread and every client in the chain preserves it. Subject +
 * sender is the fallback for a first contact, where there is no chain yet —
 * weaker, because a second unrelated mail with the same subject from the same
 * person joins the thread, which is a merge rather than a split and therefore
 * the better failure.
 */
export function deriveThreadKey(
  references: string | undefined,
  subject: string,
  senderEmail: string,
): string {
  const root = firstMessageId(references);
  if (root !== undefined) return root;

  const normalized = normalizeSubject(subject);
  return `${normalized || "(no subject)"}::${senderEmail.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (!body.startsWith("#")) {
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    }

    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);

    // Lone surrogates and out-of-range code points make fromCodePoint throw.
    if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;

    return String.fromCodePoint(code);
  });
}

/** Tags whose closing edge is a line break to a human reading the rendering. */
const BLOCK_TAGS =
  /<\/?(p|div|br|tr|li|h[1-6]|blockquote|table|section|article|header|footer|hr)\b[^>]*>/gi;

/**
 * Best-effort HTML to plain text, for when Resend hands us `text: null`.
 *
 * The bar is not fidelity, it is that **the model never sees markup**. An
 * unstripped body costs tokens, buries the actual question inside a marketing
 * template's table scaffolding, and — worst — puts attacker-controlled
 * `<!-- ignore previous instructions -->` in front of a model that is about to
 * draft a customer reply.
 *
 * Not a sanitiser and not a renderer. Nothing here is ever re-emitted as HTML,
 * so escaping is not the concern; legibility is.
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      // Script and style carry no prose, and their contents survive tag
      // stripping as a wall of CSS if removed in the wrong order.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\r\n?/g, "\n")
    // Whitespace that is not a newline. `\s` covers the U+00A0 an HTML
    // mail's non-breaking spaces leave behind.
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The body the agent will read.
 *
 * `text` wins when present and non-blank. An HTML-only message is stripped
 * rather than dropped, because "we got mail we could not read" is not an
 * outcome this system has — it would arrive at the classifier as an empty body
 * and be read as something other than the question it is.
 */
export function resolveBody(
  text: string | null | undefined,
  html: string | null | undefined,
): string {
  if (text !== null && text !== undefined && text.trim() !== "") {
    return text.trim();
  }

  if (html !== null && html !== undefined && html.trim() !== "") {
    return stripHtml(html);
  }

  return "";
}
