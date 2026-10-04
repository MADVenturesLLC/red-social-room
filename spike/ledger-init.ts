// Explicit, one-time creation of an empty spend ledger (Argus F7). Refuses if the file already exists,
// because recreating it would wipe the cap history. Usage: node spike/ledger-init.ts [--ledger <path>]
import { Ledger } from "./lib/ledger.ts";
import { LEDGER_PATH } from "./lib/step.ts";

const i = process.argv.indexOf("--ledger");
const path = i >= 0 ? process.argv[i + 1] : LEDGER_PATH;
if (!path) { console.error("usage: node spike/ledger-init.ts [--ledger <path>]"); process.exit(2); }
try {
  Ledger.init(path);
  console.log(`created empty spend ledger ${path}`);
} catch (e) {
  console.error(`ledger-init refused: ${(e as Error).message}`);
  process.exit(1);
}
