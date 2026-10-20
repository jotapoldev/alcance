import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALCANCE_DB = join(mkdtempSync(join(tmpdir(), "alcance-")), "t.db");
const { crear, actualizar, avance, detalle, abiertos, historico, version, exportar } = await import("./db.mjs");

test("exporta a Excel por estado, por número y los últimos N", async () => {
  const a = crear({ titulo: "Export abierto", sistema: "web" });
  const b = crear({ titulo: 'Export "listo" <&>', estado: "listo" });
  avance(b.id, "probado en qa");
  const r = exportar({ ids: `#${a.id}, ${b.id}` });
  assert.equal(r.total, 2);
  assert.equal(r.filas[0][0], b.id);
  assert.match(r.filas[0].at(-1), /: probado en qa$/);
  const { xlsx } = await import("./xlsx.mjs");
  const { inflateRawSync } = await import("node:zlib");
  const archivo = xlsx("Tickets", r.columnas, r.filas);
  assert.equal(archivo.readUInt32LE(0), 0x04034b50);
  // La hoja es el quinto archivo del zip: se busca su cabecera local y se descomprime.
  const i = archivo.indexOf("xl/worksheets/sheet1.xml");
  const hoja = inflateRawSync(archivo.subarray(i + 24, i + 24 + archivo.readUInt32LE(i - 12))).toString();
  assert.ok(hoja.includes("Export &quot;listo&quot; &lt;&amp;&gt;"));
  assert.equal(exportar({ ids: `${a.id} ${b.id}`, estado: "terminados" }).total, 1);
  assert.equal(exportar({ ids: `${a.id} ${b.id}`, estado: "abiertos" }).total, 1);
  assert.equal(exportar({ estado: "pendiente", ids: String(a.id) }).total, 1);
  assert.equal(exportar({ n: "1" }).total, 1);
});

test("crea, limpia ambientes y pruebas, y guarda avances", () => {
  const i = crear({ titulo: "  Login sin captcha  ", tipo: "bug", ambientes: { dev: 1, qa: true, nada: true }, pruebas: [{ caso: "x", resultado: "raro" }, { caso: " " }] });
  assert.equal(i.titulo, "Login sin captcha");
  assert.deepEqual(i.ambientes, { dev: true, qa: true, uat: false, prod: false });
  assert.deepEqual(i.pruebas, [{ caso: "x", resultado: null }]);
  avance(i.id, "subido a qa", "claude");
  assert.equal(detalle(i.id).avances[0].autor, "claude");
});

test("rechaza valores fuera de catálogo y título vacío", () => {
  assert.throws(() => crear({ titulo: "a", estado: "hecho" }), /estado inválido/);
  assert.throws(() => crear({ titulo: "   " }), /título/);
  const i = crear({ titulo: "ok" });
  assert.throws(() => actualizar(i.id, { severidad: "mega" }), /severidad inválida/);
});

test("cerrar manda el ticket al histórico con fecha y la huella cambia", () => {
  const i = crear({ titulo: "cerrable" });
  const antes = version().huella;
  actualizar(i.id, { estado: "listo" });
  assert.notEqual(version().huella, antes);
  assert.ok(!abiertos().some((x) => x.id === i.id));
  const h = historico({ desde: "2000-01-01" });
  assert.ok(h.items.some((x) => x.id === i.id && x.cerrado));
  assert.equal(historico({ desde: "2999-01-01" }).hayMas, true);
  actualizar(i.id, { estado: "en-curso" });
  assert.ok(abiertos().some((x) => x.id === i.id && x.cerrado === null));
});

test("el histórico busca por número de ticket exacto", () => {
  const a = crear({ titulo: "Ticket por número A", estado: "listo" });
  const b = crear({ titulo: "Ticket por número B", estado: "listo" });
  assert.deepEqual(historico({ q: `#${a.id}` }).items.map((i) => i.id), [a.id]);
  assert.deepEqual(historico({ q: `${a.id}, ${b.id}` }).items.map((i) => i.id).sort(), [a.id, b.id].sort());
});

test("modo ranked: RP por ticket, rango y avance de la semana", async () => {
  const { juego, puntosDe } = await import("./juego.mjs");
  assert.equal(puntosDe({ tipo: "bug", prioridad: "media", pruebas: "[]" }), 50);
  assert.equal(puntosDe({ tipo: "pentest", severidad: "alta", prioridad: "alta", pruebas: [{ resultado: "ok" }, { resultado: null }] }), 235);

  const antes = juego("2026-10-14");
  for (let n = 0; n < 3; n++) actualizar(crear({ titulo: `ranked ${n}`, tipo: "tarea" }).id, { estado: "listo" });
  const { db } = await import("./db.mjs");
  db.prepare("UPDATE items SET cerrado = '2026-10-13 10:00:00' WHERE titulo LIKE 'ranked %'").run();
  const despues = juego("2026-10-14");
  assert.equal(despues.ganado - antes.ganado, 90);
  assert.equal(despues.semana.cerrados - antes.semana.cerrados, 3);
  assert.equal(juego("2026-10-21").semana.cerrados, 0);
});
