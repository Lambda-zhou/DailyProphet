/**
 * dotenv preload. Import this as the FIRST line of any entry script so that
 * `.env.local` lands in `process.env` *before* any other module-init code
 * captures it (e.g. `lib/sources/registry.ts` freezing `REPORT_LOCALE`,
 * `lib/utils.ts` reading `REPORT_TZ`, etc.).
 *
 * Usage in a script:
 *   import "./_env";          // must be the first import
 *   import fs from "node:fs"; // anything else
 *
 * Why a separate module and not inline `config({path:".env.local"})`:
 *   ES module top-level code runs in DFS post-order of the import graph.
 *   When an entry script writes
 *     import { config } from "dotenv";
 *     config({ path: ".env.local" });
 *     import { foo } from "../lib/foo";    // ← evaluated BEFORE config()
 *   every transitively imported module evaluates *before* the script body,
 *   so values like `REPORT_LOCALE` captured at lib/* module init still see
 *   undefined. Pulling dotenv into its own no-dep module and importing it
 *   first guarantees its body runs before any of those captures.
 */
import { config } from "dotenv";

// quiet: true suppresses dotenv's stdout banner ("injected env… // tip: …")
// which v17 uses to advertise the author's paid products (dotenvx, vestauth).
config({ path: ".env.local", quiet: true });
