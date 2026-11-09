import { describe, expect, it, vi } from "vitest";
import { rollbackPrompt } from "./repository";

const row = (id:string,status:string,date:string) => ({id,name:"example",version:id,status,createdAt:new Date(date),content:"",contentHash:""});
function database(rows: ReturnType<typeof row>[]) {
  const update = vi.fn(async () => ({}));
  const tx = {promptVersion:{findMany:vi.fn(async () => rows),update}};
  return {db:{$transaction:async (run:(value:typeof tx)=>unknown) => run(tx)} as never,update};
}
describe("rollback repository boundary", () => {
  it("skips a newer draft and activates the latest eligible row", async () => {
    const {db,update}=database([row("current","active","2026-01-02"),row("eligible","passed","2026-01-01"),row("draft","draft","2026-01-03")]);
    await expect(rollbackPrompt(db,"example")).resolves.toEqual({activateId:"eligible",deactivateId:"current"});
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(2,{where:{id:"eligible"},data:{status:"active"}});
  });
  it("rejects before any update when only a draft exists", async () => {
    const rows=[row("current","active","2026-01-02"),row("draft","draft","2026-01-03")];
    const before=structuredClone(rows);
    const {db,update}=database(rows);
    await expect(rollbackPrompt(db,"example")).rejects.toThrow(/回滚/);
    expect(update).not.toHaveBeenCalled();
    expect(rows).toEqual(before);
  });
});
