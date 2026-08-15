import { describe, it, expect } from "vitest";
import { assessRisk, RiskTier, type RiskInput } from "./risk-tier";

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
