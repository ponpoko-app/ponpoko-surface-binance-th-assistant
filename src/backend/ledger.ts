import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Caps, Fill, Mode, Order, Position, PreviewRequest, Ticket } from "../model.ts";
import { amount, D, dateStart, fail, type Dec } from "./util.ts";
import { defaultCaps, needsReview, paperCash } from "./rules.ts";

export type Review = { ticket: Ticket; request: PreviewRequest; lockKey: string; revision: number; step: string };
type Closed = { at: number; realized: Dec; net: Dec };
type LedgerOrder = Order & { step: string; cancelRequested?: boolean };
type PositionState = { base: string; step: Dec; quantity: Dec; cost: Dec; invalidation: string | null; openedAt: number };
type Run = { positions: Map<string, PositionState>; realized: Closed[]; cash: Dec; complete: boolean };
type ModeConfig = { caps: Caps | null; halted: boolean; revision: number; dailyHalt: number | null };
const initial = (mode: Mode): ModeConfig => ({ caps: mode === "paper" ? defaultCaps : null, halted: false, revision: 0, dailyHalt: null });

export class Ledger {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1500;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, mode TEXT NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, mode TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_mode ON orders(mode, created_at, id);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL);
    `);
  }

  close() { this.db.close(); }

  private get<T>(key: string): T | null {
    const result = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return result ? JSON.parse(result.value) as T : null;
  }

  private set(key: string, value: unknown) {
    this.db.query("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }

  private event(at: number, event: string, subject: string, data: unknown) {
    this.db.query("INSERT INTO events(at, event, subject, body) VALUES (?, ?, ?, ?)").run(at, event, subject, JSON.stringify(data));
  }

  config(mode: Mode) { return this.get<ModeConfig>("mode:" + mode) ?? initial(mode); }

  saveCaps(mode: Mode, caps: Caps, at: number) {
    this.db.transaction(() => {
      const previous = this.config(mode);
      this.set("mode:" + mode, { ...previous, caps, revision: previous.revision + 1 });
      this.event(at, "caps", mode, caps);
    }).immediate();
  }

  halt(mode: Mode, halted: boolean, at: number, forDay = false) {
    this.db.transaction(() => {
      const previous = this.config(mode);
      const start = dateStart(at);
      if (!halted && previous.dailyHalt === start) fail("daily", "หยุดเพราะชนเพดานขาดทุนวันนี้ เปิดไม้ใหม่ได้หลังขึ้นวันใหม่");
      if (forDay && previous.dailyHalt === start) return;
      this.set("mode:" + mode, { ...previous, halted, revision: previous.revision + 1,
        dailyHalt: forDay ? start : halted ? previous.dailyHalt : null });
      this.event(at, halted ? "halt" : "resume", mode, { forDay });
    }).immediate();
  }

  bindAccount(fingerprint: string, now: number) {
    const key = this.get<string>("account");
    if (key === fingerprint) return;
    if (key && this.orders("confirm").length) fail("account_changed", "key นี้ต่างจากบัญชีที่ผูกกับประวัติเดิม ตรวจหรือจัดการรายการเดิมใน Binance TH ก่อน");
    this.db.transaction(() => {
      this.set("account", fingerprint);
      this.event(now, "account_bound", "confirm", {});
    }).immediate();
  }

  checkAccount(fingerprint: string) {
    const current = this.get<string>("account");
    if (current && current !== fingerprint && this.orders("confirm").length) {
      fail("account_changed", "key นี้ต่างจากบัญชีที่ผูกกับประวัติเดิม เปิด Binance TH เพื่อตรวจรายการเดิม");
    }
  }

  ticketId() { return "pp-" + randomUUID().replaceAll("-", ""); }

  saveTicket(review: Review, now: number) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM tickets WHERE expires_at < ?").run(now);
      const { ticket } = review;
      this.db.query("INSERT INTO tickets VALUES (?, ?, ?, ?)").run(ticket.id, ticket.mode, ticket.expiresAt, JSON.stringify(review));
      this.event(now, "ticket", ticket.id, { ticket, request: review.request, revision: review.revision });
    }).immediate();
  }

  ticket(id: string): Review | null {
    const row = this.db.query("SELECT body FROM tickets WHERE id=?").get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) as Review : null;
  }

  consume(review: Review, order: LedgerOrder, now: number) {
    this.db.transaction(() => {
      const ticket = this.ticket(order.id);
      const config = this.config(order.mode);
      if (!ticket || ticket.ticket.expiresAt <= now || config.revision !== review.revision) {
        fail("ticket", "ใบยืนยันหมดอายุหรือการตั้งค่าเปลี่ยน โปรดตรวจใหม่");
      }
      if (order.side === "BUY" && config.halted) fail("halt", "หยุดเปิดไม้ใหม่อยู่");
      if (this.orders(order.mode).some(needsReview)) fail("pending", "ตรวจผลคำสั่งเดิมก่อนส่งคำสั่งใหม่");
      if (order.side === "BUY" && this.position(order.mode)) fail("position", "มีสถานะที่ดูแลอยู่แล้ว");
      this.db.query("DELETE FROM tickets WHERE id=?").run(order.id);
      this.db.query("INSERT INTO orders VALUES (?, ?, ?, ?)").run(order.id, order.mode, now, JSON.stringify(order));
      this.event(now, "dispatch", order.id, order);
    }).immediate();
  }

  getOrder(id: string): LedgerOrder | null {
    const row = this.db.query("SELECT body FROM orders WHERE id=?").get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) as LedgerOrder : null;
  }

  orders(mode: Mode): LedgerOrder[] {
    const rows = this.db.query("SELECT body FROM orders WHERE mode=? ORDER BY rowid").all(mode) as { body: string }[];
    return rows.map(row => JSON.parse(row.body) as LedgerOrder);
  }

  merge(order: LedgerOrder, now: number) {
    return this.db.transaction(() => {
      const previous = this.getOrder(order.id);
      if (!previous) fail("order", "ไม่พบคำสั่งนี้");
      if (previous.orderId && order.orderId && previous.orderId !== order.orderId) fail("order", "เลขอ้างอิงจาก Binance TH ไม่ตรง");
      if (previous.accounted && !needsReview(previous)) return previous;
      if (amount(order.filledQuantity).lt(previous.filledQuantity)) return previous;
      if (previous.orderId && !order.orderId) return previous;
      const next: LedgerOrder = { ...order, cancelRequested: previous.cancelRequested };
      this.db.query("UPDATE orders SET body=? WHERE id=?").run(JSON.stringify(next), order.id);
      this.event(now, "order", order.id, next);
      return next;
    }).immediate();
  }

  requestCancel(id: string, now: number) {
    return this.db.transaction(() => {
      const order = this.getOrder(id);
      if (!order || order.side !== "BUY" || order.cancelRequested || !["NEW", "PARTIALLY_FILLED"].includes(order.status)) return false;
      this.db.query("UPDATE orders SET body=? WHERE id=?").run(JSON.stringify({ ...order, cancelRequested: true }), id);
      this.event(now, "cancel_requested", id, {});
      return true;
    }).immediate();
  }

  position(mode: Mode): Position | null {
    const run = this.run(mode);
    const entry = [...run.positions].find(([, position]) => position.quantity.gte(position.step));
    if (!entry) return null;
    const [symbol, position] = entry;
    return { symbol, quantity: position.quantity.toFixed(), cost: position.cost.toFixed(),
      invalidation: position.invalidation, openedAt: position.openedAt };
  }

  private run(mode: Mode, before = Infinity): Run {
    const positions = new Map<string, PositionState>();
    const realized: Closed[] = [];
    let cash: Dec = new D(paperCash);
    let complete = true;
    const seen = new Set<string>();
    const ordered = this.orders(mode).flatMap((order, dispatch) => order.fills.map(fill => ({ order, fill, dispatch })))
      .sort((a, b) => a.fill.at - b.fill.at || a.dispatch - b.dispatch ||
        a.fill.id.localeCompare(b.fill.id, "en", { numeric: true }));
    for (const { order, fill } of ordered) {
      if (fill.at >= before) continue;
      const key = order.symbol + ":" + fill.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = amount(fill.quantity), quote = amount(fill.quote), fee = amount(fill.fee);
      const baseFee = fill.feeAsset === order.base ? fee : new D(0);
      const bahtFee = fill.feeAsset === "THB" ? fee : new D(0);
      if (!fee.isZero() && baseFee.isZero() && bahtFee.isZero()) complete = false;
      let position = positions.get(order.symbol);
      if (order.side === "BUY") {
        const out = quote.plus(bahtFee), qty = raw.minus(baseFee);
        if (qty.lte(0)) { complete = false; continue; }
        if (!position) {
          position = { base: order.base, step: amount(order.step), quantity: new D(0), cost: new D(0),
            invalidation: order.invalidation, openedAt: fill.at };
          positions.set(order.symbol, position);
        }
        if (position.quantity.lt(position.step)) {
          position.invalidation = order.invalidation;
          position.openedAt = fill.at;
        }
        position.step = amount(order.step);
        position.quantity = position.quantity.plus(qty);
        position.cost = position.cost.plus(out);
        cash = cash.minus(out);
      } else {
        const used = raw.plus(baseFee);
        if (!position || used.gt(position.quantity)) { complete = false; continue; }
        const basis = position.cost.mul(used).div(position.quantity);
        const net = quote.minus(bahtFee);
        position.quantity = position.quantity.minus(used);
        position.cost = position.cost.minus(basis);
        realized.push({ at: fill.at, realized: net.minus(basis), net });
        cash = cash.plus(net);
        if (position.quantity.isZero()) positions.delete(order.symbol);
      }
    }
    return { positions, realized, cash, complete };
  }

  funds(mode: Mode) { return this.run(mode).cash; }

  metrics(mode: Mode, now: number, bids: Map<string, { gross: Dec; fee: Dec }>, write: boolean) {
    const start = dateStart(now);
    const run = this.run(mode);
    const before = this.run(mode, start);
    const marked = [...run.positions.entries()].reduce<Dec | null>((sum, [symbol, position]) => {
      if (sum === null) return null;
      const bid = bids.get(symbol);
      if (position.quantity.lt(position.step)) return sum.minus(position.cost);
      return bid ? sum.plus(bid.gross.mul(new D(1).minus(bid.fee)).minus(position.cost)) : null;
    }, new D(0));
    const dayKey = `baseline:${mode}:${start}`;
    let baseline = this.get<string>(dayKey);
    if (baseline === null && before.positions.size === 0) baseline = "0";
    else if (baseline === null && now - start <= 60_000 &&
      [...before.positions].every(([symbol, p]) => run.positions.get(symbol)?.quantity.eq(p.quantity)) && marked !== null) {
      baseline = marked.toFixed();
      if (write) this.set(dayKey, baseline);
    }
    const realized = run.realized.reduce((sum, row) => sum.plus(row.realized), new D(0));
    const realizedToday = run.realized.filter(row => row.at >= start).reduce((sum, row) => sum.plus(row.realized), new D(0));
    const measure = run.complete && !this.orders(mode).some(needsReview) && marked !== null;
    return {
      daily: measure && baseline !== null ? realizedToday.plus(marked).minus(baseline) : null,
      net: measure ? realized.plus(marked) : null
    };
  }

  dust(mode: Mode) {
    return [...this.run(mode).positions].filter(([, value]) => value.quantity.lt(value.step))
      .map(([symbol, value]) => ({ symbol, quantity: value.quantity.toFixed() }));
  }
}
