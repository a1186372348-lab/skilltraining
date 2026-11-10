import type { PrismaClient } from "@prisma/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ score: vi.fn(), resolve: vi.fn() }));
vi.mock("./rubric-scorer.ts", () => ({ scoreWithRubric: mocks.score }));
vi.mock("@/server/ai/prompts/resolver", () => ({ resolvePromptTemplates: mocks.resolve }));
import { scoreSession } from "./service";

it("passes the deadline to the real scoring path without changing the scorer input", async () => {
  const templates = { system: "system", user: "user" };
  mocks.resolve.mockResolvedValue(templates);
  mocks.score.mockRejectedValue(new Error("expected stop"));
  const db = {
    trainingSession: { findUnique: vi.fn(async () => ({
      id: "s", userId: "u", state: "followup", sourceType: "daily", finalAnswer: "final",
      finalSubmittedAt: new Date(), firstAnswer: "first", followups: [],
      question: { abilityTags: ["问题定义"], mainQuestion: "问题", rubric: { dimensions: { 问题定义: ["标准"] } } },
    })) },
    score: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
  await expect(scoreSession(db, "s", "u", { deadlineMs: 12345 })).rejects.toThrow("expected stop");
  expect(mocks.score).toHaveBeenCalledWith(expect.not.objectContaining({ deadlineMs: expect.anything() }), { templates, deadlineMs: 12345 });
});
