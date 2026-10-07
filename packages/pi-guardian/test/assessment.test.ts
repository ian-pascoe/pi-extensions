import { describe, expect, it } from "vitest";
import {
  decide,
  decidedRisk,
  parseAssessment,
  rejectionReason,
  type RiskLevel,
  type UserAuthorization,
} from "../src/guardian-assessment.js";

describe("Decision Table", () => {
  const authorizations: UserAuthorization[] = ["unknown", "low", "medium", "high"];
  const expected = {
    low: ["allowed", "allowed", "allowed", "allowed"],
    medium: ["allowed", "allowed", "allowed", "allowed"],
    high: ["rejected", "rejected", "allowed", "allowed"],
    critical: ["rejected", "rejected", "rejected", "rejected"],
  } satisfies Record<RiskLevel, readonly string[]>;
  const risks: RiskLevel[] = ["low", "medium", "high", "critical"];
  for (const risk of risks) {
    const outcomes = expected[risk];
    it(`maps ${risk} risk across User Authorizations`, () => {
      expect(authorizations.map((authorization) => decide(risk, authorization))).toEqual(outcomes);
    });
  }
});

describe("Risk Categories", () => {
  it.each([
    ["a missing category", '{"risk_level":"critical","user_authorization":"unknown"}'],
    [
      "an unknown category",
      '{"risk_level":"high","user_authorization":"low","risk_category":"core_module"}',
    ],
    ["none", '{"risk_level":"high","user_authorization":"low","risk_category":"none"}'],
  ])("decides high or critical risk with %s as medium", (_case, text) => {
    const parsed = parseAssessment(text);
    expect(parsed.category).toBeUndefined();
    expect(decidedRisk(parsed)).toBe("medium");
    expect(decide(decidedRisk(parsed), parsed.authorization)).toBe("allowed");
  });

  it("keeps high or critical risk that names a valid category", () => {
    const parsed = parseAssessment(
      '{"risk_level":"critical","user_authorization":"unknown","risk_category":"data_egress","rationale":"Uploads keys."}',
    );
    expect(parsed).toEqual({
      risk: "critical",
      authorization: "unknown",
      category: "data_egress",
      rationale: "Uploads keys.",
    });
    expect(decide(decidedRisk(parsed), parsed.authorization)).toBe("rejected");
  });

  it("leaves low and medium risk unchanged without a category", () => {
    expect(decidedRisk(parseAssessment('{"risk_level":"low","user_authorization":"low"}'))).toBe(
      "low",
    );
  });
});

describe("Guardian output parsing", () => {
  const json =
    '{"risk_level":"high","user_authorization":"low","risk_category":"destruction","rationale":" Deletes data. "}';

  it.each([
    ["bare JSON", json],
    ["a fenced json block", `Here you go:\n\`\`\`json\n${json}\n\`\`\``],
    ["an unlabeled fence", `\`\`\`\n${json}\n\`\`\``],
    ["surrounding prose", `My assessment: ${json} Thanks.`],
  ])("accepts %s", (_case, text) => {
    expect(parseAssessment(text)).toEqual({
      risk: "high",
      authorization: "low",
      category: "destruction",
      rationale: "Deletes data.",
    });
  });

  it("accepts the same assessment repeated, with braces inside its rationale", () => {
    const braced =
      '{"risk_level":"low","user_authorization":"high","rationale":"uses {x} and \\"}\\""}';
    expect(parseAssessment(`${braced}\n\`\`\`json\n${braced}\n\`\`\``)).toEqual({
      risk: "low",
      authorization: "high",
      category: undefined,
      rationale: 'uses {x} and "}"',
    });
  });

  it("ignores extra fields", () => {
    expect(
      parseAssessment(
        '{"risk_level":"low","user_authorization":"high","rationale":"ok","outcome":"allow"}',
      ).risk,
    ).toBe("low");
  });

  it.each([
    ["prose", "Looks fine to me."],
    ["unknown risk", '{"risk_level":"severe","user_authorization":"low","rationale":"x"}'],
    ["missing authorization", '{"risk_level":"low","rationale":"x"}'],
    ["broken JSON", '{"risk_level":"low",'],
    [
      "two differing assessments",
      '{"risk_level":"critical","user_authorization":"unknown","rationale":"x"}\n```json\n{"risk_level":"low","user_authorization":"high","rationale":"y"}\n```',
    ],
  ])("rejects %s as a Review Failure", (_case, text) => {
    expect(() => parseAssessment(text)).toThrow(/malformed output/);
  });

  it.each(["low", "critical"])("accepts a %s-risk assessment without a rationale", (risk) => {
    expect(parseAssessment(`{"risk_level":"${risk}","user_authorization":"low"}`)).toEqual({
      risk,
      authorization: "low",
      category: undefined,
      rationale: "",
    });
  });
});

describe("Rejection text", () => {
  it("states risk, authorization, and rationale, then forbids circumvention", () => {
    expect(
      rejectionReason({
        risk: "critical",
        authorization: "unknown",
        category: "data_egress",
        rationale: "Exfiltrates keys.",
      }),
    ).toBe(
      [
        "This action was rejected due to unacceptable risk.",
        "Risk: critical (data_egress). Authorization: unknown.",
        "Reason: Exfiltrates keys.",
        "Do not attempt to achieve the same outcome through a workaround, indirect execution, or variations of this call, and do not retry it. Explain the risk to the user and ask whether they want to proceed; continue only with a materially safer alternative or after the user explicitly approves this action.",
      ].join("\n"),
    );
  });

  it("uses a fixed reason when a high-risk assessment omits its rationale", () => {
    expect(
      rejectionReason({
        risk: "high",
        authorization: "low",
        category: "persistence",
        rationale: "",
      }),
    ).toContain("Reason: The Guardian gave no specific rationale.\n");
  });
});
