export interface CheckRecord {
  name: string;
  ok: boolean;
  evidence: string;
}

const records: CheckRecord[] = [];

export async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const evidence = await fn();
    records.push({ name, ok: true, evidence });
    console.log(`PASS ${name} :: ${evidence}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    records.push({ name, ok: false, evidence: message });
    console.log(`FAIL ${name} :: ${message}`);
  }
}

export function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function report(): number {
  const passed = records.filter((r) => r.ok).length;
  const failed = records.length - passed;
  console.log(`checks: ${records.length}, passed: ${passed}, failed: ${failed}`);
  return failed === 0 ? 0 : 1;
}

export function reset(): void {
  records.length = 0;
}
