import { describe, expect, it } from "vitest";

import { TrainingError } from "./errors";
import { nextState } from "./state-machine";

// 显式状态机（Prd.md 图 1 / R4）：reading → answering → followup → scored
// scored 由 T06 评分任务写入；T05 终答落库后停留在 followup。
describe("训练会话状态机：REQUEST_HINT", () => {
  it("reading → answering", () => {
    expect(nextState("reading", "REQUEST_HINT")).toBe("answering");
  });

  it("answering → answering（可连续请求提示）", () => {
    expect(nextState("answering", "REQUEST_HINT")).toBe("answering");
  });

  it("followup 拒绝（D7：首次提交后提示永久消失）", () => {
    expect(() => nextState("followup", "REQUEST_HINT")).toThrow(TrainingError);
    expect(() => nextState("followup", "REQUEST_HINT")).toThrowError(
      expect.objectContaining({ code: "HINT_DISABLED" }),
    );
  });

  it("scored 拒绝", () => {
    expect(() => nextState("scored", "REQUEST_HINT")).toThrowError(
      expect.objectContaining({ code: "HINT_DISABLED" }),
    );
  });
});

describe("训练会话状态机：SUBMIT_FIRST_ANSWER", () => {
  it("reading → followup（未请求提示直接作答）", () => {
    expect(nextState("reading", "SUBMIT_FIRST_ANSWER")).toBe("followup");
  });

  it("answering → followup", () => {
    expect(nextState("answering", "SUBMIT_FIRST_ANSWER")).toBe("followup");
  });

  it("followup / scored 拒绝（重复提交由服务层幂等处理，不进状态机）", () => {
    for (const state of ["followup", "scored"] as const) {
      expect(() => nextState(state, "SUBMIT_FIRST_ANSWER")).toThrowError(
        expect.objectContaining({ code: "FIRST_ANSWER_ALREADY_SUBMITTED" }),
      );
    }
  });
});

describe("训练会话状态机：SUBMIT_FINAL_ANSWER", () => {
  it("followup → followup（T05 终答落库后保持 followup，等 T06 评分）", () => {
    expect(nextState("followup", "SUBMIT_FINAL_ANSWER")).toBe("followup");
  });

  it("reading / answering 拒绝（必须先提交首答）", () => {
    for (const state of ["reading", "answering"] as const) {
      expect(() => nextState(state, "SUBMIT_FINAL_ANSWER")).toThrowError(
        expect.objectContaining({ code: "FIRST_ANSWER_REQUIRED" }),
      );
    }
  });

  it("scored 拒绝（已评分会话不可再提交）", () => {
    expect(() => nextState("scored", "SUBMIT_FINAL_ANSWER")).toThrowError(
      expect.objectContaining({ code: "SESSION_ALREADY_SCORED" }),
    );
  });
});

describe("训练会话状态机：MARK_SCORED（T06 接入点）", () => {
  it("followup → scored", () => {
    expect(nextState("followup", "MARK_SCORED")).toBe("scored");
  });

  it("其他状态拒绝（未终答不可评分；已评分不可重复评分）", () => {
    for (const state of ["reading", "answering", "scored"] as const) {
      expect(() => nextState(state, "MARK_SCORED")).toThrow(TrainingError);
    }
  });
});

describe("训练会话状态机：ABANDON（T38 / D40 训练终止）", () => {
  it("reading / answering / followup → abandoned（未提交终答的日常会话可终止）", () => {
    for (const state of ["reading", "answering", "followup"] as const) {
      expect(nextState(state, "ABANDON")).toBe("abandoned");
    }
  });

  it("scored 拒绝（已评分终态不可终止）", () => {
    expect(() => nextState("scored", "ABANDON")).toThrowError(
      expect.objectContaining({ code: "SESSION_ALREADY_SCORED" }),
    );
  });

  it("abandoned 拒绝（终止态为终态，不可重复进入状态机）", () => {
    expect(() => nextState("abandoned", "ABANDON")).toThrow(TrainingError);
  });
});
