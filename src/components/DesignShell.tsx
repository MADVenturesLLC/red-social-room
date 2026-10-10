"use client";
// A4: the client-side entry to the editor. Konva touches window at import time, so the canvas loads only
// in the browser: a plain dynamic import inside an effect (this module is already "use client", and the
// import never runs during the server render). Keeping next/dynamic out also keeps `npm run typecheck`
// (moduleResolution NodeNext) from needing a subpath type mapping.
import { useEffect, useState, type ComponentType } from "react";
import type { DesignCanvasProps } from "./DesignCanvas.tsx";

export default function DesignShell(props: DesignCanvasProps) {
  const [Canvas, setCanvas] = useState<ComponentType<DesignCanvasProps> | null>(null);
  useEffect(() => {
    let alive = true;
    void import("./DesignCanvas.tsx").then((m) => { if (alive) setCanvas(() => m.default); });
    return () => { alive = false; };
  }, []);
  if (!Canvas) return <p className="muted">Loading the editor…</p>;
  return <Canvas {...props} />;
}
