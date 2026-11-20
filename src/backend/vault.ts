import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename } from "node:path";
import { fail } from "./util.ts";
import type { Credentials } from "./venue.ts";

const service = Buffer.from("app.ponpoko.binance-th-assistant");
const account = Buffer.from("local-spot-v1");
const security = process.platform === "darwin" ? dlopen("/System/Library/Frameworks/Security.framework/Security", {
  SecKeychainFindGenericPassword: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecKeychainItemFreeContent: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecKeychainAddGenericPassword: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecKeychainItemModifyAttributesAndData: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  SecKeychainItemDelete: { args: [FFIType.ptr], returns: FFIType.i32 }
}) : null;
const core = process.platform === "darwin" ? dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFRelease: { args: [FFIType.ptr], returns: FFIType.void }
}) : null;
const libc = process.platform === "darwin" || process.platform === "linux"
  ? dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
  }) : null;

function pointer(value: bigint) { return Number(value) as ReturnType<typeof ptr>; }

export function credentials(): Credentials | null {
  if (!security || process.env.PONPOKO_DISABLE_PRIVATE === "1") return null;
  const length = new Uint32Array(1), result = new BigUint64Array(1);
  const status = security.symbols.SecKeychainFindGenericPassword(null, service.length, ptr(service), account.length, ptr(account), ptr(length), ptr(result), null);
  if (status === -25300) return null;
  if (status !== 0 || !result[0]) fail("keychain", "เปิดรายการ Binance TH ใน macOS Keychain ไม่ได้");
  try {
    if (length[0] > 4096) fail("keychain", "ข้อมูลใน Keychain ไม่อยู่ในรูปแบบที่รองรับ");
    const data = JSON.parse(new TextDecoder().decode(toArrayBuffer(pointer(result[0]), 0, length[0])));
    if (!isKey(data.key) || !isKey(data.secret) || typeof data.pilot !== "boolean") fail("keychain", "ข้อมูลใน Keychain ไม่อยู่ในรูปแบบที่รองรับ");
    return data as Credentials;
  } catch { return fail("keychain", "ข้อมูลใน Keychain ไม่อยู่ในรูปแบบที่รองรับ"); }
  finally { security.symbols.SecKeychainItemFreeContent(null, pointer(result[0])); }
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{16,256}$/.test(value);
}

function writeVault(value: Credentials | null) {
  if (!security || !core) return fail("keychain", "รุ่นนี้เชื่อมบัญชีจริงได้ผ่าน macOS Keychain");
  const item = new BigUint64Array(1);
  const status = security.symbols.SecKeychainFindGenericPassword(null, service.length, ptr(service), account.length, ptr(account), null, null, ptr(item));
  if (status !== 0 && status !== -25300) fail("keychain", "เปิดรายการ Binance TH ใน Keychain ไม่ได้");
  let result = 0;
  const payload = value && Buffer.from(JSON.stringify(value));
  try {
    if (item[0]) {
      const handle = pointer(item[0]);
      result = payload
        ? security.symbols.SecKeychainItemModifyAttributesAndData(handle, null, payload.length, ptr(payload))
        : security.symbols.SecKeychainItemDelete(handle);
    } else if (payload) {
      result = security.symbols.SecKeychainAddGenericPassword(null, service.length, ptr(service), account.length, ptr(account), payload.length, ptr(payload), null);
    }
  } finally {
    payload?.fill(0);
    if (item[0]) core.symbols.CFRelease(pointer(item[0]));
  }
  if (result !== 0) fail("keychain", "บันทึกการเปลี่ยนแปลงใน Keychain ไม่สำเร็จ");
}

export class Writer {
  private fd: number | null = null;
  constructor(private path: string) {}
  claim() {
    if (this.fd !== null) return true;
    if (!libc) return process.env.PONPOKO_DISABLE_PRIVATE === "1";
    const fd = openSync(this.path, "a+", 0o600);
    if (libc.symbols.flock(fd, 2 | 4) !== 0) { closeSync(fd); return false; }
    this.fd = fd;
    return true;
  }
  close() {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

export async function setupVault(action: string) {
  if (!security || !process.stdin.isTTY || !process.stdout.isTTY || process.env.PONPOKO_DISABLE_PRIVATE === "1") {
    fail("keychain", "เปิดคำสั่งนี้ใน Terminal บน macOS");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const read = async (prompt: string) => {
    const hidden = Bun.spawnSync(["/bin/stty", "-echo"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (!hidden.success) fail("keychain", "ซ่อนอักขระใน Terminal ไม่สำเร็จ");
    try { return (await rl.question(prompt)).trim(); }
    finally {
      Bun.spawnSync(["/bin/stty", "echo"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.stdout.write("\n");
    }
  };
  const restore = () => {
    Bun.spawnSync(["/bin/stty", "echo"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(130);
  };
  process.once("SIGINT", restore);
  try {
    if (action === "disconnect") {
      if ((await rl.question("คำสั่งเดิมบน Binance TH ยังอยู่ พิมพ์ DISCONNECT เพื่อเอา key ออกจากเครื่อง: ")).trim() !== "DISCONNECT") return;
      writeVault(null);
      console.log("ลบ key ในเครื่องแล้ว ตรวจคำสั่งค้างและเพิกถอน key ใน Binance TH แยกได้");
      return;
    }
    const pilot = action === "connect-pilot";
    if (pilot && (await rl.question("ใช้ key บัญชีย่อยของคุณที่เปิด Read และ Spot เท่านั้น พิมพ์ SPOT PILOT เพื่อเปิดทางทดสอบเงินจริง BTCTHB: ")).trim() !== "SPOT PILOT") return;
    const key = await read("API key: ");
    const secret = await read("API secret: ");
    if (!isKey(key) || !isKey(secret)) fail("keychain", "รูปแบบ key ไม่ถูกต้อง");
    writeVault({ key, secret, pilot });
    console.log(pilot ? "บันทึกโหมด pilot แล้ว เปิด surface ตั้งเพดาน แล้วตรวจ ticket ก่อนส่ง" : "บันทึก key สำหรับดูยอดบัญชีเท่านั้น");
  } finally { process.removeListener("SIGINT", restore); rl.close(); }
}
