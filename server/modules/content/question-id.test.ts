import { describe, expect, it } from "vitest";

import { questionUuid, uuidV5 } from "./question-id.ts";

describe("question-id：内容 id 到数据库 uuid 的确定性映射", () => {
  it("uuidV5 符合 RFC 4122 标准向量（DNS 命名空间 python.org）", () => {
    // RFC 4122 附录 B 公开测试向量
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("同一内容 id 多次生成结果一致（幂等导入的前提）", () => {
    expect(questionUuid("Q01")).toBe(questionUuid("Q01"));
  });

  it("生成结果为合法 uuid 文本（version 5）", () => {
    const id = questionUuid("Q01");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("非法命名空间直接报错（防配置笔误静默产出错误主键）", () => {
    expect(() => uuidV5("Q01", "不是uuid")).toThrow(/非法 uuid 命名空间/);
  });

  it("不同内容 id 生成不同 uuid", () => {
    expect(questionUuid("Q01")).not.toBe(questionUuid("Q02"));
  });
});
