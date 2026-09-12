import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReservationService } from "./reservations";

const draft = { tipo: "auditorio" as const, recursoId: 1, tipoEventoId: 2, nombre: "Sesión Encore", descripcion: "Reservación institucional de prueba.", inicio: "2026-09-17T16:00:00.000Z", fin: "2026-09-17T18:00:00.000Z" };

test("la propuesta no escribe; la aprobación reserva en PSI y después crea seguimiento", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "encore-reservations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reserves = 0;
  let tasks = 0;
  const service = new ReservationService({
    async reserve(input) { reserves++; assert.deepEqual(input, draft); return { reservacion: { id: "psi-123", estado: "APROBADA" as const }, decision: "auto_aprobada" as const, motivo: "Sin empalmes", verificadoEn: "2026-09-12T00:00:00.000Z" }; },
    async reservations() { return []; },
  }, directory, () => ({
    workplace: {
      async identity() { return { id: "u", workspaceId: "w", name: "Encore" }; },
      async list() { return []; }, async get() { throw new Error("unused"); },
      async create(title) { tasks++; assert.match(title, /Preparar auditorio/); return { id: "11111111-1111-4111-8111-111111111111", title, description: "", url: null }; },
    },
    async close() {},
  }));
  const proposal = await service.propose("a".repeat(64), draft);
  assert.equal(reserves, 0);
  const outcome = await service.approve("a".repeat(64), proposal.id);
  assert.equal(outcome.reservacion.id, "psi-123");
  assert.equal(outcome.seguimiento.status, "creada");
  assert.equal(reserves, 1);
  assert.equal(tasks, 1);
});

test("rechazar nunca escribe en PSI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "encore-reservations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reserves = 0;
  const service = new ReservationService({ async reserve() { reserves++; throw new Error("must not run"); }, async reservations() { return []; } }, directory);
  const proposal = await service.propose("b".repeat(64), draft);
  await service.deny("b".repeat(64), proposal.id);
  assert.equal(reserves, 0);
});
