import { describe, expect, it } from "vitest";

import {
  baselineProgressResponseSchema,
  baselineStatusResponseSchema,
  toBaselineProgressResponse,
  toBaselineStatusResponse,
} from "./schemas";
import type { BaselineStatus } from "./service";

// status 响应契约单测（T27 切片 1）：schema 校验 + 映射函数的 FR-10 出口防线
//（内部信息不下发；required / completedAt 语义保持兼容）。

function makeStatus(overrides: Partial<BaselineStatus> = {}): BaselineStatus {
  return {
    required: true,
    total: 2,
    answeredCount: 1,
    doneCount: 0,
    nextQuestion: null,
    completedAt: null,
    pendingScoringSessionIds: ["s-internal-1"],
    items: [],
    scoringPending: false,
    dimensionPreview: null,
    ...overrides,
  } as BaselineStatus;
}

describe("baselineStatusResponseSchema：status 响应契约校验", () => {
  it("合法载荷通过", () => {
    const payload = {
      required: true,
      total: 2,
      answeredCount: 1,
      doneCount: 0,
      nextQuestion: { id: "q-1", caseTitle: "基线题一" },
      completedAt: null,
    };
    expect(baselineStatusResponseSchema.parse(payload)).toEqual(payload);
  });

  it("缺字段 / 类型错误拒绝（快速失败）", () => {
    expect(() =>
      baselineStatusResponseSchema.parse({ required: true, total: 2 }),
    ).toThrow();
    expect(() =>
      baselineStatusResponseSchema.parse({
        required: true,
        total: 2,
        answeredCount: 1,
        doneCount: 0,
        nextQuestion: null,
        completedAt: new Date(), // 必须 ISO 字符串
      }),
    ).toThrow();
  });
});

describe("toBaselineStatusResponse：服务层状态 → 响应载荷", () => {
  it("nextQuestion 只含 id 与标题（FR-10 白名单）；pendingScoringSessionIds 绝不下发", () => {
    const status = makeStatus({
      nextQuestion: { id: "q-1", caseTitle: "基线题一", rubric: { 绝密: true } } as never,
    });
    const payload = toBaselineStatusResponse(status);
    expect(payload.nextQuestion).toEqual({ id: "q-1", caseTitle: "基线题一" });
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("rubric");
    expect(raw).not.toContain("s-internal-1");
    expect(raw).not.toContain("pendingScoringSessionIds");
  });

  it("completedAt 映射为 ISO 字符串；null 保持 null", () => {
    const marker = new Date("2026-10-22T08:00:00.000Z");
    expect(toBaselineStatusResponse(makeStatus({ completedAt: marker })).completedAt).toBe(
      "2026-10-22T08:00:00.000Z",
    );
    expect(toBaselineStatusResponse(makeStatus()).completedAt).toBeNull();
  });
});

describe("baselineProgressResponseSchema：逐题进度契约（T27 切片 3，FR-10 白名单）", () => {
  const canonical = {
    required: true,
    total: 9,
    answeredCount: 3,
    doneCount: 2,
    nextQuestion: { id: "d0-b", caseTitle: "基线题" },
    completedAt: null,
    items: [
      { questionId: "d0-a", dimension: "问题定义", orderIndex: 0, state: "scored", isDeepen: false },
      { questionId: "d0-b", dimension: "问题定义", orderIndex: 1, state: "active", isDeepen: true },
      { questionId: "d1-a", dimension: null, orderIndex: 2, state: "pending", isDeepen: false },
    ],
    resume: { hasInProgress: true, questionId: "d0-b", dimension: "问题定义", scoringPending: true },
    dimensionPreview: null,
  };

  it("合法载荷通过；state 非枚举值拒绝；items 缺字段拒绝", () => {
    expect(baselineProgressResponseSchema.parse(canonical)).toEqual(canonical);
    expect(() =>
      baselineProgressResponseSchema.parse({
        ...canonical,
        items: [{ ...canonical.items[0], state: "judging" }],
      }),
    ).toThrow();
    expect(() =>
      baselineProgressResponseSchema.parse({
        ...canonical,
        items: [{ questionId: "d0-a" }],
      }),
    ).toThrow();
  });

  it("白名单防线：item 携带 rubric / hintTree / forbiddenLeaks 等多余键一律剥除（zod strip）", () => {
    const poisoned = {
      ...canonical,
      items: [
        {
          ...canonical.items[0],
          rubric: { dimensions: { 问题定义: ["绝密要点"] } },
          hintTree: [{ level: 1, question: "绝密提示" }],
          forbidden_leaks: ["绝密结论"],
        },
      ],
    };
    const parsed = baselineProgressResponseSchema.parse(poisoned);
    const raw = JSON.stringify(parsed);
    expect(raw).not.toContain("绝密要点");
    expect(raw).not.toContain("绝密提示");
    expect(raw).not.toContain("绝密结论");
    expect(parsed.items[0]).toEqual(canonical.items[0]);
  });
});

describe("toBaselineProgressResponse：服务层状态 → 逐题进度载荷", () => {
  it("resume 派生：进行中 hasInProgress + 当前题与维度 + scoringPending；未开始 hasInProgress=false", () => {
    const status = {
      required: true,
      total: 9,
      answeredCount: 2,
      doneCount: 1,
      nextQuestion: { id: "d0-b", caseTitle: "基线题", rubric: "绝不外发" } as never,
      completedAt: null,
      pendingScoringSessionIds: ["s-pending-1"],
      scoringPending: true,
      dimensionPreview: null,
      items: [
        { questionId: "d0-a", dimension: "问题定义", orderIndex: 0, state: "scored" as const, isDeepen: false },
        { questionId: "d0-b", dimension: "问题定义", orderIndex: 1, state: "active" as const, isDeepen: true },
      ],
    } as unknown as BaselineStatus;
    const payload = toBaselineProgressResponse(status);
    expect(payload.resume).toEqual({
      hasInProgress: true,
      questionId: "d0-b",
      dimension: "问题定义",
      scoringPending: true,
    });
    expect(payload.dimensionPreview).toBeNull();
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("绝不外发");
    expect(raw).not.toContain("s-pending-1");
    expect(raw).not.toContain("pendingScoringSessionIds");

    const fresh = toBaselineProgressResponse({ ...status, answeredCount: 0, scoringPending: false } as never);
    expect(fresh.resume.hasInProgress).toBe(false);
  });

  it("完成后：resume.questionId 为 null，dimensionPreview 原样下发（八维含未知 null）", () => {
    const preview = [
      { dimension: "问题定义", effectiveScore: 72.5 },
      { dimension: "用户理解", effectiveScore: null },
    ];
    const payload = toBaselineProgressResponse({
      required: false,
      total: 8,
      answeredCount: 8,
      doneCount: 8,
      nextQuestion: null,
      completedAt: new Date("2026-10-22T08:00:00Z"),
      pendingScoringSessionIds: [],
      scoringPending: false,
      dimensionPreview: preview,
      items: [],
    } as never);
    expect(payload.resume).toEqual({ hasInProgress: false, questionId: null, dimension: null, scoringPending: false });
    expect(payload.dimensionPreview).toEqual(preview);
    expect(payload.completedAt).toBe("2026-10-22T08:00:00.000Z");
  });
});
