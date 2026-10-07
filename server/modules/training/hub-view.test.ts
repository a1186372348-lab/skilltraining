import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  getCurrentTrainingCard,
  HUB_SCORE_SUMMARY_LIMIT,
  hubSessionStage,
  resolveCurrentCard,
  toHubHistoryItem,
  type HubSessionRow,
} from "./hub-view";

// 产品训练大厅视图纯函数测试（T25 / D27）：
// 当前卡三态判定优先级（进行中 > 已完成 > 未开始）、进行中阶段映射（作答/追问/评分）、
// 历史行徽章字段与得分摘要映射（≤3 截断）、能力标签脏数据防御解析。

function row(overrides: Partial<HubSessionRow> = {}): HubSessionRow {
  return {
    id: "session-1",
    isExtra: false,
    state: "reading",
    finalSubmittedAt: null,
    startedAt: new Date(Date.UTC(2026, 9, 7, 8, 0)),
    question: { caseTitle: "案例一", abilityTags: ["用户理解", "根因分析"] },
    scores: [],
    ...overrides,
  };
}

describe("hubSessionStage：进行中会话的阶段映射（D27 状态机）", () => {
  it("reading / answering → 作答中", () => {
    expect(hubSessionStage("reading", false)).toBe("answering");
    expect(hubSessionStage("answering", false)).toBe("answering");
  });

  it("followup 未交终答 → 追问中", () => {
    expect(hubSessionStage("followup", false)).toBe("followup");
  });

  it("followup 已交终答（未评分）→ 评分中", () => {
    expect(hubSessionStage("followup", true)).toBe("scoring");
  });
});

describe("resolveCurrentCard：当前训练卡三态判定优先级", () => {
  it("存在未完成会话即「进行中」（即使今日 daily 已评分，进行中仍优先）", () => {
    const inProgress = row({ id: "s-doing", state: "followup", finalSubmittedAt: null });
    const completed = row({ id: "s-done", state: "scored", finalSubmittedAt: new Date() });
    expect(
      resolveCurrentCard({
        inProgress,
        todayDailyCompleted: completed,
        todayKey: "2026-10-07",
      }),
    ).toEqual({
      kind: "in_progress",
      sessionId: "s-doing",
      caseTitle: "案例一",
      stage: "followup",
    });
  });

  it("无未完成会话、今日 daily 已评分 →「已完成」（附 ≤3 条维度有效分摘要）", () => {
    const completed = row({
      id: "s-done",
      state: "scored",
      finalSubmittedAt: new Date(),
      scores: [
        { dimension: "用户理解", effectiveScore: 82 },
        { dimension: "根因分析", effectiveScore: 46 },
        { dimension: "指标与验证", effectiveScore: 90 },
        { dimension: "产品取舍", effectiveScore: 70 },
      ],
    });
    const card = resolveCurrentCard({
      inProgress: null,
      todayDailyCompleted: completed,
      todayKey: "2026-10-07",
    });
    expect(card.kind).toBe("completed");
    if (card.kind === "completed") {
      expect(card.sessionId).toBe("s-done");
      expect(card.scores).toHaveLength(HUB_SCORE_SUMMARY_LIMIT);
      expect(card.scores.map((score) => score.dimension)).toEqual([
        "用户理解",
        "根因分析",
        "指标与验证",
      ]);
    }
  });

  it("无未完成会话且无今日已完成 daily →「未开始」（携带今日日期键）", () => {
    expect(
      resolveCurrentCard({ inProgress: null, todayDailyCompleted: null, todayKey: "2026-10-07" }),
    ).toEqual({ kind: "not_started", dateKey: "2026-10-07" });
  });
});

