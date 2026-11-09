// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import StagesPage from "./page";
vi.mock("@/app/training/session/shell", () => ({ TodayShell: ({ children, activeLabel }: { children: React.ReactNode; activeLabel: string }) => <main>{activeLabel}{children}</main> }));
vi.mock("./stage-flow", () => ({ StageFlow: () => <div>阶段内容</div> }));
afterEach(cleanup);
it("阶段页使用带成长导航高亮的实际外壳", () => {
  render(<StagesPage />);
  expect(screen.getByText("成长阶段")).toBeTruthy();
  expect(screen.getByText("阶段内容")).toBeTruthy();
});
