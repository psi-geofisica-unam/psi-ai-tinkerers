import { resolve } from "node:path";
import { createReservationHandler } from "@/lib/server/reservation-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createReservationHandler({
  directory: resolve(process.env.WEB_APPROVAL_DIR || ".data/web-approvals"),
});
export const GET = handler;
export const POST = handler;
