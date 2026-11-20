import { mkdir } from "node:fs/promises";
import { buildSurface } from "@ponpoko-app/surface-sdk/build";

const staging = ".build/bin";
const executable = process.platform === "win32" ? "binance-th-backend.exe" : "binance-th-backend";
await mkdir(staging, { recursive: true });
const compiled = Bun.spawnSync([process.execPath, "build", "src/backend/index.ts", "--compile", "--minify", "--outfile", `${staging}/${executable}`], { stdout: "inherit", stderr: "inherit" });
if (!compiled.success) throw new Error("The surface backend did not compile.");
await buildSurface({ executables: { backend: `${staging}/${executable}` } });
