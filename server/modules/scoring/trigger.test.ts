import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { triggerSessionScoring } from "./trigger";

const db = {} as PrismaClient;
const scheduleTask = () => {
  const tasks: Array<() => Promise<void>> = [];
  return { tasks, schedule: (task: () => Promise<void>) => { tasks.push(task); } };
};

describe("评分任务领取", () => {
  it("只有成功领取的任务可以评分，并在完成后释放其令牌", async () => {
    const { tasks, schedule } = scheduleTask();
    const scoreSession = vi.fn().mockResolvedValue(undefined);
    const acquireLease = vi.fn().mockResolvedValue("owner-token");
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    triggerSessionScoring(db, "s1", "u1", { schedule, scoreSession, acquireLease, releaseLease });
    expect(acquireLease).not.toHaveBeenCalled();
    await tasks[0]!();
    expect(acquireLease).toHaveBeenCalledWith(db, "s1", "u1");
    expect(scoreSession).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledWith(db, "s1", "u1", "owner-token");
  });

  it("已被其他实例领取时不调用评分或释放", async () => {
    const { tasks, schedule } = scheduleTask();
    const scoreSession = vi.fn();
    const releaseLease = vi.fn();
    triggerSessionScoring(db, "s2", "u1", { schedule, scoreSession, acquireLease: vi.fn().mockResolvedValue(null), releaseLease });
    await tasks[0]!();
    expect(scoreSession).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("评分失败时释放令牌并允许下次重试", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tasks, schedule } = scheduleTask();
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    const deps = { schedule, scoreSession: vi.fn().mockRejectedValue(new Error("failure")), acquireLease: vi.fn().mockResolvedValue("token"), releaseLease };
    triggerSessionScoring(db, "s3", "u1", deps);
    await tasks[0]!();
    expect(releaseLease).toHaveBeenCalledOnce();
    triggerSessionScoring(db, "s3", "u1", deps);
    expect(tasks).toHaveLength(2);
    log.mockRestore();
  });

  it("领取失败和释放失败均记录错误，且不阻止后续调度", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tasks, schedule } = scheduleTask();
    const scoreSession = vi.fn().mockResolvedValue(undefined);
    const acquireLease = vi.fn().mockRejectedValueOnce(new Error("db")).mockResolvedValue("token");
    const releaseLease = vi.fn().mockRejectedValue(new Error("db"));
    const deps = { schedule, scoreSession, acquireLease, releaseLease };
    triggerSessionScoring(db, "s4", "u1", deps);
    await tasks[0]!();
    expect(scoreSession).not.toHaveBeenCalled();
    triggerSessionScoring(db, "s4", "u1", deps);
    await tasks[1]!();
    triggerSessionScoring(db, "s4", "u1", deps);
    expect(tasks).toHaveLength(3);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("同一进程内在调度和执行期间只调度一次", async () => {
    const { tasks, schedule } = scheduleTask();
    let finish!: () => void;
    const scoreSession = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const deps = { schedule, scoreSession, acquireLease: vi.fn().mockResolvedValue("token"), releaseLease: vi.fn().mockResolvedValue(undefined) };
    triggerSessionScoring(db, "s5", "u1", deps);
    triggerSessionScoring(db, "s5", "u1", deps);
    expect(tasks).toHaveLength(1);
    const running = tasks[0]!();
    await vi.waitFor(() => expect(scoreSession).toHaveBeenCalledOnce());
    triggerSessionScoring(db, "s5", "u1", deps);
    expect(tasks).toHaveLength(1);
    finish();
    await running;
    triggerSessionScoring(db, "s5", "u1", deps);
    expect(tasks).toHaveLength(2);
  });

  it("默认路径未能访问数据库时不会绕过领取直接评分", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tasks, schedule } = scheduleTask();
    const scoreSession = vi.fn().mockResolvedValue(undefined);
    triggerSessionScoring(db, "s6", "u1", { schedule, scoreSession });
    await tasks[0]!();
    expect(scoreSession).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("调度器异常后可重新调度", () => {
    expect(() => triggerSessionScoring(db, "s7", "u1", { schedule: () => { throw new Error("schedule"); } })).toThrow("schedule");
    const { tasks, schedule } = scheduleTask();
    triggerSessionScoring(db, "s7", "u1", { schedule });
    expect(tasks).toHaveLength(1);
  });

  it("未注入调度器时后台启动并透传评分依赖", async () => {
    const scoreWithRubric = vi.fn();
    const scoreSession = vi.fn().mockResolvedValue(undefined);
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    triggerSessionScoring(db, "s8", "u1", { scoreSession, scoreWithRubric, acquireLease: vi.fn().mockResolvedValue("token"), releaseLease });
    await vi.waitFor(() => expect(releaseLease).toHaveBeenCalledOnce());
    expect(scoreSession).toHaveBeenCalledWith(db, "s8", "u1", expect.objectContaining({ scoreWithRubric }));
  });});
