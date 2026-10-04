// Opt-in switches for spike steps that must NOT run by default.
// A step behind one of these runs only when the variable is exactly "1".
export const FLAGS = {
  // Founder decision 7 (2026-10-03 22:32 ET): never send prompts for photoreal images of named real people.
  // The real-person refusal probe's evidence is already recorded (xai/04-refusal-probe.json,
  // gemini/05-refusal-probe.json), so it is off unless explicitly re-enabled.
  refusalProbe: "RUN_REFUSAL_PROBE",
  // xAI rejects 4:5 with HTTP 422 (xai/01-generate-4x5.json); Founder decision: generate 3:4 and crop.
  xai4x5Probe: "RUN_XAI_4X5_PROBE",
} as const;

export function optIn(name: (typeof FLAGS)[keyof typeof FLAGS], env: NodeJS.ProcessEnv = process.env): boolean {
  return env[name] === "1";
}
