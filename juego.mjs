// Modo ranked: RP por ticket cerrado, rango y avance de la semana. Todo se calcula de los tickets en "listo".
import { db } from "./db.mjs";

const BASE = { tarea: 30, bug: 50, requerimiento: 100 };
const PENTEST = { critica: 200, alta: 150, media: 100, baja: 50 };

/** RP de un ticket cerrado: por tipo (pentest por severidad), ×1.5 si es prioridad alta, +10 por prueba QA en OK. */
export function puntosDe(item) {
  const base = item.tipo === "pentest" ? (PENTEST[item.severidad] ?? 100) : (BASE[item.tipo] ?? 30);
  const pruebas = typeof item.pruebas === "string" ? JSON.parse(item.pruebas) : item.pruebas ?? [];
  const ok = pruebas.filter((p) => p.resultado === "ok").length;
  return Math.round(base * (item.prioridad === "alta" ? 1.5 : 1)) + ok * 10;
}

export const RANGOS = [
  ["Hierro", 0], ["Bronce", 500], ["Plata", 1500], ["Oro", 3000], ["Platino", 5000],
  ["Esmeralda", 8000], ["Diamante", 12000], ["Maestro", 18000], ["Challenger", 25000],
];

// Lunes de la semana de una fecha "YYYY-MM-DD..." (semanas de lunes a domingo).
const lunesDe = (fecha) => {
  const d = new Date(`${fecha.slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString("sv-SE");
};

/** RP ganados, rango con su siguiente escalón y tickets cerrados esta semana contra los que faltan. */
export function juego(hoy = new Date().toLocaleDateString("sv-SE")) {
  const cerrados = db.prepare("SELECT tipo, severidad, prioridad, pruebas, cerrado FROM items WHERE estado = 'listo' AND cerrado IS NOT NULL").all();
  const abiertos = db.prepare("SELECT COUNT(*) n FROM items WHERE estado <> 'listo'").get().n;
  const ganado = cerrados.reduce((n, i) => n + puntosDe(i), 0);

  const idx = RANGOS.findLastIndex(([, min]) => ganado >= min);
  const [rango, minRango] = RANGOS[idx];
  const siguiente = RANGOS[idx + 1] ?? null;
  const lunes = lunesDe(hoy);

  return {
    ganado, rango, minRango,
    siguiente: siguiente && { rango: siguiente[0], min: siguiente[1] },
    semana: { lunes, cerrados: cerrados.filter((i) => lunesDe(i.cerrado) === lunes).length, abiertos },
  };
}
