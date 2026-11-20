import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import { Binance } from "./venue.ts";
import { Trading, modeOf, readPreview, symbolOf } from "./service.ts";
import { Market } from "./market.ts";
import { Ledger } from "./ledger.ts";
import { credentials, setupVault, Writer } from "./vault.ts";
import { fail, Fault, object } from "./util.ts";

function orderId(value: unknown) {
  if (typeof value !== "string" || !/^pp-[a-f0-9]{32}$/.test(value)) return fail("order", "เลขอ้างอิงไม่ถูกต้อง");
  return value;
}

function run() {
  const directory = process.env.PONPOKO_SURFACE_DATA_DIR;
  if (!directory || !isAbsolute(directory)) fail("storage", "เปิด surface ผ่าน Ponpoko เพื่อใช้ที่เก็บข้อมูลที่กำหนด");
  process.umask(0o077);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ledger = new Ledger(join(directory, "trading.sqlite3"));
  const venue = new Binance();
  const market = new Market(venue);
  const writer = new Writer(join(directory, "writer.lock"));
  const trading = new Trading(ledger, venue, market, credentials, () => writer.claim());
  const api: Record<string, (params: Record<string, unknown>) => unknown> = {
    "market.snapshot": () => market.snapshot(),
    "market.refresh": () => market.refresh(),
    "trade.state": params => trading.state(modeOf(params.mode)),
    "trade.quote": params => trading.quote(symbolOf(params.symbol), params.signal === true),
    "trade.preview": params => trading.preview(readPreview(params)),
    "trade.submit": params => trading.submit(orderId(params.id)),
    "trade.settings": params => trading.settings(modeOf(params.mode), params.caps),
    "trade.halt": params => trading.halt(modeOf(params.mode)),
    "trade.resume": params => trading.resume(modeOf(params.mode)),
    "trade.reconcile": params => trading.reconcile(orderId(params.id))
  };
  const read = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const reply = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
  read.on("line", async line => {
    let id: unknown = null;
    try {
      if (line.length > 20_000) fail("rpc", "คำขอใหญ่เกินขนาด");
      const request = object(JSON.parse(line));
      id = typeof request.id === "number" || typeof request.id === "string" ? request.id : null;
      if (id === null || request.jsonrpc !== "2.0" || typeof request.method !== "string" ||
        !Object.hasOwn(api, request.method)) fail("rpc", "คำขอไม่รองรับ");
      const result = await api[request.method](object(request.params ?? {}));
      reply({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const message = error instanceof Fault ? error.message : "ระบบอ่านข้อมูลไม่สำเร็จ ลองตรวจสถานะใหม่";
      reply({ jsonrpc: "2.0", id, error: { code: -32001, message } });
    }
  });
  read.on("close", () => { writer.close(); ledger.close(); process.exit(0); });
}

try {
  const action = process.argv.slice(2)[0];
  if (action === "connect" || action === "connect-pilot" || action === "disconnect") await setupVault(action);
  else if (action) fail("command", "ใช้ connect, connect-pilot หรือ disconnect");
  else run();
} catch (error) {
  console.error(error instanceof Fault ? error.message : "เปิด backend หรือที่เก็บข้อมูลไม่ได้");
  process.exit(1);
}
