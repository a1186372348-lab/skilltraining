import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePromptTemplates, resetPromptTemplateCache } from "./resolver";
import { computeContentHash } from "./registry";
const legacy={name:"followup",version:"v1",system:"file",user:"file"};
const strict='{"system":"active","user":"prompt","outputContract":"gate-evidence-v1"}';
const db=(row:unknown) => ({promptVersion:{findFirst:vi.fn(async()=>row)}}) as never;
afterEach(() => { resetPromptTemplateCache(); vi.restoreAllMocks(); });
describe("strict resolver", () => {
  it("retains strict metadata while allowing expected Git drift", async () => {
    vi.spyOn(console,"warn").mockImplementation(()=>{});
    const result=await resolvePromptTemplates(db({version:"v8",content:strict,contentHash:computeContentHash(strict)}),legacy);
    expect(result).toEqual({system:"active",user:"prompt",outputContract:"gate-evidence-v1",promptVersion:"v8",promptSource:"database"});
  });
  it("does not downgrade a damaged strict record or mismatched hash", async () => {
    await expect(resolvePromptTemplates(db({version:"v8",content:strict,contentHash:"bad"}),legacy)).rejects.toThrow();
    await expect(resolvePromptTemplates(db({version:"v8",content:'{"system":"x","user":"y"}',contentHash:"bad"}),legacy)).rejects.toThrow();
  });
  it("preserves historical malformed fallback", async () => {
    vi.spyOn(console,"warn").mockImplementation(()=>{});
    expect(await resolvePromptTemplates(db({version:"old",content:"bad",contentHash:"bad"}),legacy)).toEqual({system:"file",user:"file"});
  });
});

it("caches the validated strict version until explicit cache reset", async () => {
  const findFirst=vi.fn(async () => ({version:"v8",content:strict,contentHash:computeContentHash(strict)}));
  vi.spyOn(console,"warn").mockImplementation(()=>{});
  const prisma={promptVersion:{findFirst}} as never;
  const first=await resolvePromptTemplates(prisma,legacy);
  expect(await resolvePromptTemplates(prisma,legacy)).toEqual(first);
  expect(findFirst).toHaveBeenCalledTimes(1);
});

it("uses validated strict file when no active exists", async () => {
  const file={name:"followup",version:"v8",system:"file",user:"file",outputContract:"gate-evidence-v1"} as const;
  expect(await resolvePromptTemplates(db(null),file)).toEqual({system:"file",user:"file",outputContract:"gate-evidence-v1",promptVersion:"v8",promptSource:"file"});
});

it("keeps legacy no-active file behavior", async () => {
  expect(await resolvePromptTemplates(db(null),legacy)).toEqual({system:"file",user:"file"});
});

it("rejects invalid strict default file and malformed strict database content", async () => {
  await expect(resolvePromptTemplates(db(null),{...legacy,version:"v8"})).rejects.toThrow();
  await expect(resolvePromptTemplates(db({version:"v8",content:"invalid",contentHash:"invalid"}),legacy)).rejects.toThrow();
});

it("accepts matching legacy active without a drift warning", async () => {
  const content='{"system":"file","user":"file"}';
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  expect(await resolvePromptTemplates(db({version:"v1",content,contentHash:computeContentHash(content)}),legacy)).toEqual({system:"file",user:"file"});
  expect(warn).not.toHaveBeenCalled();
});

it("uses valid legacy database drift while retaining the legacy shape", async () => {
  const content='{"system":"other","user":"file"}';
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  expect(await resolvePromptTemplates(db({version:"v2",content,contentHash:computeContentHash(content)}),legacy)).toEqual({system:"other",user:"file"});
  expect(warn).toHaveBeenCalled();
});


it("resolves a validated v9 candidate without changing legacy fallback", async () => {
 const content=JSON.stringify({system:"s",user:"u",outputContract:"gate-evidence-v2"});
 const candidate={name:"followup",version:"v9",system:"s",user:"u",outputContract:"gate-evidence-v2"} as const;
 expect(await resolvePromptTemplates(db(null),candidate)).toMatchObject({outputContract:"gate-evidence-v2",promptVersion:"v9"});
 expect(await resolvePromptTemplates(db({version:"v9",content,contentHash:computeContentHash(content)}),legacy)).toMatchObject({outputContract:"gate-evidence-v2",promptVersion:"v9"});
});
