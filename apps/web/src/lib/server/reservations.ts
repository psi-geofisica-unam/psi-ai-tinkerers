import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Workplace, WorkplaceTask } from "./workplace";
import {
  reservationDraftSchema,
  type PsiReservation,
  type PsiTramite,
  type ReservationDraft,
} from "./psi";

export type ReservationProposal = Omit<ReservationDraft, "horarios"> & {
  id: string;
  horarios?: ReservationDraft["horarios"];
  expiresAt: number;
};

export type ReservationOutcome = PsiReservation & {
  seguimiento: { status: "creada"; task: WorkplaceTask } | { status: "no_configurada" | "error"; message: string };
};

type StoredProposal = ReservationProposal & { sessionHash: string };
const storedSchema = reservationDraftSchema.extend({
  id: z.uuid(),
  expiresAt: z.number(),
  sessionHash: z.string(),
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const exists = (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST";

export class ReservationError extends Error {}

export class ReservationService {
  constructor(
    private psi: { reserve(input: ReservationDraft): Promise<PsiReservation>; reservations(): Promise<PsiTramite[]> },
    private directory: string,
    private connectAmbiguous: (() => { workplace: Workplace; close(): Promise<void> } | undefined) = () => undefined,
    private now = Date.now,
  ) {}

  async list() {
    return this.psi.reservations();
  }

  async get(id: string) {
    return (await this.list()).find((reservation) => String(reservation.id) === id) ?? null;
  }

  async propose(session: string, input: unknown): Promise<ReservationProposal> {
    const draft = reservationDraftSchema.parse(input);
    const stored: StoredProposal = {
      ...draft,
      id: randomUUID(),
      expiresAt: this.now() + 10 * 60_000,
      sessionHash: hash(session),
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, `${stored.id}.json`), JSON.stringify(stored), { flag: "wx", mode: 0o600 });
    const { sessionHash: _session, ...proposal } = stored;
    return proposal;
  }

  private async proposal(session: string, id: string) {
    const proposal = storedSchema.parse(JSON.parse(await readFile(join(this.directory, `${z.uuid().parse(id)}.json`), "utf8"))) as StoredProposal;
    if (proposal.sessionHash !== hash(session)) throw new ReservationError("Esta propuesta pertenece a otra sesión del navegador.");
    if (proposal.expiresAt <= this.now()) throw new ReservationError("La propuesta venció. Prepara y revisa una nueva reservación.");
    return proposal;
  }

  private async decide(id: string, decision: "approved" | "declined") {
    const path = join(this.directory, `${id}.decision`);
    try {
      await writeFile(path, decision, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!exists(error)) throw error;
    }
    if ((await readFile(path, "utf8")) !== decision) throw new ReservationError("La propuesta ya recibió una decisión distinta.");
  }

  async deny(session: string, id: string) {
    await this.proposal(session, id);
    await this.decide(id, "declined");
  }

  async approve(session: string, id: string): Promise<ReservationOutcome> {
    const proposal = await this.proposal(session, id);
    await this.decide(id, "approved");
    const resultPath = join(this.directory, `${id}.result.json`);
    try {
      return JSON.parse(await readFile(resultPath, "utf8")) as ReservationOutcome;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const attemptPath = join(this.directory, `${id}.attempt`);
    try {
      await writeFile(attemptPath, "psi", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (exists(error)) throw new ReservationError("El resultado de esta reservación es incierto. Consulta Mis reservaciones en PSI antes de crear otra.");
      throw error;
    }
    let confirmed: PsiReservation;
    try {
      confirmed = await this.psi.reserve(reservationDraftSchema.parse(proposal));
    } catch (error) {
      throw new ReservationError(error instanceof Error ? error.message : "PSI no confirmó la reservación.");
    }
    const seguimiento = await this.createFollowup(proposal, confirmed);
    const outcome: ReservationOutcome = { ...confirmed, seguimiento };
    await writeFile(resultPath, JSON.stringify(outcome), { flag: "wx", mode: 0o600 });
    return outcome;
  }

  private async createFollowup(proposal: ReservationProposal, reservation: PsiReservation): Promise<ReservationOutcome["seguimiento"]> {
    const connection = this.connectAmbiguous();
    if (!connection) return { status: "no_configurada", message: "AMBIGUOUS_API_KEY no está configurada; PSI sí confirmó la reservación." };
    try {
      const when = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" }).format(new Date(proposal.inicio));
      const task = await connection.workplace.create(
        `Preparar ${proposal.tipo} ${proposal.nombre} — ${when}`,
        `Reservación PSI ${reservation.reservacion.id}\nEstado: ${reservation.reservacion.estado}\nDecisión PSI: ${reservation.decision}\nMotivo: ${reservation.motivo}`,
        async () => {},
      );
      return { status: "creada", task };
    } catch {
      return { status: "error", message: "PSI confirmó la reservación, pero no fue posible crear la tarea de seguimiento en Ambiguous." };
    } finally {
      await connection.close().catch(() => {});
    }
  }
}
