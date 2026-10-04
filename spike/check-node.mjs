// Plain JS (runs on any Node) so `npm test` / `npm run typecheck` fail with a clear message on an old Node
// instead of a confusing ".ts" error. The box's default `node` is v20; use /home/box/node22/bin.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`Node ${process.versions.node} found; this repo needs Node >= 22.18 (runs .ts by type stripping).\nOn the box: export PATH=/home/box/node22/bin:$PATH`);
  process.exit(1);
}
