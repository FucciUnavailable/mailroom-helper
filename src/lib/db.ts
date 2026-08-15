import type { Classification, InboundEmailPayload } from "../schemas";
import type { RiskDecision } from "./risk-tier";
import { supabase } from "./supabase";

/**
 * Every database access the task makes, so the task file stays branching-only.
 */

export interface ThreadState {
  id: string;
  turnCount: number;
}

export interface ContactState {
  id: string;
  email: string;
  fullName: string;
}

export async function resolveContact(
  email: string,
): Promise<ContactState | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, email, full_name")
    .eq("email", email.toLowerCase())
    .maybeSingle<{ id: string; email: string; full_name: string }>();

  if (error) throw new Error(`resolveContact failed: ${error.message}`);
  if (!data) return null;

  return { id: data.id, email: data.email, fullName: data.full_name };
}

export async function resolveThread(
  threadKey: string,
  contactId: string | null,
): Promise<ThreadState> {
  const { data, error } = await supabase
    .from("threads")
    .upsert(
      { thread_key: threadKey, contact_id: contactId },
      { onConflict: "thread_key" },
    )
    .select("id, turn_count")
    .single<{ id: string; turn_count: number }>();

  if (error) throw new Error(`resolveThread failed: ${error.message}`);

  return { id: data.id, turnCount: data.turn_count };
}

/**
 * Inserts the inbound message, or reports that we have seen it before.
 *
 * This is the database-level idempotency backstop behind the Trigger.dev
 * idempotency key: `ignoreDuplicates` turns the unique constraint on
 * `message_id` into a zero-row result instead of an error, so a redelivery
 * that slipped past the first line of defence stops here rather than
 * generating a second reply.
 */
export async function recordInboundMessage(
  threadId: string,
  payload: InboundEmailPayload,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("messages")
    .upsert(
      {
        thread_id: threadId,
        message_id: payload.messageId,
        direction: "inbound",
        subject: payload.subject,
        body: payload.text,
      },
      { onConflict: "message_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) throw new Error(`recordInboundMessage failed: ${error.message}`);

  return data?.[0] ?? null;
}

export async function recordDecision(
  messageRowId: string,
  classification: Classification,
  decision: RiskDecision,
): Promise<void> {
  const { error } = await supabase
    .from("messages")
    .update({
      classification,
      risk_tier: decision.tier,
      risk_reason: decision.reason,
    })
    .eq("id", messageRowId);

  if (error) throw new Error(`recordDecision failed: ${error.message}`);
}

export async function recordOutboundMessage(
  threadId: string,
  inReplyTo: string,
  subject: string,
  body: string,
  decision: RiskDecision,
): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    thread_id: threadId,
    // Synthetic Message-ID: the real one is minted by the sending mail server
    // in Make, which we never see. Unique so the constraint still holds.
    message_id: `<outbound-${crypto.randomUUID()}@mailroom.invalid>`,
    direction: "outbound",
    subject,
    body,
    risk_tier: decision.tier,
    risk_reason: `reply-to:${inReplyTo}`,
  });

  if (error) throw new Error(`recordOutboundMessage failed: ${error.message}`);
}

/** Feeds the reply_cap_exceeded rule. */
export async function countRepliesLast24h(threadId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId)
    .eq("direction", "outbound")
    .gte("created_at", since);

  if (error) throw new Error(`countRepliesLast24h failed: ${error.message}`);

  return count ?? 0;
}

export async function advanceThread(
  threadId: string,
  status: "open" | "awaiting_approval" | "escalated" | "closed",
  incrementTurn: boolean,
  currentTurnCount: number,
): Promise<void> {
  const { error } = await supabase
    .from("threads")
    .update({
      status,
      turn_count: incrementTurn ? currentTurnCount + 1 : currentTurnCount,
      last_message_at: new Date().toISOString(),
    })
    .eq("id", threadId);

  if (error) throw new Error(`advanceThread failed: ${error.message}`);
}
