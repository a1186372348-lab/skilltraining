import { describe, expect, it } from "vitest";

import {
  accountViewOf,
  buildProfilePayload,
  DEFAULT_DEV_EMAIL,
  EMPTY_PROFILE_STATE,
  isProfileSavable,
  profileSummaryRowsOf,
  toProfileFormState,
} from "./view-model";

// 我的页面（P6 /settings，T15）视图装配纯函数测试。
// 覆盖：画像预填映射（完整/缺省/脏数据防御）、账号卡 dev/真实身份分支、
// 保存载荷构造（空值丢弃）、必填校验、查看态摘要行。

describe("accountViewOf：dev/真实身份分支", () => {
  it("有会话时显示真实邮箱与已登录标识", () => {
    const view = accountViewOf({
      user: { id: "u1", email: "pm@example.com" },
      expiresAt: "2026-10-05T00:00:00.000Z",
    });
    expect(view).toEqual({
      email: "pm@example.com",
      isDev: false,
      badge: "已登录",
    });
  });

  it("无会话（开发态无 cookie）时回退为 dev 占位邮箱并显示 dev 标识", () => {
    const view = accountViewOf(null);
    expect(view.isDev).toBe(true);
    expect(view.email).toBe(DEFAULT_DEV_EMAIL);
    expect(view.badge).toContain("dev");
  });
});

describe("toProfileFormState：画像预填映射", () => {
  it("null/undefined 归一化为空表单", () => {
    expect(toProfileFormState(null)).toEqual(EMPTY_PROFILE_STATE);
    expect(toProfileFormState(undefined)).toEqual(EMPTY_PROFILE_STATE);
  });

  it("完整画像逐字段映射", () => {
    const state = toProfileFormState({
      position: "产品经理",
      yearsExperience: "3-5年",
      industry: "互联网/软件",
      projectExperience: "负责过一款工具类 App",
      familiarProducts: ["微信", "飞书"],
      interestAreas: ["AI 应用"],
      learningGoal: "提升方案设计能力",
      selfAssessment: ["问题定义", "用户理解"],
    });
    expect(state).toEqual({
      position: "产品经理",
      yearsExperience: "3-5年",
      industry: "互联网/软件",
      projectExperience: "负责过一款工具类 App",
      familiarProducts: ["微信", "飞书"],
      interestAreas: ["AI 应用"],
      learningGoal: "提升方案设计能力",
      selfAssessment: ["问题定义", "用户理解"],
    });
  });

  it("null 文本与缺省字段归一化为空串/空数组", () => {
    const state = toProfileFormState({
      position: "产品经理",
      projectExperience: null,
      learningGoal: null,
    });
    expect(state.position).toBe("产品经理");
    expect(state.projectExperience).toBe("");
    expect(state.learningGoal).toBe("");
    expect(state.familiarProducts).toEqual([]);
    expect(state.selfAssessment).toEqual([]);
  });

  it("防御脏数据：非字符串标量丢弃，数组内非字符串项过滤", () => {
    const state = toProfileFormState({
      position: 42,
      yearsExperience: ["1-3年"],
      familiarProducts: ["微信", 7, null, "钉钉"],
      selfAssessment: "问题定义",
    });
    expect(state.position).toBe("");
    expect(state.yearsExperience).toBe("");
    expect(state.familiarProducts).toEqual(["微信", "钉钉"]);
    expect(state.selfAssessment).toEqual([]);
  });
});

describe("buildProfilePayload：保存载荷构造", () => {
  it("空串与空数组不进入载荷，保持未填语义", () => {
    expect(buildProfilePayload(EMPTY_PROFILE_STATE)).toEqual({});
  });

  it("文本去空白，必填与已填字段全量进入载荷", () => {
    const payload = buildProfilePayload({
      ...EMPTY_PROFILE_STATE,
      position: "产品经理",
      yearsExperience: "1-3年",
      industry: "教育",
      projectExperience: "  做过增长项目  ",
      familiarProducts: ["微信"],
    });
    expect(payload).toEqual({
      position: "产品经理",
      yearsExperience: "1-3年",
      industry: "教育",
      projectExperience: "做过增长项目",
      familiarProducts: ["微信"],
    });
  });

  it("纯空白文本视为未填", () => {
    const payload = buildProfilePayload({
      ...EMPTY_PROFILE_STATE,
      learningGoal: "   ",
    });
    expect(payload).toEqual({});
  });
});

describe("isProfileSavable：必填三项", () => {
  it("职位/年限/行业任一缺失不可保存", () => {
    expect(isProfileSavable(EMPTY_PROFILE_STATE)).toBe(false);
    expect(
      isProfileSavable({ ...EMPTY_PROFILE_STATE, position: "产品经理" }),
    ).toBe(false);
    expect(
      isProfileSavable({
        ...EMPTY_PROFILE_STATE,
        position: "产品经理",
        yearsExperience: "1-3年",
      }),
    ).toBe(false);
  });

  it("三项齐备即可保存（幂等重试同一份载荷）", () => {
    expect(
      isProfileSavable({
        ...EMPTY_PROFILE_STATE,
        position: "产品经理",
        yearsExperience: "1-3年",
        industry: "教育",
      }),
    ).toBe(true);
  });
});

describe("profileSummaryRowsOf：查看态摘要行", () => {
  it("空画像各行显示未填写", () => {
    const rows = profileSummaryRowsOf(EMPTY_PROFILE_STATE);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.value).toBe("未填写");
  });

  it("多值字段以顿号连接，文本原样展示", () => {
    const rows = profileSummaryRowsOf({
      ...EMPTY_PROFILE_STATE,
      position: "产品经理",
      familiarProducts: ["微信", "飞书"],
      learningGoal: "提升取舍能力",
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["职位"]).toBe("产品经理");
    expect(byLabel["熟悉的产品"]).toBe("微信、飞书");
    expect(byLabel["学习目标"]).toBe("提升取舍能力");
    expect(byLabel["所在行业"]).toBe("未填写");
  });
});
