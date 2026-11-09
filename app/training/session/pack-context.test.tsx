// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PackContext } from "./pack-context";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), abandon: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("../pack/api", () => ({ fetchPack: mocks.fetch, abandonPackSession: mocks.abandon }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("工作台标明包来源和进度，取消终止不写入，确认才放弃整包", async () => {
  mocks.fetch.mockResolvedValue({ id: "pack", dimension: "问题定义", items: [{ state: "scored", sessionId: "old", orderIndex: 0 }, { state: "in_progress", sessionId: "session", orderIndex: 1 }] });
  mocks.abandon.mockResolvedValue({ state: "abandoned" });
  render(<PackContext packId="pack" sessionId="session" canAbandon />);
  expect(await screen.findByText(/问题定义 · 第 2\/5 题/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "终止本题" }));
  expect(screen.getByText(/终止本题会放弃整个训练包，已答内容与评分保留/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(mocks.abandon).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "终止本题" }));
  fireEvent.click(screen.getByRole("button", { name: "确认终止" }));
  await waitFor(() => expect(mocks.abandon).toHaveBeenCalledWith("session"));
  expect(mocks.push).toHaveBeenCalledWith("/training");
});

it("已交终答时不提供终止入口，包进度加载失败时仍说明来源", async () => {
  mocks.fetch.mockRejectedValue(new Error("暂时不可用"));
  render(<PackContext packId="pack" sessionId="session" canAbandon={false} />);
  expect(await screen.findByText(/专项训练包 · 进度暂不可用/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "终止本题" })).toBeNull();
});
