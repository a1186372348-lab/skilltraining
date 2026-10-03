import { describe, expect, it } from "vitest";

import {
  ABILITY_DIMENSIONS,
  profileDraftSchema,
  profileSubmitSchema,
} from "./schema";

// 合法输入样例：8 个契约字段全填
const validInput = {
  position: "产品经理",
  yearsExperience: "1-3年",
  industry: "互联网/软件",
  projectExperience: "负责过一款工具类 App 的从 0 到 1。",
  familiarProducts: ["飞书", "Notion"],
  interestAreas: ["AI 应用", "效率工具"],
  learningGoal: "提升方案设计能力",
  selfAssessment: ["问题定义", "方案设计"],
};

describe("profileSubmitSchema：提交校验", () => {
  it("接受完整合法输入，并对字符串 trim、数组去重去空", () => {
    const result = profileSubmitSchema.safeParse({
      ...validInput,
      position: "  产品经理  ",
      familiarProducts: ["飞书", " 飞书 ", "", "Notion"],
      selfAssessment: ["问题定义", "问题定义", "方案设计"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.position).toBe("产品经理");
      expect(result.data.familiarProducts).toEqual(["飞书", "Notion"]);
      expect(result.data.selfAssessment).toEqual(["问题定义", "方案设计"]);
    }
  });

  it("接受仅必填字段的输入，可选项缺省为 undefined，多值缺省为空数组", () => {
    const result = profileSubmitSchema.safeParse({
      position: "产品经理",
      yearsExperience: "0-1年",
      industry: "教育",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectExperience).toBeUndefined();
      expect(result.data.learningGoal).toBeUndefined();
      expect(result.data.familiarProducts).toEqual([]);
      expect(result.data.interestAreas).toEqual([]);
      expect(result.data.selfAssessment).toEqual([]);
    }
  });

  it.each(["position", "yearsExperience", "industry"])(
    "缺少必填字段 %s 时拒绝",
    (field) => {
      const body = { ...validInput } as Record<string, unknown>;
      delete body[field];
      expect(profileSubmitSchema.safeParse(body).success).toBe(false);
    },
  );

  it.each(["position", "yearsExperience", "industry"])(
    "必填字段 %s 为空白字符串时拒绝",
    (field) => {
      expect(
        profileSubmitSchema.safeParse({ ...validInput, [field]: "   " })
          .success,
      ).toBe(false);
    },
  );

  it("拒绝超长字段（职位 >50、项目经验 >300、学习目标 >200）", () => {
    expect(
      profileSubmitSchema.safeParse({
        ...validInput,
        position: "x".repeat(51),
      }).success,
    ).toBe(false);
    expect(
      profileSubmitSchema.safeParse({
        ...validInput,
        projectExperience: "x".repeat(301),
      }).success,
    ).toBe(false);
    expect(
      profileSubmitSchema.safeParse({
        ...validInput,
        learningGoal: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  it("多值字段：非数组、非字符串元素、超数量、元素超长均拒绝", () => {
    expect(
      profileSubmitSchema.safeParse({ ...validInput, familiarProducts: "飞书" })
        .success,
    ).toBe(false);
    expect(
      profileSubmitSchema.safeParse({
        ...validInput,
        familiarProducts: ["飞书", 42],
      }).success,
    ).toBe(false);
    expect(
      profileSubmitSchema.safeParse({
        ...validInput,
        familiarProducts: Array.from({ length: 11 }, (_, i) => `产品${i}`),
      }).success,
    ).toBe(false);
    expect(
      profileSubmitSchema.safeParse({
        ...validInput,
        familiarProducts: ["x".repeat(51)],
      }).success,
    ).toBe(false);
  });

  it("自评方向仅接受 8 个一级维度内的值", () => {
    expect(ABILITY_DIMENSIONS).toHaveLength(8);
    expect(
      profileSubmitSchema.safeParse({
        ...validInput,
        selfAssessment: ["不存在的维度"],
      }).success,
    ).toBe(false);
  });

  it("可选字符串字段传入空串时归一化为 undefined", () => {
    const result = profileSubmitSchema.safeParse({
      ...validInput,
      projectExperience: "   ",
      learningGoal: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectExperience).toBeUndefined();
      expect(result.data.learningGoal).toBeUndefined();
    }
  });

  it("拒绝非对象输入", () => {
    expect(profileSubmitSchema.safeParse(null).success).toBe(false);
    expect(profileSubmitSchema.safeParse("问卷").success).toBe(false);
  });
});

describe("profileDraftSchema：草稿校验（全部字段可缺省）", () => {
  it("接受空对象", () => {
    expect(profileDraftSchema.safeParse({}).success).toBe(true);
  });

  it("接受只填部分字段的草稿", () => {
    const result = profileDraftSchema.safeParse({
      position: "产品经理",
      familiarProducts: ["飞书"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.position).toBe("产品经理");
      expect(result.data.industry).toBeUndefined();
    }
  });

  it("字段值非法时仍拒绝（防止脏草稿落库）", () => {
    expect(
      profileDraftSchema.safeParse({ position: "x".repeat(51) }).success,
    ).toBe(false);
    expect(
      profileDraftSchema.safeParse({ familiarProducts: "飞书" }).success,
    ).toBe(false);
  });
});
