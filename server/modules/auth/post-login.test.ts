import { describe, expect, it } from "vitest";

import type { PrismaClient, Question } from "@prisma/client";

import { resolvePostLoginPath } from "./post-login";

// 登录落点分发（首登链路：问卷 → 基线 → 画像揭晓）单元测试：桩 DB（不触真实数据库）。
// 桩定方式与 server/modules/baseline/service.test.ts 一致：基线门禁依赖 questions 表
// 全局状态，多文件并行共享测试库时互相干扰，分发分支逻辑用桩即可确定性验证。

/** 最小基线题行（仅需 id 等关键字段） */
function makeQuestion(id: string): Question {
  return { id, caseTitle: `基线题 ${id}`, status: "published", kind: "baseline" } as unknown as Question;
}

const Q1 = makeQuestion("00000000-0000-4000-8000-0000000000b1");
const Q2 = makeQuestion("00000000-0000-4000-8000-0000000000b2");

interface StubConfig {
  /** userProfile.findUnique 返回（无画像行传 null） */
  profile: { baselineCompletedAt: Date | null } | null;
  /** question.findMany 返回（上架基线题池） */
  baselineQuestions: Question[];
  /** 用户已评分基线会话的题目 id 列表 */
  scoredQuestionIds: string[];
}

function makeDb(config: StubConfig) {
  const calls = { questionFindManyCount: 0 };
  const db = {
    userProfile: {
      findUnique: async () => config.profile,
      updateMany: async () => ({ count: config.profile ? 1 : 0 }),
    },
    question: {
      findMany: async () => {
        calls.questionFindManyCount += 1;
        return config.baselineQuestions;
      },
    },
    trainingSession: {
      findMany: async () => config.scoredQuestionIds.map((questionId) => ({ questionId })),
    },
  } as unknown as PrismaClient;
  return { db, calls };
}

describe("resolvePostLoginPath：登录后按状态分发（首登链路：问卷 → 基线 → 首页）", () => {
  it("无画像行（问卷未完成）→ /onboarding，且短路不查基线状态", async () => {
    const { db, calls } = makeDb({ profile: null, baselineQuestions: [Q1, Q2], scoredQuestionIds: [] });
    await expect(resolvePostLoginPath(db, "u-1")).resolves.toBe("/onboarding");
    expect(calls.questionFindManyCount).toBe(0);
  });

  it("有画像行但基线未完成 → /baseline", async () => {
    const { db } = makeDb({
      profile: { baselineCompletedAt: null },
      baselineQuestions: [Q1, Q2],
      scoredQuestionIds: [Q1.id],
    });
    await expect(resolvePostLoginPath(db, "u-1")).resolves.toBe("/baseline");
  });

  it("有画像行且基线全部评完 → /（首页）", async () => {
    const { db } = makeDb({
      profile: { baselineCompletedAt: null },
      baselineQuestions: [Q1, Q2],
      scoredQuestionIds: [Q1.id, Q2.id],
    });
    await expect(resolvePostLoginPath(db, "u-1")).resolves.toBe("/");
  });

  it("有画像行且基线完成标记已存在 → /（首页）", async () => {
    const { db } = makeDb({
      profile: { baselineCompletedAt: new Date("2026-10-04T00:00:00Z") },
      baselineQuestions: [Q1, Q2],
      scoredQuestionIds: [],
    });
    await expect(resolvePostLoginPath(db, "u-1")).resolves.toBe("/");
  });

  it("有画像行但题库无上架基线题：required=false 天然回退 /（首页）", async () => {
    const { db } = makeDb({
      profile: { baselineCompletedAt: null },
      baselineQuestions: [],
      scoredQuestionIds: [],
    });
    await expect(resolvePostLoginPath(db, "u-1")).resolves.toBe("/");
  });
});
