import { expect, it, vi } from "vitest";
import PackPage from "./page";

vi.mock("./pack-flow", () => ({ PackFlow: () => null }));

it("包详情路由将地址中的包 ID 传给交互页面", async () => {
  const page = await PackPage({ params: Promise.resolve({ id: "pack-1" }) });
  expect(page.props.packId).toBe("pack-1");
});
