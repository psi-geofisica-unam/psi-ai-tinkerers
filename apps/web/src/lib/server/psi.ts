import { z } from "zod";

const baseUrl = () => (process.env.PSI_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

const horarioSchema = z.object({
  dia: z.number().int().min(1).max(7),
  inicio: z.string().regex(/^\d{2}:\d{2}$/),
  fin: z.string().regex(/^\d{2}:\d{2}$/),
});

export const reservationDraftSchema = z
  .object({
    tipo: z.enum(["aula", "auditorio"]),
    recursoId: z.number().int().positive(),
    tipoEventoId: z.number().int().positive(),
    nombre: z.string().trim().min(3).max(100),
    descripcion: z.string().trim().min(10).max(500),
    inicio: z.string().datetime(),
    fin: z.string().datetime(),
    horarios: z.array(horarioSchema).min(1).optional(),
  })
  .refine(({ inicio, fin }) => new Date(fin) >= new Date(inicio), {
    message: "La fecha de fin debe ser posterior o igual a la fecha de inicio.",
    path: ["fin"],
  });

export const availabilitySchema = z.object({
  tipo: z.enum(["aula", "auditorio"]),
  recursoId: z.number().int().positive(),
  inicio: z.string().datetime(),
  fin: z.string().datetime(),
  horarios: z.array(horarioSchema).min(1).optional(),
}).refine(({ tipo, horarios }) => tipo !== "aula" || Boolean(horarios?.length), {
  message: "Para consultar un aula se requiere al menos un horario semanal.",
  path: ["horarios"],
});

export type ReservationDraft = z.infer<typeof reservationDraftSchema>;
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

export type PsiCatalog = {
  aulas: Array<{ id: number; nombre: string; ubicacion: string; capacidad: number; equipo: unknown; descripcion: string | null }>;
  auditorios: Array<{ id: number; nombre: string; ubicacion: string; capacidad: number; equipo: unknown; descripcion: string | null }>;
  tiposEventoAula: Array<{ id: number; nombre: string; descripcion: string | null }>;
  tiposEventoAuditorio: Array<{ id: number; nombre: string; descripcion: string | null }>;
  tiposServicioComputo: Array<{ id: number; nombre: string; descripcion: string | null }>;
};

export type PsiAvailability = {
  disponible: boolean;
  conflictos: unknown[];
  mensaje: string;
};

export type PsiReservation = {
  reservacion: { id: string; estado: "APROBADA" | "PENDIENTE" };
  decision: "auto_aprobada" | "escalada_a_humano";
  motivo: string;
  verificadoEn: string;
};

export type PsiTramite = {
  servicio: "aulas" | "auditorios" | string;
  id: string | number;
  titulo: string;
  estado: string;
  createdAt: string;
  detalle: Record<string, unknown>;
};

type PsiEnvelope<T> = { success?: boolean; data?: T; error?: string; message?: string };
type Fetcher = typeof fetch;

export class PsiError extends Error {}

export class PsiClient {
  // userEmail viene SIEMPRE de la sesión de NextAuth del usuario que hace la
  // petición (ver reservation-http.ts) — nunca de una variable de entorno
  // fija. Así, cada llamada a PSI actúa con los permisos reales de quien está
  // enfrente de la pantalla, no de un usuario de prueba compartido por todos.
  constructor(private userEmail: string, private fetcher: Fetcher = fetch) {
    if (!userEmail) throw new PsiError("No hay una sesión de usuario válida para actuar en PSI.");
  }

  private headers() {
    const key = process.env.PSI_DEV_API_KEY?.trim();
    if (!key) {
      throw new PsiError("Configura PSI_DEV_API_KEY en el servidor para conectar con PSI.");
    }
    return { "x-dev-key": key, "x-user-ref": this.userEmail };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${baseUrl()}${path}`, {
        ...init,
        headers: { ...this.headers(), "Content-Type": "application/json", ...init.headers },
        cache: "no-store",
      });
    } catch {
      throw new PsiError("No fue posible conectar con PSI. Verifica que esté corriendo en la URL configurada.");
    }
    let body: PsiEnvelope<T>;
    try {
      body = (await response.json()) as PsiEnvelope<T>;
    } catch {
      throw new PsiError("PSI devolvió una respuesta no válida.");
    }
    if (!response.ok || body.success === false || body.data === undefined) {
      throw new PsiError(body.error || body.message || `PSI rechazó la solicitud (HTTP ${response.status}).`);
    }
    return body.data;
  }

  catalog() {
    return this.request<PsiCatalog>("/api/agente/catalogo");
  }

  availability(input: AvailabilityInput) {
    return this.request<PsiAvailability>("/api/agente/disponibilidad", {
      method: "POST",
      body: JSON.stringify(availabilitySchema.parse(input)),
    });
  }

  reserve(input: ReservationDraft) {
    return this.request<PsiReservation>("/api/agente/reservar", {
      method: "POST",
      body: JSON.stringify(reservationDraftSchema.parse(input)),
    });
  }

  async reservations() {
    const { tramites } = await this.request<{ tramites: PsiTramite[] }>("/api/agente/mis-tramites?limite=100");
    return tramites.filter((tramite) => tramite.servicio === "aulas" || tramite.servicio === "auditorios");
  }
}
