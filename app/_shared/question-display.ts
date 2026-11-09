const SYNTHETIC_TITLE = /^合成验收案例 (daily|baseline)-(0|[1-9]\d{0,5})$/;
const SYNTHETIC_MARKER = /^【合成V2:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}】/;

export function displayCaseTitle(title: string): string {
  const match = SYNTHETIC_TITLE.exec(title);
  if (!match) return title;
  return `合成${match[1] === "daily" ? "日常" : "基线"}案例 ${Number(match[2]) + 1}`;
}

export function displayMainQuestion(question: string): string {
  const marker = SYNTHETIC_MARKER.exec(question);
  if (!marker) return question;
  const body = question.slice(marker[0].length);
  return body.trim() ? body : question;
}
