"use client";

import { useCallback, useEffect, useState } from "react";
import { CopilotChat, useAgentContext, useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { requestFollowups as api } from "@/lib/followup-client";

type Resource = { id: number; nombre: string; ubicacion: string; capacidad: number; descripcion: string | null };
type EventType = { id: number; nombre: string };
type Catalog = { aulas: Resource[]; auditorios: Resource[]; tiposEventoAula: EventType[]; tiposEventoAuditorio: EventType[] };
type Tramite = { id: string | number; titulo: string; estado: string; createdAt: string; detalle: Record<string, unknown> };
type Proposal = { id: string; tipo: "aula" | "auditorio"; recursoId: number; tipoEventoId: number; nombre: string; descripcion: string; inicio: string; fin: string; horarios?: Array<{ dia: number; inicio: string; fin: string }>; expiresAt: number };
type Result = { reservacion: { id: string; estado: "APROBADA" | "PENDIENTE" }; decision: "auto_aprobada" | "escalada_a_humano"; motivo: string; verificadoEn: string; seguimiento: { status: string; task?: { id: string; url: string | null }; message?: string } };

const schema = z.object({ tipo: z.enum(["aula", "auditorio"]), recursoId: z.number().int().positive(), tipoEventoId: z.number().int().positive(), nombre: z.string().trim().min(3).max(100), descripcion: z.string().trim().min(10).max(500), inicio: z.string().datetime(), fin: z.string().datetime(), horarios: z.array(z.object({ dia: z.number().int().min(1).max(7), inicio: z.string().regex(/^\d{2}:\d{2}$/), fin: z.string().regex(/^\d{2}:\d{2}$/) })).min(1).optional() });
type Draft = z.infer<typeof schema>;

export function EncoreApp() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [reservations, setReservations] = useState<Tramite[]>([]);
  const [proposal, setProposal] = useState<Proposal>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tipo, setTipo] = useState<"aula" | "auditorio">("auditorio");
  const [recursoId, setRecursoId] = useState(0);
  const [tipoEventoId, setTipoEventoId] = useState(0);
  const [nombre, setNombre] = useState("Reserva Encore");
  const [descripcion, setDescripcion] = useState("Evento institucional gestionado con Encore.");
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");

  const refresh = useCallback(async () => {
    const state = await api<{ catalog: Catalog; reservations: Tramite[] }>("");
    setCatalog(state.catalog); setReservations(state.reservations); return state;
  }, []);
  useEffect(() => { refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "No se pudo cargar PSI.")); }, [refresh]);
  const resources = tipo === "aula" ? catalog?.aulas ?? [] : catalog?.auditorios ?? [];
  const eventTypes = tipo === "aula" ? catalog?.tiposEventoAula ?? [] : catalog?.tiposEventoAuditorio ?? [];
  const selected = resources.find((resource) => resource.id === recursoId) ?? resources[0];
  const iso = (value: string) => new Date(value).toISOString();
  const draft = (): Draft => schema.parse({ tipo, recursoId: recursoId || selected?.id, tipoEventoId: tipoEventoId || eventTypes[0]?.id, nombre, descripcion, inicio: iso(inicio), fin: iso(fin), ...(tipo === "aula" ? { horarios: [{ dia: new Date(inicio).getDay() || 7, inicio: new Date(inicio).toTimeString().slice(0, 5), fin: new Date(fin).toTimeString().slice(0, 5) }] } : {}) });
  const availability = useCallback(async (input: Draft) => api<{ availability: { disponible: boolean; conflictos: unknown[]; mensaje: string } }>("", { operation: "availability", ...input }), []);
  const propose = useCallback(async (input: Draft) => { const response = await api<{ proposal: Proposal }>("", { operation: "propose", ...input }); setProposal(response.proposal); return response.proposal; }, []);
  useAgentContext({ description: "Contexto real de PSI para reservar espacios. El chat solo puede consultar disponibilidad y proponer una reservación. Nunca ejecuta la escritura: el botón de aprobación llama al servidor, que actúa con los permisos PSI del usuario configurado.", value: JSON.parse(JSON.stringify({ catalog, selectedSpace: selected ?? null, reservations, pendingProposal: proposal ?? null, lastReservation: result ?? null })) });
  useFrontendTool({ name: "consultar_disponibilidad", description: "Consulta disponibilidad real de un aula o auditorio de PSI. Solo lectura: no crea reservaciones.", parameters: schema, handler: async (input) => availability(input) }, [availability]);
  useFrontendTool({ name: "proponer_reservacion", description: "Prepara una reservación PSI para revisión. No escribe nada. Después, el usuario debe pulsar Aprobar y reservar en PSI en la página.", parameters: schema, handler: async (input) => ({ status: "pendiente_de_aprobacion", proposal: await propose(input) }) }, [propose]);
  const prepare = async () => { setBusy(true); setError(""); try { await propose(draft()); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo preparar la propuesta."); } finally { setBusy(false); } };
  const check = async () => { setBusy(true); setError(""); try { const response = await availability(draft()); setError(response.availability.mensaje); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo consultar disponibilidad."); } finally { setBusy(false); } };
  const approve = async () => { if (!proposal) return; setBusy(true); setError(""); try { const response = await api<{ result: Result }>("", { operation: "approve", proposalId: proposal.id }); setResult(response.result); setProposal(undefined); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo confirmar la reservación."); } finally { setBusy(false); } };
  const decline = async () => { if (!proposal) return; setBusy(true); try { await api("", { operation: "deny", proposalId: proposal.id }); setProposal(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo rechazar."); } finally { setBusy(false); } };

  return <main className="ck-workspace"><header className="ck-workspace-header"><div><p className="ck-eyebrow">Encore · PSI · agente con permisos heredados</p><h1>Reservaciones institucionales</h1><p className="ck-intro">Consulta, propone y revisa antes de que PSI aplique sus reglas reales.</p></div><span className="ck-tag">PSI real</span></header><div className="ck-workspace-grid"><section className="ck-panel" aria-labelledby="reservation-title"><h2 id="reservation-title">Nueva reservación</h2><div className="ck-task-form ck-task-form--stacked"><label>Tipo<select value={tipo} onChange={(event) => { setTipo(event.target.value as "aula" | "auditorio"); setRecursoId(0); setTipoEventoId(0); }}><option value="auditorio">Auditorio</option><option value="aula">Aula</option></select></label><label>Espacio<select value={recursoId || selected?.id || ""} onChange={(event) => setRecursoId(Number(event.target.value))}>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.nombre} · {resource.capacidad} personas</option>)}</select></label><label>Tipo de evento<select value={tipoEventoId || eventTypes[0]?.id || ""} onChange={(event) => setTipoEventoId(Number(event.target.value))}>{eventTypes.map((eventType) => <option key={eventType.id} value={eventType.id}>{eventType.nombre}</option>)}</select></label><input value={nombre} onChange={(event) => setNombre(event.target.value)} aria-label="Nombre del evento" /><textarea value={descripcion} onChange={(event) => setDescripcion(event.target.value)} aria-label="Descripción" rows={3} /><label>Inicio<input type="datetime-local" value={inicio} onChange={(event) => setInicio(event.target.value)} required /></label><label>Fin<input type="datetime-local" value={fin} onChange={(event) => setFin(event.target.value)} required /></label><div className="ck-approval-actions"><button type="button" className="ck-btn" disabled={busy || !inicio || !fin} onClick={check}>Consultar disponibilidad</button><button type="button" className="ck-btn ck-btn--primary" disabled={busy || !inicio || !fin} onClick={prepare}>Proponer reservación</button></div></div>{proposal && <section className="ck-approval"><h3>Revisa antes de reservar en PSI</h3><p><strong>{proposal.nombre}</strong> · {proposal.tipo} #{proposal.recursoId}</p><p>{new Date(proposal.inicio).toLocaleString("es-MX")} — {new Date(proposal.fin).toLocaleString("es-MX")}</p><p>El chat no ha escrito nada. PSI recibirá estos campos exactos solo después de tu clic.</p><div className="ck-approval-actions"><button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={approve}>Aprobar y reservar en PSI</button><button type="button" className="ck-btn" disabled={busy} onClick={decline}>Rechazar</button></div></section>}{result && <section className="ck-approval"><h3>Reservación confirmada por PSI</h3><p><code>{result.reservacion.id}</code> · <strong>{result.reservacion.estado}</strong></p><p><strong>{result.decision === "auto_aprobada" ? "Autoaprobada" : "Escalada a humano"}:</strong> {result.motivo}</p><p>Tarea Ambiguous: {result.seguimiento.status === "creada" ? <>{result.seguimiento.task?.url ? <a href={result.seguimiento.task.url} target="_blank" rel="noreferrer">abrir tarea</a> : result.seguimiento.task?.id}</> : result.seguimiento.message}</p></section>}{error && <p role="alert" className="ck-error">{error}</p>}<h3>Mis reservaciones en PSI</h3>{reservations.length ? <ul className="ck-task-list">{reservations.map((reservation) => <li key={String(reservation.id)}><div><strong>{reservation.titulo}</strong><code className="ck-record-id">{String(reservation.id)}</code><span>{reservation.estado}</span></div></li>)}</ul> : <p className="ck-empty">Sin reservaciones disponibles para el usuario PSI configurado.</p>}</section><section className="ck-panel ck-assistant"><header className="ck-assistant-header"><h2>Asistente Encore</h2><p>Consulta PSI y prepara propuestas; nunca escribe directamente.</p></header><CopilotChat className="ck-chat" labels={{ welcomeMessageText: "¿Qué espacio necesitas reservar?", chatInputPlaceholder: "Ej. resérvame el auditorio el jueves de 10 a 12" }} /></section></div></main>;
}
