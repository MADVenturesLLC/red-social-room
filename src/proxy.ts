// Next.js 16 Proxy (formerly Middleware): runs before every route, page, API route and asset.
// A1 pin 17, line 368: the Host check comes first, before the POST guard or any handler code.
import { hostGuard } from "./server/hosts.ts";

export function proxy(request: Request): Response | undefined {
  return hostGuard(request) ?? undefined;
}
