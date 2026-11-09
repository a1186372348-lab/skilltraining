// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RetestContext } from "./retest-context";

const mocks = vi.hoisted(() => ({ abandon: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("./api", () => ({ abandonSession: mocks.abandon }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("复测终止需确认，取消无请求；确认后保留触发并返回阶段页", async () => {
  mocks.abandon.mockResolvedValue({ sessionId: "session-a", state: "abandoned" });
  render(<RetestContext sessionId="session-a" canAbandon />);
  expect(screen.getByText(/复测验证.*未练题/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "终止本题" }));
  expect(screen.getByText(/已答内容与复测触发保留/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(mocks.abandon).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "终止本题" }));
  fireEvent.click(screen.getByRole("button", { name: "确认终止" }));
  await waitFor(() => expect(mocks.abandon).toHaveBeenCalledWith("session-a"));
  expect(mocks.push).toHaveBeenCalledWith("/stages");
});

it("已交终答不可终止，终止失败可见且不假装复测失败", async () => {
  const first = render(<RetestContext sessionId="session-a" canAbandon={false} />);
  expect(screen.queryByRole("button", { name: "终止本题" })).toBeNull();
  first.unmount();
  mocks.abandon.mockRejectedValue(new Error("当前已提交终答"));
  render(<RetestContext sessionId="session-a" canAbandon />);
  fireEvent.click(screen.getByRole("button", { name: "终止本题" }));
  fireEvent.click(screen.getByRole("button", { name: "确认终止" }));
  expect(await screen.findByText("当前已提交终答")).toBeTruthy();
  expect(mocks.push).not.toHaveBeenCalled();
  expect(screen.queryByText(/复测未通过/)).toBeNull();
});
