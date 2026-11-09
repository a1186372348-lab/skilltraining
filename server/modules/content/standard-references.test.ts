import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadStandardReferences } from "./standard-references";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(run: (root: string, approvals: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "standard-ref-"));
  const approvals = path.join(root, "approvals"); mkdirSync(approvals);
  try { run(root, approvals); } finally { rmSync(root, { recursive: true, force: true }); }
}
const yaml = (refs: string) => `question_id: B3\nreferences:\n${refs}\n`;
const draft = "  - id: r1\n    text: answer\n    status: draft";
const approved = `  - id: r1\n    text: answer\n    status: approved\n    content_hash: ${hash("answer")}\n    approval_id: record1`;
const record = {record_id:"record1", question_id:"B3", reference_id:"r1", content_hash:hash("answer"), decision:"approved"};
describe("standard references", () => {
  it("reports absent files and allows structurally valid draft but not readiness", () => fixture((r,a) => {
    expect(loadStandardReferences(r,a,["B3"]).structuralIssues.length).toBeGreaterThan(0);
    writeFileSync(path.join(r,"B3.yaml"),yaml(draft)); const result=loadStandardReferences(r,a,["B3"]);
    expect(result.structuralIssues).toEqual([]); expect(result.readinessIssues.length).toBeGreaterThan(0); expect(result.summary[0].declaredStatus).toBe("draft");
  }));
  it("rejects empty and duplicate question scope", () => fixture((r,a) => {
    expect(loadStandardReferences(r,a,[]).structuralIssues.length).toBeGreaterThan(0);
    expect(loadStandardReferences(r,a,["B3","B3"]).structuralIssues.length).toBeGreaterThan(0);
  }));
  it("allows a pending draft alongside an approved item, but never reports an invalid approval as verified", () => fixture((r,a) => {
    writeFileSync(path.join(r,"B3.yaml"),yaml(`${approved}\n${draft.replaceAll("r1","r2")}`));
    let result = loadStandardReferences(r,a,["B3"]);
    expect(result.summary[0].approvalVerified).toBe(false);
    expect(result.readinessIssues.length).toBeGreaterThan(0);
    writeFileSync(path.join(a,"record1.json"),JSON.stringify(record));
    result = loadStandardReferences(r,a,["B3"]);
    expect(result.readinessIssues).toEqual([]);
    expect(result.summary.map(x => x.approvalVerified)).toEqual([true,false]);
  }));
  it("rejects wrong question, duplicate ids, excessive entries and invalid yaml", () => fixture((r,a) => {
    for (const data of [yaml(`${draft}\n${draft}`),yaml(`${draft}\n${draft.replaceAll('r1','r2')}\n${draft.replaceAll('r1','r3')}`),"question_id: B4\nreferences: []", "[invalid"]) {
      writeFileSync(path.join(r,"B3.yaml"),data); expect(loadStandardReferences(r,a,["B3"]).structuralIssues.length).toBeGreaterThan(0);
    }
  }));
  it("requires matching real record and content hash", () => fixture((r,a) => {
    writeFileSync(path.join(r,"B3.yaml"),yaml(approved));
    expect(loadStandardReferences(r,a,["B3"]).readinessIssues.length).toBeGreaterThan(0);
    writeFileSync(path.join(a,"record1.json"),JSON.stringify({...record,question_id:"B4"}));
    expect(loadStandardReferences(r,a,["B3"]).readinessIssues.length).toBeGreaterThan(0);
    writeFileSync(path.join(a,"record1.json"),JSON.stringify(record));
    expect(loadStandardReferences(r,a,["B3"]).readinessIssues).toEqual([]);
    writeFileSync(path.join(r,"B3.yaml"),yaml(approved.replace("text: answer","text: changed")));
    expect(loadStandardReferences(r,a,["B3"]).readinessIssues.length).toBeGreaterThan(0);
    writeFileSync(path.join(r,"B3.yaml"),yaml(approved.replace("record1","../outside")));
    expect(loadStandardReferences(r,a,["B3"]).structuralIssues.length).toBeGreaterThan(0);
  }));
  it("rejects symlinked answer and approval files", () => fixture((r,a) => {
    const outside = path.join(r, "outside"); writeFileSync(outside, yaml(draft));
    const answer = path.join(r, "B3.yaml");
    try { symlinkSync(outside, answer, "file"); } catch { return; }
    expect(loadStandardReferences(r,a,["B3"]).structuralIssues.length).toBeGreaterThan(0);
    unlinkSync(answer); writeFileSync(answer,yaml(approved));
    writeFileSync(outside,JSON.stringify(record)); symlinkSync(outside,path.join(a,"record1.json"),"file");
    expect(loadStandardReferences(r,a,["B3"]).readinessIssues.length).toBeGreaterThan(0);
  }));
});
