// Next.js calls register() once when the server starts. Opening the app here takes the single-instance lock on
// the data directory (Argus L1 on f63676e) and runs the startup sweep before the first request.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startApp } = await import("./server/app.ts");
  startApp();
}
