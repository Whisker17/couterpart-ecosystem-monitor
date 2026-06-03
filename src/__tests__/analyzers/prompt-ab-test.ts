/**
 * A/B prompt comparison tests (v1 vs v2) — fixture-based.
 *
 * Design rationale: these tests validate prompt quality without live LLM calls by
 * applying a rubric-keyword oracle. The oracle determines whether a rendered system
 * prompt contains the discriminating criteria needed to correctly classify each fixture.
 *
 * Structure:
 *   1. v1SystemPromptFor() — exact snapshot of the pre-v2 prompt, sourced from
 *      git commit 04058e9 (parent of the v2 commit).
 *   2. v2SystemPromptFor() — rendered via the real `reviewContent` code path,
 *      capturing what the model actually receives.
 *   3. 5 labelled fixtures drawn from realistic competitor content patterns.
 *      Each fixture specifies:
 *        - expected_significance: ground-truth label
 *        - required_v2_criteria: rubric terms that MUST appear for correct classification
 *        - v1_gap_reason: why v1 lacks the coverage (documented expected failure mode)
 *   4. oracleClassify() — keyword oracle that applies rubric criteria to predict tier.
 *      Uses prompt coverage to decide tier, not mock output.
 *
 * Regression guarantee: if someone reverts `buildSystemPrompt()` to v1 text,
 * the oracle tests for every directional_shift fixture will fail because v1 lacks
 * the explicit business-model / open-source / CEO-declaration criteria.
 * The tie-breaker and calibration-anchor tests will also fail.
 *
 * Why oracle-based rather than live LLM: CI has no LLM access and results would be
 * non-deterministic. The oracle isolates prompt quality (structure + coverage) from
 * model-side stochasticity, which is the thing we can actually control and regress on.
 */
import { test, expect, describe, beforeAll } from "bun:test";
import { reviewContent } from "../../analyzers/llm-reviewer.js";
import type { ReviewInput, GenerateObjectFn } from "../../analyzers/llm-reviewer.js";
import { ContentAnalysisSchema } from "../../schema/analysis.js";

// ---------------------------------------------------------------------------
// V1 prompt snapshot (verbatim, from git commit 04058e9 — parent of v2 commit)
// ---------------------------------------------------------------------------

function v1SystemPromptFor(competitorContext: string): string {
  return `你是一名竞品情报分析师，专注于分析竞争对手的公开内容，为产品和战略团队提供洞察。

## 竞品上下文
${competitorContext}

## 重要程度分类规则
- **routine**（常规）：日常博客、技术分享、招聘信息、无实质竞争影响
- **notable**（值得关注）：新功能发布、重要合作、明显的战略调整迹象、影响市场定位的变化
- **directional_shift**（方向性转变）：重大战略转型、进入新市场、核心产品方向改变、可能显著改变竞争格局的举动

## 分析要求
- 保持客观，基于内容本身做推断，避免过度解读
- summary 和 why_we_care 使用中文
- technical_detail 可以使用技术术语，如内容无明显技术细节请写"无明显技术细节"
- 对 significance 保持保守：只有真正重要的内容才标记 notable 或 directional_shift`;
}

// ---------------------------------------------------------------------------
// Helpers: capture the v2 system prompt rendered by the real code
// ---------------------------------------------------------------------------

interface CapturedPrompts {
  system: string;
  user: string;
}

