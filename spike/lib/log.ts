// Run log: everything is scrubbed for key values before it hits the console or disk.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { scrub } from "./secrets.ts";
import { isoNY } from "./ledger.ts";

export function makeLogger(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  return (msg: string) => {
    const line = scrub(`[${isoNY()}] ${msg}`);
    console.log(line);
    appendFileSync(file, line + "\n");
  };
}
