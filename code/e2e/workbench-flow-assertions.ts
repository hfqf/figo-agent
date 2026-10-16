import assert from "node:assert/strict";

export function assertPayableAmount(answer: string, expected: number): void {
  const lastLine = answer.trim().split(/\r?\n/).at(-1)!;
  const amount = /^(?:实付金额[：:][ \t]*)?(\d+(?:\.\d+)?)[ \t]*$/.exec(lastLine);
  assert.ok(amount, "答复最后一行必须是独立金额，不把解释中的数字当最终金额");
  assert.equal(Number(amount[1]), expected, "实付金额必须数值相等，不能只包含目标数字");
}
