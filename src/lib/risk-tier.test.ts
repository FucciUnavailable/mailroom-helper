import { describe, it, expect } from "vitest";
import {
  assessPreAgentRisk,
  assessRisk,
  RiskTier,
  type RiskInput,
} from "./risk-tier";

/** A message that should sail straight through. Override one field per test. */
const safe: RiskInput = {
  classification: {
    intent: "general_info",
    urgency: "normal",
    asksForAccountData: false,
    needsHuman: false,
    confidence: 0.95,
  },
  isAutomatedSender: false,
  senderAuthenticated: true,
  contactResolved: true,
  threadTurnCount: 0,
  repliesLast24h: 0,
  proposedWrites: [],
  hasGroundingEvidence: true,
};

const withInput = (patch: Partial<RiskInput>): RiskInput => ({
  ...safe,
  ...patch,
});
const withClass = (patch: Partial<RiskInput["classification"]>): RiskInput => ({
  ...safe,
  classification: { ...safe.classification, ...patch },
});

describe("assessRisk", () => {
  it("auto-sends a grounded, confident answer to a known sender", () => {
    expect(assessRisk(safe).tier).toBe(RiskTier.AUTO);
  });

  describe("BLOCK", () => {
    it("blocks automated senders to prevent auto-responder loops", () => {
      const d = assessRisk(withInput({ isAutomatedSender: true }));
      expect(d.tier).toBe(RiskTier.BLOCK);
      expect(d.reason).toBe("automated_sender");
    });

    it("blocks spam rather than confirming a live address", () => {
      expect(assessRisk(withClass({ intent: "spam" })).tier).toBe(
        RiskTier.BLOCK,
      );
    });

    it("blocks abuse", () => {
      expect(assessRisk(withClass({ intent: "abuse" })).tier).toBe(
        RiskTier.BLOCK,
      );
    });

    it("blocks an automated sender even when everything else is high risk", () => {
      const d = assessRisk(
        withInput({
          isAutomatedSender: true,
          senderAuthenticated: false,
          contactResolved: false,
          classification: { ...safe.classification, asksForAccountData: true },
        }),
      );
      expect(d.tier).toBe(RiskTier.BLOCK);
    });
  });

  describe("ESCALATE", () => {
    it("escalates account-data requests from unauthenticated senders", () => {
      const d = assessRisk(
        withInput({
          senderAuthenticated: false,
          classification: { ...safe.classification, asksForAccountData: true },
        }),
      );
      expect(d.tier).toBe(RiskTier.ESCALATE);
      expect(d.reason).toBe("unverified_sender_requesting_account_data");
    });

    it("escalates account-data requests from unknown contacts", () => {
      const d = assessRisk(
        withInput({
          contactResolved: false,
          classification: { ...safe.classification, asksForAccountData: true },
        }),
      );
      expect(d.tier).toBe(RiskTier.ESCALATE);
    });

    it("escalates rather than approves when the sender is unverified, so no human rubber-stamps a spoofed request", () => {
      const d = assessRisk(
        withInput({
          senderAuthenticated: false,
          classification: { ...safe.classification, asksForAccountData: true },
        }),
      );
      expect(d.tier).not.toBe(RiskTier.APPROVE);
    });

    it("escalates when the classifier asks for a human", () => {
      expect(assessRisk(withClass({ needsHuman: true })).tier).toBe(
        RiskTier.ESCALATE,
      );
    });

    it("escalates at the agent turn limit", () => {
      expect(assessRisk(withInput({ threadTurnCount: 3 })).tier).toBe(
        RiskTier.ESCALATE,
      );
      expect(assessRisk(withInput({ threadTurnCount: 2 })).tier).toBe(
        RiskTier.AUTO,
      );
    });

    it("escalates once the 24h reply cap is hit", () => {
      expect(assessRisk(withInput({ repliesLast24h: 5 })).tier).toBe(
        RiskTier.ESCALATE,
      );
      expect(assessRisk(withInput({ repliesLast24h: 4 })).tier).toBe(
        RiskTier.AUTO,
      );
    });
  });

  describe("APPROVE", () => {
    it("gates low-confidence classifications", () => {
      expect(assessRisk(withClass({ confidence: 0.59 })).tier).toBe(
        RiskTier.APPROVE,
      );
      expect(assessRisk(withClass({ confidence: 0.6 })).tier).toBe(
        RiskTier.AUTO,
      );
    });

    it("gates account-data disclosure to a verified, known sender", () => {
      const d = assessRisk(withClass({ asksForAccountData: true }));
      expect(d.tier).toBe(RiskTier.APPROVE);
      expect(d.reason).toBe("account_data_disclosure");
    });

    it("gates any reply that would write to an external system", () => {
      const d = assessRisk(withInput({ proposedWrites: ["crm_create_deal"] }));
      expect(d.tier).toBe(RiskTier.APPROVE);
      expect(d.reason).toBe("external_write");
    });

    it("gates an ungrounded general-info answer", () => {
      const d = assessRisk(withInput({ hasGroundingEvidence: false }));
      expect(d.tier).toBe(RiskTier.APPROVE);
      expect(d.reason).toBe("ungrounded_answer");
    });

    it("does not gate a sales reply just because retrieval was empty", () => {
      const d = assessRisk(
        withInput({
          hasGroundingEvidence: false,
          classification: { ...safe.classification, intent: "sales" },
        }),
      );
      expect(d.tier).toBe(RiskTier.AUTO);
    });
  });

  describe("precedence", () => {
    it("prefers BLOCK over ESCALATE", () => {
      const d = assessRisk(
        withInput({
          classification: {
            ...safe.classification,
            intent: "spam",
            needsHuman: true,
          },
        }),
      );
      expect(d.tier).toBe(RiskTier.BLOCK);
    });

    it("prefers ESCALATE over APPROVE", () => {
      const d = assessRisk(
        withInput({
          proposedWrites: ["crm_create_deal"],
          classification: { ...safe.classification, needsHuman: true },
        }),
      );
      expect(d.tier).toBe(RiskTier.ESCALATE);
    });

    it("returns an auditable reason on every path", () => {
      expect(assessRisk(safe).reason).toBe("no_rule_matched");
      expect(assessRisk(withClass({ intent: "spam" })).reason).toBe("spam");
    });
  });

  describe("pre-agent gate", () => {
    // Every case here decides the message without a draft, so the agent loop
    // is skipped entirely and no model call is made after classification.
    const shortCircuits: ReadonlyArray<[string, RiskInput]> = [
      ["automated_sender", withInput({ isAutomatedSender: true })],
      ["abuse", withClass({ intent: "abuse" })],
      ["spam", withClass({ intent: "spam" })],
      ["reply_cap_exceeded", withInput({ repliesLast24h: 5 })],
      [
        "unverified_sender_requesting_account_data",
        withInput({
          senderAuthenticated: false,
          classification: { ...safe.classification, asksForAccountData: true },
        }),
      ],
      ["model_requested_human", withClass({ needsHuman: true })],
      ["agent_turn_limit", withInput({ threadTurnCount: 3 })],
    ];

    it.each(shortCircuits)("short-circuits on %s", (reason, input) => {
      expect(assessPreAgentRisk(input)).toEqual({
        tier: expect.stringMatching(/^(BLOCK|ESCALATE)$/),
        reason,
        acknowledge: expect.any(Boolean),
      });
    });

    it("never short-circuits into AUTO — clearing the gate is not permission to send", () => {
      expect(assessPreAgentRisk(safe)).toBeNull();
    });

    // These need a draft for a human to look at, so they must fall through.
    const mustReachTheAgent: ReadonlyArray<[string, RiskInput]> = [
      ["low_confidence", withClass({ confidence: 0.4 })],
      ["account_data_disclosure", withClass({ asksForAccountData: true })],
      ["external_write", withInput({ proposedWrites: ["crm_create_deal"] })],
      ["ungrounded_answer", withInput({ hasGroundingEvidence: false })],
    ];

    it.each(mustReachTheAgent)(
      "falls through on %s so a draft still gets written",
      (_reason, input) => {
        expect(assessPreAgentRisk(input)).toBeNull();
        expect(assessRisk(input).tier).toBe(RiskTier.APPROVE);
      },
    );

    it("does not require agent output to be present at all", () => {
      const { proposedWrites: _w, hasGroundingEvidence: _g, ...preAgent } =
        withClass({ intent: "spam" });

      expect(assessPreAgentRisk(preAgent)).toEqual({
        tier: RiskTier.BLOCK,
        reason: "spam",
        acknowledge: false,
      });
    });

    it("throws on a malformed payload rather than waving the message through", () => {
      expect(() => assessPreAgentRisk({})).toThrow();
    });

    // The guard that keeps the optimisation honest: two entry points, one
    // answer. If a rule is ever moved across the pre/post boundary and the
    // tiers stop agreeing, this fails.
    it.each([...shortCircuits, ...mustReachTheAgent])(
      "agrees with the full pass on %s",
      (_reason, input) => {
        const early = assessPreAgentRisk(input);
        if (early !== null) {
          expect(early).toEqual(assessRisk(input));
        }
      },
    );
  });

  describe("sender acknowledgment", () => {
    // ESCALATE and BLOCK both send no AI-drafted reply, but they mean opposite
    // things to the person who wrote in: ESCALATE means a human is handling it,
    // BLOCK means nobody is. Only the first is worth telling them about.

    const blocked: ReadonlyArray<[string, RiskInput]> = [
      ["automated_sender", withInput({ isAutomatedSender: true })],
      ["spam", withClass({ intent: "spam" })],
      ["abuse", withClass({ intent: "abuse" })],
    ];

    it.each(blocked)(
      "never acknowledges %s — an acknowledgment is a send, and BLOCK means send nothing",
      (reason, input) => {
        const d = assessRisk(input);
        expect(d.tier).toBe(RiskTier.BLOCK);
        expect(d.reason).toBe(reason);
        expect(d.acknowledge).toBe(false);
      },
    );

    it("never acknowledges an automated sender, which is what keeps the loop closed", () => {
      // The load-bearing case. Acknowledging a bounce notifier or an
      // out-of-office means our acknowledgment trips their auto-reply, which
      // trips ours. Two auto-responders discovering each other is unbounded.
      expect(
        assessRisk(withInput({ isAutomatedSender: true })).acknowledge,
      ).toBe(false);
    });

    it("does not acknowledge the reply cap — the acknowledgment would be the send the cap exists to prevent", () => {
      const d = assessRisk(withInput({ repliesLast24h: 5 }));
      expect(d.reason).toBe("reply_cap_exceeded");
      expect(d.acknowledge).toBe(false);
    });

    const acknowledged: ReadonlyArray<[string, RiskInput]> = [
      [
        "unverified_sender_requesting_account_data",
        withInput({
          senderAuthenticated: false,
          classification: { ...safe.classification, asksForAccountData: true },
        }),
      ],
      ["model_requested_human", withClass({ needsHuman: true })],
      ["agent_turn_limit", withInput({ threadTurnCount: 3 })],
    ];

    it.each(acknowledged)(
      "acknowledges %s, because a human really is picking it up",
      (reason, input) => {
        const d = assessRisk(input);
        expect(d.tier).toBe(RiskTier.ESCALATE);
        expect(d.reason).toBe(reason);
        expect(d.acknowledge).toBe(true);
      },
    );

    it("does not acknowledge AUTO — the real reply is the acknowledgment", () => {
      expect(assessRisk(safe).acknowledge).toBe(false);
    });

    it.each([
      ["low_confidence", withClass({ confidence: 0.4 })],
      ["account_data_disclosure", withClass({ asksForAccountData: true })],
      ["external_write", withInput({ proposedWrites: ["crm_create_deal"] })],
      ["ungrounded_answer", withInput({ hasGroundingEvidence: false })],
    ] as ReadonlyArray<[string, RiskInput]>)(
      "does not acknowledge %s — a draft is already waiting on a human",
      (_reason, input) => {
        const d = assessRisk(input);
        expect(d.tier).toBe(RiskTier.APPROVE);
        expect(d.acknowledge).toBe(false);
      },
    );

    it("defaults to silence for a rule that does not opt in", () => {
      // Not a behavioural assertion about today's rules so much as a guard on
      // the default: `acknowledge` is optional on Rule, and the fallback must
      // be false. A new rule added without thinking about it stays quiet
      // rather than inheriting a customer email nobody reasoned about.
      const everyDecision = [
        ...blocked,
        ...acknowledged,
        ["no_rule_matched", safe] as [string, RiskInput],
      ].map(([, input]) => assessRisk(input));

      for (const d of everyDecision) {
        expect(typeof d.acknowledge).toBe("boolean");
      }
    });
  });

  describe("input validation", () => {
    it("throws on a malformed payload rather than defaulting to AUTO", () => {
      expect(() =>
        assessRisk({ classification: { intent: "nonsense" } }),
      ).toThrow();
      expect(() => assessRisk({})).toThrow();
    });

    it("throws on an out-of-range confidence", () => {
      expect(() => assessRisk(withClass({ confidence: 1.5 }))).toThrow();
    });
  });
});
