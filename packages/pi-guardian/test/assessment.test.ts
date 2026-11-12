import { describe, expect, it } from "vite-plus/test";
import {
  decide,
  decidedRisk,
  parseAssessment,
  parseFinalAssessment,
  rejectionReason,
  validRiskCategories,
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
  it("maps each risk across User Authorizations", () => {
    const risks: RiskLevel[] = ["low", "medium", "high", "critical"];
    for (const risk of risks)
      expect(
        authorizations.map((authorization) => decide(risk, authorization)),
        risk,
      ).toEqual(expected[risk]);
  });
});

describe("reasoned replies", () => {
  const final = JSON.stringify({
    risk_level: "medium",
    user_authorization: "high",
    rationale: "Requested { in braces }.",
  });

  it.each([
    ["an unbalanced brace in the reasoning", `The set {a, b is open. So:\n${final}`],
    [
      "an example object in the reasoning",
      `A rejection would be {"risk_level": "critical", "user_authorization": "unknown"}. But:\n${final}`,
    ],
  ])("take the assessment that ends last despite %s", (_case, text) => {
    expect(parseFinalAssessment(text)).toMatchObject({
      risk: "medium",
      authorization: "high",
      rationale: "Requested { in braces }.",
    });
  });

  it("fail without any assessment", () => {
    expect(() => parseFinalAssessment("I think {it is fine")).toThrow(/malformed output/);
  });

  it("are parsed strictly in the first pass", () => {
    expect(() => parseAssessment(`The set {a, b is open. So:\n${final}`)).toThrow(
      /malformed output/,
    );
  });
});

describe("Risk Categories", () => {
  it.each([
    ["a missing category", '{"risk_level":"critical","user_authorization":"unknown"}'],
    [
      "an unknown category",
      '{"risk_level":"high","user_authorization":"low","risk_category":"core_module"}',
    ],
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

  it("normalizes the stated category", () => {
    const parsed = parseAssessment(
      JSON.stringify({
        risk_level: "high",
        user_authorization: "low",
        risk_category: " Data-Egress ",
      }),
    );
    expect(parsed.category).toBe("data_egress");
    expect(decide(decidedRisk(parsed), parsed.authorization)).toBe("rejected");
  });

  it("accepts a null category and rationale", () => {
    expect(
      parseAssessment(
        '{"risk_level":"low","user_authorization":"high","risk_category":null,"rationale":null}',
      ),
    ).toEqual({ risk: "low", authorization: "high", category: undefined, rationale: "" });
  });

  it("accepts security_policy only when a Security Policy or deny Command Rule is configured", () => {
    const text =
      '{"risk_level":"high","user_authorization":"low","risk_category":"security-policy"}';
    expect(parseAssessment(text).category).toBeUndefined();
    expect(parseAssessment(text, validRiskCategories(true)).category).toBe("security_policy");
  });
});

describe("Guardian output parsing", () => {
  const json =
    '{"risk_level":"high","user_authorization":"low","risk_category":"destruction","rationale":" Deletes data. "}';

  it.each([
    ["a fenced json block", `Here you go:\n\`\`\`json\n${json}\n\`\`\``],
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

  it.each([
    ["prose", "Looks fine to me."],
    ["unknown risk", '{"risk_level":"severe","user_authorization":"low","rationale":"x"}'],
    [
      "two differing assessments",
      '{"risk_level":"critical","user_authorization":"unknown","rationale":"x"}\n```json\n{"risk_level":"low","user_authorization":"high","rationale":"y"}\n```',
    ],
  ])("rejects %s as a Review Failure", (_case, text) => {
    expect(() => parseAssessment(text)).toThrow(/malformed output/);
  });
});

describe("Rejection text", () => {
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
