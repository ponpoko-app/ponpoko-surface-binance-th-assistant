import Decimal from "decimal.js";
import { createHash } from "node:crypto";

export const D = Decimal.clone({ precision: 46, rounding: Decimal.ROUND_DOWN, toExpNeg: -30, toExpPos: 30 });
export type Dec = Decimal;
export const DAY = 86_400_000;
const BANGKOK = 7 * 3_600_000;

export class Fault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function fail(code: string, message: string): never { throw new Fault(code, message); }

export function amount(value: unknown): Dec {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d{1,24}(?:\.\d{1,40})?$/.test(String(value))) {
    return fail("decimal", "ยอดหรือราคาที่ได้รับไม่อยู่ในรูปแบบที่รองรับ");
  }
  return new D(value);
}

export function positive(value: unknown): Dec {
  const decimal = amount(value);
  if (decimal.lte(0)) fail("amount", "กรอกจำนวนหรือราคาที่มากกว่าศูนย์");
  return decimal;
}

export function decimalText(value: Dec) { return value.toFixed(); }
export function floorTo(value: Dec, step: Dec) { return value.div(step).floor().mul(step); }
export function ceilTo(value: Dec, step: Dec) { return value.div(step).ceil().mul(step); }
export function dateStart(now: number) { return Math.floor((now + BANGKOK) / DAY) * DAY - BANGKOK; }
export function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("input", "รูปแบบคำขอไม่ถูกต้อง");
  return value as Record<string, unknown>;
}

export async function inBatches<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let start = 0; start < items.length; start += width) result.push(...await Promise.all(items.slice(start, start + width).map(fn)));
  return result;
}
