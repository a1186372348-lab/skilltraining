import { expect, it } from "vitest";
import { renderPromptTemplate, templateSlotsOf } from "./template";
it("renders and discovers slots without losing required field checks", () => {
  expect(templateSlotsOf("{{a}} {{b}}" )).toEqual(["a","b"]);
  expect(renderPromptTemplate("{{a}}",{a:"x"})).toBe("x");
  expect(() => renderPromptTemplate("{{b}}",{a:"x"})).toThrow();
});
