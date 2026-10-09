import { getApp } from "../../../server/app.ts";
import { appStatus } from "../../../server/status.ts";
import { json } from "../../../server/route-util.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json(appStatus(getApp()));
}