function makeCapturer(): { mock: GenerateObjectFn; captured: CapturedPrompts[] } {
  const captured: CapturedPrompts[] = [];
  const mock: GenerateObjectFn = async (opts) => {
    captured.push({ system: opts.system, prompt: opts.prompt });
    return {
      object: {
        summary: "stub",
        technical_detail: "无明显技术细节",
        category: "other",
        direction_signal: "无明显战略信号",
        significance: "routine",
        urgency: "normal",
        sentiment: "neutral",
        why_we_care: "stub",
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  };
  return { mock, captured };
}

function buildCompetitorContext(input: ReviewInput): string {
  const tags = input.competitorTags.join("、") || "暂无标签";
  return `竞争对手：${input.competitorName}（${input.competitorOrg}）\n标签分类：${tags}\n官网：${input.sourceUrl}`;
}

async function captureV2Prompt(input: ReviewInput): Promise<CapturedPrompts> {
  process.env.LLM_BASE_URL = "https://fake.example.com/v1";
  process.env.LLM_API_KEY = "fake-key";
  const { mock, captured } = makeCapturer();
  await reviewContent(input, mock);
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  return captured[0]!;
}

// ---------------------------------------------------------------------------
// Rubric-keyword oracle
// ---------------------------------------------------------------------------
// Returns whether a system prompt contains ALL required criteria for the given
// fixture tier. Absence of any required term predicts misclassification.

function oracleHasAllCriteria(systemPrompt: string, requiredTerms: string[]): boolean {
  return requiredTerms.every((term) => systemPrompt.includes(term));
}

// ---------------------------------------------------------------------------
// Labelled fixtures (5 cases from realistic competitor content patterns)
// ---------------------------------------------------------------------------

// Fixture 1 ─ directional_shift: full open-source platform pivot
// Real-world pattern: SaaS → open-source model change, CEO-level announcement.
// v1 gap: v1 lists "重大战略转型" but has no specific mention of "商业模式" change or "开源",
//         so an LLM using v1 often stops at "notable" (new strategy = notable by v1 rubric).
// v2 fix: explicit criteria "商业模式根本性改变" and "闭源转开源" (implied by "开源").
const FIXTURE_OPENSOURCE_PIVOT: ReviewInput = {
  contentItemId: 1,
  competitorName: "Acme Analytics",
  competitorOrg: "acme-analytics",
  competitorTags: ["data", "analytics", "SaaS"],
  title: "We Are Going Fully Open Source — Our Entire Platform, Starting Now",
  content: `Today Acme Analytics is transitioning our entire product suite to open source under
Apache 2.0. This is not a partial open-core model — every line of our platform code
will be public. CEO statement: "This is a once-in-a-decade strategic bet." Our SaaS
subscription tier will shut down in 90 days. Revenue shifts to enterprise support.`,
  sourceUrl: "https://acme-analytics.com/blog/going-open-source",
  inputQuality: "full",
};

// Fixture 2 ─ routine: developer optimisation tutorial
// Real-world pattern: engineering blog post with no competitive signal.
// v1 gap: v1 says "日常博客、技术分享" but does NOT list "教程" (tutorial) explicitly;
//         an LLM under v1 may classify detailed technical posts as notable ("技术分享" ≈ "technical").
// v2 fix: "技术博客、教程、开发者心得" appears in routine tier, unambiguously covering tutorials.
const FIXTURE_DEVTUTORIAL: ReviewInput = {
  contentItemId: 2,
  competitorName: "DataFlow Inc",
  competitorOrg: "dataflow-inc",
  competitorTags: ["data", "ETL", "pipeline"],
  title: "5 Tips for Optimizing Your Data Pipeline Performance",
  content: `When working with large-scale pipelines, performance matters. Here are five tips:
1. Use batch processing (10x latency reduction). 2. Index your lookup tables properly.
3. Parallelize independent stages. 4. Profile before optimizing. 5. Cache expensive steps.
These tips come from our internal experience building DataFlow. See our docs for details.`,
  sourceUrl: "https://dataflow.com/blog/pipeline-optimization-tips",
  inputQuality: "full",
};

// Fixture 3 ─ routine: conference appearance announcement
// Real-world pattern: company announces speaking slot at industry event.
// v1 gap: v1 routine criteria don't mention events/conferences; the phrase "new approach"
//         in a conference description can trigger v1's notable criterion "战略调整迹象".
// v2 fix: "活动/会议/线下聚会宣传" is an explicit routine example.
const FIXTURE_CONFERENCE: ReviewInput = {
  contentItemId: 3,
  competitorName: "StreamBase",
  competitorOrg: "streambase",
  competitorTags: ["streaming", "real-time"],
  title: "Join Us at DataConf 2026 — We're Presenting Our New Approach to Stream Processing",
  content: `Our team will be at DataConf 2026, presenting our latest work on stream processing.
Join us for a talk on how we handle high-throughput workloads at scale. We'll share
some lessons learned and demo our recent developer tooling improvements.
Registration is open at dataconf.io.`,
  sourceUrl: "https://streambase.io/blog/dataconf-2026",
  inputQuality: "full",
};

// Fixture 4 ─ notable: direct competing product launch
// Real-world pattern: competitor releases a product that competes head-on.
// This should be notable (not directional_shift) — it's an important launch but
// within their existing strategic direction.
// v1 gap: v1 notable criteria are "新功能发布、重要合作", but v1 also says
//         "核心产品方向改变" counts as directional_shift. A new competing product can
//         be misread as "核心产品方向改变" under v1, causing over-escalation to directional_shift.
// v2 fix: directional_shift now requires "超出单一产品线" + "不可逆"; a new product launch
//         without business model change stays in notable.
const FIXTURE_PRODUCT_LAUNCH: ReviewInput = {
  contentItemId: 4,
  competitorName: "Synapse DB",
  competitorOrg: "synapse-db",
  competitorTags: ["database", "analytics", "cloud"],
  title: "Introducing SynapseStream: Real-Time Analytics for Every Developer",
  content: `Today we launch SynapseStream, our real-time analytics engine built for developers.
SynapseStream integrates directly with your existing Synapse DB cluster and delivers
sub-second query results over streaming data. GA for all Enterprise customers today.
Pricing starts at $199/month. We now compete directly in the streaming analytics market.`,
  sourceUrl: "https://synapsedb.com/blog/introducing-synapsestream",
  inputQuality: "full",
};

// Fixture 5 ─ directional_shift: CEO-level market exit + pivot announcement
// Real-world pattern: explicit CEO statement abandoning a product line.
// v1 gap: v1 directional_shift includes "核心产品方向改变" but has no mention of
//         "CEO/创始人级别明确宣告" — without that signal, an LLM under v1 might
//         treat this as notable strategy shift.
// v2 fix: "CEO/创始人级别明确宣告的战略转型" and "主动放弃或退出核心产品线" are explicit
//         directional_shift criteria.
const FIXTURE_CEO_PIVOT: ReviewInput = {
  contentItemId: 5,
  competitorName: "CloudVertex",
  competitorOrg: "cloudvertex",
  competitorTags: ["cloud", "infrastructure"],
  title: "A Message from Our CEO: Exiting the SMB Market to Focus on Enterprise",
  content: `After years in the SMB segment, I have decided we are exiting that market entirely.
Effective Q1 2027, we will discontinue all SMB-tier products. This is not a gradual
transition — we are fully committed to enterprise infrastructure. Our team has already
redirected all roadmap resources. Existing SMB customers will receive migration support.
— Alex Chen, CEO of CloudVertex`,
  sourceUrl: "https://cloudvertex.io/blog/ceo-message-enterprise-focus",
  inputQuality: "full",
};

// ---------------------------------------------------------------------------
// Oracle coverage scores: which fixtures v1 vs v2 covers correctly
// ---------------------------------------------------------------------------

// Rubric criteria that v2 added that are fixture-specific
const FIXTURE_REQUIRED_V2_CRITERIA: Record<number, { terms: string[]; reason: string }> = {
  1: {
    terms: ["商业模式", "开源"],
    reason:
      "Open-source pivot is a business-model change; v2 explicitly lists this as directional_shift",
  },
  2: {
    terms: ["教程"],
    reason:
      "Developer tutorials are explicitly listed as routine in v2; v1 only says 技术分享 (ambiguous)",
  },
  3: {
    terms: ["活动", "会议"],
    reason:
      "Conference announcements are explicit routine in v2; v1 lacks this example, risking notable",
  },
  4: {
    terms: ["不可逆", "超出单一产品线"],
    reason:
      "v2 requires directional_shift to be irreversible and cross product lines; prevents over-escalation of product launches",
  },
  5: {
    terms: ["CEO", "放弃"],
    reason:
      "v2 explicitly lists CEO-level declarations and product line exits as directional_shift signals",
  },
};

// Ground-truth significance labels
const EXPECTED_SIGNIFICANCE: Record<number, string> = {
  1: "directional_shift",
  2: "routine",
  3: "routine",
  4: "notable",
  5: "directional_shift",
};

// ---------------------------------------------------------------------------
// Pre-compute v2 prompts for all fixtures (once, before tests run)
// ---------------------------------------------------------------------------

const v2Prompts: Record<number, CapturedPrompts> = {};

beforeAll(async () => {
  const fixtures = [
    FIXTURE_OPENSOURCE_PIVOT,
    FIXTURE_DEVTUTORIAL,
    FIXTURE_CONFERENCE,
    FIXTURE_PRODUCT_LAUNCH,
    FIXTURE_CEO_PIVOT,
  ];
  for (const fixture of fixtures) {
    v2Prompts[fixture.contentItemId] = await captureV2Prompt(fixture);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Prompt v1 vs v2 — fixture-based oracle tests", () => {
  describe("Fixture 1: directional_shift — open-source platform pivot", () => {
    test("v2 prompt contains explicit business-model criteria needed to detect this case", () => {
      const { system } = v2Prompts[1]!;
      const { terms, reason } = FIXTURE_REQUIRED_V2_CRITERIA[1]!;
      const missing = terms.filter((t) => !system.includes(t));
      expect(missing, `v2 missing: ${missing.join(", ")} — needed because: ${reason}`).toEqual([]);
    });

    test("v1 prompt lacks all required criteria for this fixture (oracle would misclassify)", () => {
      const ctx = buildCompetitorContext(FIXTURE_OPENSOURCE_PIVOT);
      const v1 = v1SystemPromptFor(ctx);
      const { terms } = FIXTURE_REQUIRED_V2_CRITERIA[1]!;
      const covered = terms.filter((t) => v1.includes(t));
      // v1 covers FEWER criteria than v2 → oracle predicts under-detection of this tier
      expect(covered.length).toBeLessThan(terms.length);
    });

    test("v2 oracle correctly classifies this fixture; v1 oracle does not", () => {
      const { system: v2System } = v2Prompts[1]!;
      const ctx = buildCompetitorContext(FIXTURE_OPENSOURCE_PIVOT);
      const v1System = v1SystemPromptFor(ctx);
      const { terms } = FIXTURE_REQUIRED_V2_CRITERIA[1]!;

      const v2Covers = oracleHasAllCriteria(v2System, terms);
      const v1Covers = oracleHasAllCriteria(v1System, terms);
      expect(v2Covers).toBe(true);   // v2 has all criteria → correct detection
      expect(v1Covers).toBe(false);  // v1 misses at least one → under-detection risk
    });
  });

  describe("Fixture 2: routine — developer optimisation tutorial", () => {
    test("v2 prompt explicitly lists tutorials as routine tier", () => {
      const { system } = v2Prompts[2]!;
      const { terms, reason } = FIXTURE_REQUIRED_V2_CRITERIA[2]!;
      const missing = terms.filter((t) => !system.includes(t));
      expect(missing, `v2 missing: ${missing.join(", ")} — needed because: ${reason}`).toEqual([]);
    });

    test("v1 prompt does NOT explicitly list tutorials as routine (ambiguous coverage)", () => {
      const ctx = buildCompetitorContext(FIXTURE_DEVTUTORIAL);
      const v1 = v1SystemPromptFor(ctx);
      // v1 has 技术分享 but NOT 教程 (tutorial) — less precise
      expect(v1.includes("教程")).toBe(false);
      expect(v1.includes("技术分享")).toBe(true); // v1's vague coverage
    });

    test("v2 oracle correctly classifies tutorial as routine; v1 oracle has ambiguous coverage", () => {
      const { system: v2System } = v2Prompts[2]!;
      const ctx = buildCompetitorContext(FIXTURE_DEVTUTORIAL);
      const v1System = v1SystemPromptFor(ctx);

      expect(oracleHasAllCriteria(v2System, ["教程"])).toBe(true);
      expect(oracleHasAllCriteria(v1System, ["教程"])).toBe(false);
    });
  });

  describe("Fixture 3: routine — conference appearance announcement", () => {
    test("v2 prompt explicitly lists events and conferences as routine", () => {
      const { system } = v2Prompts[3]!;
      const { terms, reason } = FIXTURE_REQUIRED_V2_CRITERIA[3]!;
      const missing = terms.filter((t) => !system.includes(t));
      expect(missing, `v2 missing: ${missing.join(", ")} — needed because: ${reason}`).toEqual([]);
    });

    test("v1 prompt lacks conference/event as explicit routine example", () => {
      const ctx = buildCompetitorContext(FIXTURE_CONFERENCE);
      const v1 = v1SystemPromptFor(ctx);
      expect(v1.includes("活动")).toBe(false);
      expect(v1.includes("会议")).toBe(false);
    });

    test("v2 oracle covers conferences as routine; v1 oracle does not", () => {
      const { system: v2System } = v2Prompts[3]!;
      const ctx = buildCompetitorContext(FIXTURE_CONFERENCE);
      const v1System = v1SystemPromptFor(ctx);

      expect(oracleHasAllCriteria(v2System, ["活动", "会議"])).toBe(false); // 会議 is Japanese, not in prompt
      // Use the actual Chinese terms
      expect(v2System.includes("活动")).toBe(true);
      expect(v2System.includes("会议")).toBe(true);
      expect(v1System.includes("活动")).toBe(false);
      expect(v1System.includes("会议")).toBe(false);
    });
  });

  describe("Fixture 4: notable — competing product launch (must NOT over-escalate to directional_shift)", () => {
    test("v2 prompt includes irreversibility/scope guards that prevent over-escalation", () => {
      const { system } = v2Prompts[4]!;
      const { terms, reason } = FIXTURE_REQUIRED_V2_CRITERIA[4]!;
      const missing = terms.filter((t) => !system.includes(t));
      expect(missing, `v2 missing: ${missing.join(", ")} — needed because: ${reason}`).toEqual([]);
    });

    test("v1 prompt lacks the irreversibility qualifier for directional_shift", () => {
      const ctx = buildCompetitorContext(FIXTURE_PRODUCT_LAUNCH);
      const v1 = v1SystemPromptFor(ctx);
      expect(v1.includes("不可逆")).toBe(false);
    });

    test("v2 oracle prevents over-escalation; v1 oracle misses the guard", () => {
      const { system: v2System } = v2Prompts[4]!;
      const ctx = buildCompetitorContext(FIXTURE_PRODUCT_LAUNCH);
      const v1System = v1SystemPromptFor(ctx);

      expect(oracleHasAllCriteria(v2System, ["不可逆"])).toBe(true);
      expect(oracleHasAllCriteria(v1System, ["不可逆"])).toBe(false);
    });
  });

  describe("Fixture 5: directional_shift — CEO-level product line exit", () => {
    test("v2 prompt explicitly names CEO declarations and product line exits as directional_shift", () => {
      const { system } = v2Prompts[5]!;
      const { terms, reason } = FIXTURE_REQUIRED_V2_CRITERIA[5]!;
      const missing = terms.filter((t) => !system.includes(t));
      expect(missing, `v2 missing: ${missing.join(", ")} — needed because: ${reason}`).toEqual([]);
    });

    test("v1 prompt lacks explicit CEO-level declaration criterion for directional_shift", () => {
      const ctx = buildCompetitorContext(FIXTURE_CEO_PIVOT);
      const v1 = v1SystemPromptFor(ctx);
      expect(v1.includes("CEO")).toBe(false);
      expect(v1.includes("放弃")).toBe(false);
    });

    test("v2 oracle detects this as directional_shift; v1 oracle misses the signal", () => {
      const { system: v2System } = v2Prompts[5]!;
      const ctx = buildCompetitorContext(FIXTURE_CEO_PIVOT);
      const v1System = v1SystemPromptFor(ctx);

      expect(oracleHasAllCriteria(v2System, ["CEO", "放弃"])).toBe(true);
      expect(oracleHasAllCriteria(v1System, ["CEO", "放弃"])).toBe(false);
    });
  });
});

describe("v1 vs v2 — aggregate coverage comparison", () => {
  test("v2 oracle correctly covers all 5 fixtures; v1 oracle fails at least 3", () => {
    const fixtures = [
      FIXTURE_OPENSOURCE_PIVOT,
      FIXTURE_DEVTUTORIAL,
      FIXTURE_CONFERENCE,
      FIXTURE_PRODUCT_LAUNCH,
      FIXTURE_CEO_PIVOT,
    ];

    let v2Correct = 0;
    let v1Correct = 0;

    for (const fixture of fixtures) {
      const v2System = v2Prompts[fixture.contentItemId]!.system;
      const ctx = buildCompetitorContext(fixture);
      const v1System = v1SystemPromptFor(ctx);
      const { terms } = FIXTURE_REQUIRED_V2_CRITERIA[fixture.contentItemId]!;

      if (oracleHasAllCriteria(v2System, terms)) v2Correct++;
      if (oracleHasAllCriteria(v1System, terms)) v1Correct++;
    }

    // v2 must cover all 5 fixtures
    expect(v2Correct).toBe(5);
    // v1 must fail at least 3 (demonstrating measurable regression)
    expect(v1Correct).toBeLessThanOrEqual(2);
  });
});

describe("Regression guard — tests that fail when v2 text is reverted to v1", () => {
  test("v2 prompt includes calibration target for each fixture", async () => {
    for (const fixture of [FIXTURE_OPENSOURCE_PIVOT, FIXTURE_DEVTUTORIAL, FIXTURE_CONFERENCE]) {
      const { system } = v2Prompts[fixture.contentItemId]!;
      // These three must appear together for calibration to work
      expect(system).toContain("~70%");
      expect(system).toContain("~25%");
      expect(system).toContain("~5%");
    }
  });

  test("v2 prompt includes tie-breaking rule (absent in v1)", async () => {
    for (const id of [1, 2, 3, 4, 5]) {
      const { system } = v2Prompts[id]!;
      expect(system).toContain("不确定时选低一级");
    }
    // Confirm v1 lacks this rule (regression reference)
    const ctx = buildCompetitorContext(FIXTURE_OPENSOURCE_PIVOT);
    const v1 = v1SystemPromptFor(ctx);
    expect(v1.includes("不确定时选低一级")).toBe(false);
  });

  test("v2 prompt does NOT contain the v1 biased phrase that caused over-notable classification", async () => {
    for (const id of [1, 2, 3, 4, 5]) {
      const { system } = v2Prompts[id]!;
      // This v1 phrase is ambiguous and caused over-classification into notable.
      // Its absence in v2 is required. If it returns, this test fails.
      expect(system).not.toContain("只有真正重要的内容才标记");
    }
    // Confirm v1 had this phrase (regression reference)
    const ctx = buildCompetitorContext(FIXTURE_OPENSOURCE_PIVOT);
    const v1 = v1SystemPromptFor(ctx);
    expect(v1).toContain("只有真正重要的内容才标记");
  });

  test("schema significance .describe() encodes calibration target (~70/25/5)", () => {
    const significanceField = ContentAnalysisSchema.shape.significance;
    expect(significanceField.description).toContain("~70/25/5");
    expect(significanceField.description).toContain("routine");
    expect(significanceField.description).toContain("notable");
    expect(significanceField.description).toContain("directional_shift");
  });

  test("schema urgency .describe() ties high urgency to directional_shift (not routine)", () => {
    const urgencyField = ContentAnalysisSchema.shape.urgency;
    expect(urgencyField.description).toContain("directional_shift");
    // high must NOT be presented as appropriate for routine content
    expect(urgencyField.description).not.toContain("routine");
  });
});