describe("toHubHistoryItem：历史行映射", () => {
  it("每日/加练徽章字段、能力标签、终答标记与开始时间 ISO", () => {
    const item = toHubHistoryItem(
      row({ isExtra: true, state: "scored", finalSubmittedAt: new Date() }),
    );
    expect(item).toMatchObject({
      sessionId: "session-1",
      caseTitle: "案例一",
      isExtra: true,
      state: "scored",
      hasFinalAnswer: true,
      abilityTags: ["用户理解", "根因分析"],
      startedAt: "2026-10-07T08:00:00.000Z",
    });
  });

  it("未交终答 → hasFinalAnswer=false（前端据此区分追问中/评分中徽章）", () => {
    expect(toHubHistoryItem(row({ state: "followup" })).hasFinalAnswer).toBe(false);
  });

  it("得分摘要 ≤3 条截断；能力标签脏数据仅保留字符串", () => {
    const item = toHubHistoryItem(
      row({
        question: { caseTitle: "案例一", abilityTags: ["用户理解", 42, null, "根因分析"] },
        scores: [
          { dimension: "甲", effectiveScore: 60 },
          { dimension: "乙", effectiveScore: 70 },
          { dimension: "丙", effectiveScore: 80 },
          { dimension: "丁", effectiveScore: 90 },
        ],
      }),
    );
    expect(item.scores).toHaveLength(HUB_SCORE_SUMMARY_LIMIT);
    expect(item.scores.map((score) => score.dimension)).toEqual(["甲", "乙", "丙"]);
    expect(item.abilityTags).toEqual(["用户理解", "根因分析"]);
  });

  it("未评分会话 scores 为空（前端据此只显示时间）", () => {
    expect(toHubHistoryItem(row()).scores).toEqual([]);
  });
});

/**
 * getCurrentTrainingCard 查询层测试（T26 / D28②：首页与大厅共用同一数据源）。
 * 桩 DB 按 where.state 分流两查询：{ not: "scored" } → 最新未完成会话；"scored" → 今日已评分 daily。
 */
function stubCurrentCardDb(rows: {
  inProgress: HubSessionRow | null;
  todayDailyCompleted: HubSessionRow | null;
}): { db: PrismaClient; whereClauses: unknown[] } {
  const whereClauses: unknown[] = [];
  const db = {
    trainingSession: {
      findFirst: async (args: { where: { state: unknown } }) => {
        whereClauses.push(args.where);
        return args.where.state === "scored" ? rows.todayDailyCompleted : rows.inProgress;
      },
    },
  } as unknown as PrismaClient;
  return { db, whereClauses };
}

describe("getCurrentTrainingCard：查询层与三态装配（T26）", () => {
  it("存在未完成会话 →「进行中」；两个查询均经 question.kind=daily 排除基线", async () => {
    const { db, whereClauses } = stubCurrentCardDb({
      inProgress: row({ id: "s-doing", state: "answering" }),
      todayDailyCompleted: null,
    });
    const card = await getCurrentTrainingCard(db, "user-1");
    expect(card).toEqual({
      kind: "in_progress",
      sessionId: "s-doing",
      caseTitle: "案例一",
      stage: "answering",
    });
    // 查询层基线排除（D19/D26⑦ 同口径）：两个查询都带 question.kind="daily"
    expect(whereClauses).toHaveLength(2);
    for (const where of whereClauses) {
      expect(where).toMatchObject({ userId: "user-1", question: { kind: "daily" } });
    }
  });

  it("无未完成会话、今日 daily 已评分 →「已完成」（含得分摘要）", async () => {
    const { db } = stubCurrentCardDb({
      inProgress: null,
      todayDailyCompleted: row({
        id: "s-done",
        state: "scored",
        finalSubmittedAt: new Date(),
        scores: [{ dimension: "用户理解", effectiveScore: 82 }],
      }),
    });
    const card = await getCurrentTrainingCard(db, "user-1");
    expect(card).toEqual({
      kind: "completed",
      sessionId: "s-done",
      caseTitle: "案例一",
      scores: [{ dimension: "用户理解", effectiveScore: 82 }],
    });
  });

  it("均无 →「未开始」（dateKey 为今日 UTC 日期键）", async () => {
    const { db } = stubCurrentCardDb({ inProgress: null, todayDailyCompleted: null });
    const card = await getCurrentTrainingCard(db, "user-1");
    expect(card.kind).toBe("not_started");
    if (card.kind === "not_started") {
      expect(card.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
