import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toTodayView } from "./today-view";
import {
  getOrCreateTodaySession,
  requestHint,
  submitFinalAnswer,
  submitFirstAnswer,
} from "./service";

// 端到端（mock AI）会话链路验证：今日题 → 提示 → 首答（追问）→ 终答，
// 覆盖 Prd.md 图 1 中 T05 负责的全部服务端环节；AI 追问注入假实现，不出网。

const prisma = new PrismaClient();
const SEED_QUESTION_ID = "00000000-0000-4000-8000-0000000000a1";
let userId: string;

// 全量规范种子数据：各测试文件共用同一题目 id，upsert 保证跨文件并发播种结果一致
const SEED_QUESTION_DATA = {
  id: SEED_QUESTION_ID,
  caseTitle: "T05 集成测试种子题",
  caseBackground: { product: "测试产品", audience: "测试用户", scenario: "测试场景" },
  mainQuestion: "测试主问题？",
  abilityTags: ["用户理解", "产品价值判断", "产品取舍"],
  difficulty: 2,
  rubric: {
    dimensions: {
      用户理解: ["绝密要点1", "绝密要点2", "绝密要点3"],
      产品价值判断: ["绝密要点1", "绝密要点2", "绝密要点3"],
      产品取舍: ["绝密要点1", "绝密要点2", "绝密要点3"],
    },
    forbidden_leaks: ["绝密结论"],
  },
  hintTree: [1, 2, 3, 4, 5].map((level) => ({
    level,
    stage: `阶段${level}`,
    question: `第${level}层提示`,
  })),
  materials: {
    core: [
      { title: "核心1", source: "测试来源", url: "https://example.com/core-1", summary: "核心摘要1" },
      { title: "核心2", source: "测试来源", url: "https://example.com/core-2", summary: "核心摘要2" },
    ],
    extended: [
      { title: "扩展1", source: "测试来源", url: "https://example.com/ext-1", summary: "扩展摘要1" },
      { title: "扩展2", source: "测试来源", url: "https://example.com/ext-2", summary: "扩展摘要2" },
      { title: "扩展3", source: "测试来源", url: "https://example.com/ext-3", summary: "扩展摘要3" },
    ],
  },
  status: "published" as const,
};

async function ensureSeedQuestion(): Promise<void> {
  const { id, ...data } = SEED_QUESTION_DATA;
  try {
    // 共享开发库已导入真实上架题：先下架本种子外的全部上架题，选题结果才确定命中本种子
    await prisma.question.updateMany({
      where: { status: "published", id: { not: id } },
      data: { status: "archived" },
    });
    await prisma.question.upsert({ where: { id }, create: SEED_QUESTION_DATA, update: data });
  } catch {
    // 并发播种冲突：忽略，题目已存在
  }
}

beforeAll(async () => {
  await ensureSeedQuestion();
  const user = await prisma.user.create({
    data: { email: `t05-e2e-${randomUUID()}@example.com` },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } }); // 级联清理会话与提示事件
  await prisma.$disconnect();
});

describe("T05 端到端会话链路（mock AI）", () => {
  it("今日题 → 2 层提示 → 首答+追问 → 终答，全链路落库且视图无 Rubric 泄露", async () => {
    // 1. 今日题：创建会话（reading），视图不含 Rubric 与未释放提示
    const { session, question } = await getOrCreateTodaySession(prisma, userId);
    expect(question.id).toBe(SEED_QUESTION_ID);
    const initialView = toTodayView(session, question);
    expect(initialView.state).toBe("reading");
    expect(initialView.coefficient).toBe(1.0);
    expect(JSON.stringify(initialView)).not.toContain("绝密");

    // 2. 请求 2 层提示：系数 1.0 → 0.9 → 0.8，事件落库
    const hint1 = await requestHint(prisma, session.id, userId);
    const hint2 = await requestHint(prisma, session.id, userId);
    expect([hint1.coefficient, hint2.coefficient]).toEqual([0.9, 0.8]);

    // 3. 提交首答（mock 追问 2 轮）：状态 followup，追问落库，提示永久禁用
    const first = await submitFirstAnswer(prisma, session.id, userId, "端到端首答：Agent 是质变，因为接管了任务闭环。", {
      generateFollowups: async () => ["「接管任务闭环」的衡量证据是什么？", "如果反方认为这只是功能叠加，最有力的反驳是什么？"],
    });
    expect(first.state).toBe("followup");
    expect(first.followups).toHaveLength(2);
    expect(first.coefficient).toBe(0.8); // 提示 2 次后的系数
    await expect(requestHint(prisma, session.id, userId)).rejects.toMatchObject({
      code: "HINT_DISABLED",
    });

    // 4. 提交终答：落库 + 时间戳，状态保持 followup（等 T06 评分）
    const final = await submitFinalAnswer(
      prisma,
      session.id,
      userId,
      "端到端终答：补充证据与反驳后深化的判断。",
    );
    expect(final.state).toBe("followup");

    // 5. 刷新恢复（R4）：回读视图，进度完整可恢复，仍无泄露
    const restored = await prisma.trainingSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { question: true },
    });
    const view = toTodayView(restored, restored.question);
    expect(view.state).toBe("followup");
    expect(view.hintCount).toBe(2);
    expect(view.releasedHints.map((h) => h.level)).toEqual([1, 2]);
    expect(view.canRequestHint).toBe(false);
    expect(view.firstAnswer).toContain("端到端首答");
    expect(view.finalAnswer).toContain("端到端终答");
    expect(view.followups.map((f) => f.round)).toEqual([1, 2]);
    expect(JSON.stringify(view)).not.toContain("绝密");

    const events = await prisma.hintEvent.findMany({ where: { sessionId: session.id } });
    expect(events).toHaveLength(2);
  });
});
