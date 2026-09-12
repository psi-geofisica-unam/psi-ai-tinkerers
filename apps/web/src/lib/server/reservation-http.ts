import { randomBytes } from "node:crypto";
import { z } from "zod";
import { configuredWorkplace } from "./workplace";
import { availabilitySchema, PsiClient, PsiError, reservationDraftSchema } from "./psi";
import { ReservationError, ReservationService } from "./reservations";

const cookieName = "web-reservation-session";

// Identidad de confianza desde PSI: Encore vive embebido en la GUI de PSI, así
// que ya no maneja su propio login (Google/NextAuth) — PSI ya autenticó al
// usuario con su propia sesión y reenvía su correo aquí, igual que Encore le
// manda x-dev-key/x-user-ref a PSI en psi.ts. Es el mismo patrón, en sentido
// contrario. Sin estos dos headers válidos, la petición se trata como
// no autenticada (nunca se acepta un correo sin la llave).
function identidadConfiable(request: Request): string | null {
  const trustKey = request.headers.get("x-encore-trust-key");
  const userEmail = request.headers.get("x-user-email");
  const expected = process.env.ENCORE_TRUST_KEY?.trim();
  if (!trustKey || !userEmail || !expected || trustKey !== expected) return null;
  return userEmail;
}
const command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("availability"), ...availabilitySchema.shape }).strict(),
  z.object({ operation: z.literal("propose"), ...reservationDraftSchema.shape }).strict(),
  z.object({ operation: z.literal("approve"), proposalId: z.uuid() }).strict(),
  z.object({ operation: z.literal("deny"), proposalId: z.uuid() }).strict(),
]);

export function createReservationHandler(options: { directory: string; psi?: PsiClient; connectAmbiguous?: typeof configuredWorkplace }) {
  const connectAmbiguous = options.connectAmbiguous ?? configuredWorkplace;
  return async (request: Request) => {
    const url = new URL(request.url);
    const expectedOrigin = new URL(url);
    expectedOrigin.host = request.headers.get("host") || url.host;
    const trustedEmail = options.psi ? null : identidadConfiable(request);
    // Loopback siempre permitido (dev). En producción, ALLOWED_HOST agrega el
    // hostname/IP real donde corre esta instancia. Si la petición ya viene
    // con identidad confiable de PSI (llamada servidor-a-servidor, sin
    // Origin de navegador), el chequeo de host no aplica — PSI ya decidió
    // que esta petición es legítima.
    if (!trustedEmail) {
      const allowedHosts = ["localhost", "127.0.0.1", "[::1]", ...(process.env.ALLOWED_HOST?.split(",").map((h) => h.trim()).filter(Boolean) ?? [])];
      if (!allowedHosts.includes(expectedOrigin.hostname)) return Response.json({ error: "Host no autorizado. Configura ALLOWED_HOST si esto corre fuera de localhost." }, { status: 403 });
    }
    // Sesión: si PSI ya mandó una identidad confiable, la "sesión" para
    // efectos de dueño de propuesta es una derivada estable del correo (no
    // hace falta cookie — no hay navegador hablando directo con Encore). Si
    // no, se usa la cookie de siempre (llamada directa a Encore, ej. tests).
    const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const hasSession = trustedEmail ? true : Boolean(cookie && /^[a-f0-9]{64}$/.test(cookie));
    const session = trustedEmail ?? (hasSession ? cookie! : randomBytes(32).toString("hex"));
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", ...(!trustedEmail && !hasSession ? { "Set-Cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/api/followups; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}` } : {}) } });
    if (request.method !== "GET" && request.method !== "POST") return reply({ error: "Método no permitido." }, 405);
    if (!trustedEmail) {
      if (request.method === "POST" && (request.headers.get("origin") !== expectedOrigin.origin || !request.headers.get("content-type")?.startsWith("application/json"))) return reply({ error: "Usa los controles de aprobación de esta página." }, 403);
      if (request.method === "POST" && !hasSession) return reply({ error: "Recarga la página para iniciar una sesión antes de proponer o aprobar." }, 403);
    }
    if (request.method === "GET" && url.searchParams.get("session") === "1") return reply({ status: "ready" });
    // El correo SIEMPRE sale de la identidad confiable que manda PSI (o, en
    // pruebas, de options.psi) — nunca de una variable de entorno ni del
    // cuerpo del cliente. PSI, a su vez, lo sacó de su propia sesión real
    // (requireAuth()) antes de reenviar la petición.
    let psi = options.psi;
    if (!psi) {
      if (!trustedEmail) return reply({ error: "Esta ruta solo acepta peticiones reenviadas por PSI con identidad confiable." }, 401);
      psi = new PsiClient(trustedEmail);
    }
    const service = new ReservationService(psi, options.directory, () => process.env.AMBIGUOUS_API_KEY?.trim() ? connectAmbiguous() : undefined);
    try {
      if (request.method === "GET") {
        const reservationId = url.searchParams.get("reservationId");
        if (reservationId) return reply({ reservation: await service.get(reservationId) });
        const [catalog, reservations] = await Promise.all([psi.catalog(), service.list()]);
        return reply({ status: "connected", catalog, reservations });
      }
      const text = await request.text();
      if (text.length > 12_000) return reply({ error: "La propuesta es demasiado grande." }, 413);
      const input = command.parse(JSON.parse(text));
      if (input.operation === "availability") {
        const { operation: _operation, ...availability } = input;
        return reply({ availability: await psi.availability(availability) });
      }
      if (input.operation === "propose") {
        const { operation: _operation, ...draft } = input;
        return reply({ proposal: await service.propose(session, draft) });
      }
      if (input.operation === "deny") {
        await service.deny(session, input.proposalId);
        return reply({ status: "declined" });
      }
      return reply({ result: await service.approve(session, input.proposalId) });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return reply({ error: "Datos de reservación inválidos. Revisa espacio, evento, horario y descripción." }, 400);
      const message = error instanceof PsiError || error instanceof ReservationError ? error.message : "No fue posible completar la operación con PSI. Verifica configuración, permisos y conectividad.";
      return reply({ error: message }, 502);
    }
  };
}
