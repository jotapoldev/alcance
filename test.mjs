import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALCANCE_DB = join(mkdtempSync(join(tmpdir(), "alcance-")), "t.db");
const { crear, actualizar, avance, detalle, abiertos, historico, version } = await import("./db.mjs");

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
