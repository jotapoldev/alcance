// Base local compartida por el servidor (UI) y el CLI (la sesión). node:sqlite, sin dependencias.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
// .env.local (ignorado por git) puede mover la base fuera del código: ALCANCE_DB=/ruta/alcance.db
try { process.loadEnvFile(join(root, ".env.local")); } catch {}
// Un proyecto por base: mspj usa la de siempre; otro (--proyecto capih o ALCANCE_PROYECTO) usa alcance-<proyecto>.db al lado.
const i = process.argv.indexOf("--proyecto");
export const PROYECTO = (i > 0 ? process.argv[i + 1] : process.env.ALCANCE_PROYECTO) || "mspj";
export const PROYECTOS = { mspj: 3220, capih: 3222 };
const base = process.env.ALCANCE_DB ?? join(root, "data", "alcance.db");
const file = PROYECTO === "mspj" ? base : base.replace(/.db$/, `-${PROYECTO}.db`);
mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL DEFAULT 'tarea',          -- requerimiento | tarea | bug | pentest
    titulo TEXT NOT NULL,
    sistema TEXT NOT NULL DEFAULT '',             -- proyecto o app (web, api, app...)
    estado TEXT NOT NULL DEFAULT 'pendiente',     -- pendiente | en-curso | en-pruebas | bloqueado | listo
    prioridad TEXT NOT NULL DEFAULT 'media',      -- alta | media | baja
    severidad TEXT NOT NULL DEFAULT '',           -- pentest: critica | alta | media | baja
    incluye TEXT NOT NULL DEFAULT '',             -- alcance acordado
    excluye TEXT NOT NULL DEFAULT '',             -- fuera de alcance
    dudas TEXT NOT NULL DEFAULT '',               -- preguntas abiertas para la PM
    ambientes TEXT NOT NULL DEFAULT '{}',         -- {"dev":true,"qa":false,...}
    pruebas TEXT NOT NULL DEFAULT '[]',           -- [{"caso":"...","resultado":null|"ok"|"falla"}]
    creado TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    actualizado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS avances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    autor TEXT NOT NULL DEFAULT 'yo',             -- yo | claude
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS historial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    cambio TEXT NOT NULL,                         -- texto legible: "estado: pendiente → en-curso"
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS commits (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (item_id, repo, sha)
  );
`);

// Migraciones simples: columnas que se agregaron después.
const columnas = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
if (!columnas("items").has("cerrado")) {
  db.exec("ALTER TABLE items ADD COLUMN cerrado TEXT");
  // Los ya terminados toman la fecha en que pasaron a listo (o su última actualización).
  db.exec(`UPDATE items SET cerrado = COALESCE(
    (SELECT MAX(h.fecha) FROM historial h WHERE h.item_id = items.id AND h.cambio LIKE '%→ listo'), actualizado)
    WHERE estado = 'listo'`);
}
const cc = columnas("commits");
// Análisis de impacto en markdown: solo lo llevan los tickets grandes, se muestra en su propia pestaña.
if (!columnas("items").has("analisis")) db.exec("ALTER TABLE items ADD COLUMN analisis TEXT NOT NULL DEFAULT ''");
for (const c of ["asunto", "cuando", "autor", "ambientes", "error", "revisado"]) {
  if (!cc.has(c)) db.exec(`ALTER TABLE commits ADD COLUMN ${c} TEXT`);
}
db.exec("CREATE INDEX IF NOT EXISTS ix_avances_item ON avances(item_id); CREATE INDEX IF NOT EXISTS ix_historial_item ON historial(item_id); CREATE INDEX IF NOT EXISTS ix_items_estado ON items(estado, cerrado);");

export const TIPOS = ["requerimiento", "tarea", "bug", "pentest"];
export const ESTADOS = ["pendiente", "en-curso", "en-pruebas", "bloqueado", "listo"];
export const PRIORIDADES = ["alta", "media", "baja"];
export const SEVERIDADES = ["", "critica", "alta", "media", "baja"];
export const AMBIENTES = ["dev", "qa", "uat", "prod"];

const CAMPOS = ["tipo", "titulo", "sistema", "estado", "prioridad", "severidad", "incluye", "excluye", "dudas", "analisis", "ambientes", "pruebas"];

// Valida en la frontera: lo que entra por la UI o el CLI nunca llega crudo a la base.
function limpiar(input) {
  const out = {};
  for (const k of CAMPOS) {
    if (!(k in input)) continue;
    let v = input[k];
    if (k === "ambientes") {
      const a = typeof v === "string" ? JSON.parse(v || "{}") : v ?? {};
      v = JSON.stringify(Object.fromEntries(AMBIENTES.map((x) => [x, !!a[x]])));
    } else if (k === "pruebas") {
      const p = typeof v === "string" ? JSON.parse(v || "[]") : v ?? [];
      if (!Array.isArray(p)) throw new Error("pruebas debe ser una lista");
      v = JSON.stringify(
        p.filter((x) => x && String(x.caso ?? "").trim())
          .map((x) => ({ caso: String(x.caso).trim(), resultado: ["ok", "falla"].includes(x.resultado) ? x.resultado : null })),
      );
    } else {
      v = String(v ?? "").trim();
    }
    if (k === "tipo" && !TIPOS.includes(v)) throw new Error(`tipo inválido: usa ${TIPOS.join(", ")}`);
    if (k === "estado" && !ESTADOS.includes(v)) throw new Error(`estado inválido: usa ${ESTADOS.join(", ")}`);
    if (k === "prioridad" && !PRIORIDADES.includes(v)) throw new Error(`prioridad inválida: usa ${PRIORIDADES.join(", ")}`);
    if (k === "severidad" && !SEVERIDADES.includes(v)) throw new Error(`severidad inválida: usa ${SEVERIDADES.filter(Boolean).join(", ")}`);
    if (k === "titulo" && !v) throw new Error("el título no puede ir vacío");
    out[k] = v;
  }
  return out;
}

const parse = (row) => row && { ...row, ambientes: JSON.parse(row.ambientes), pruebas: JSON.parse(row.pruebas) };

const registrar = (id, cambio) =>
  db.prepare("INSERT INTO historial (item_id, cambio) VALUES (?, ?)").run(Number(id), cambio);

// Solo se registran los campos con valor corto; los textos largos (alcance, dudas) se anotan como "editado".
const LARGOS = new Set(["incluye", "excluye", "dudas", "analisis", "titulo"]);
function describirCambios(antes, despues) {
  return Object.keys(despues).flatMap((k) => {
    const a = k === "ambientes" || k === "pruebas" ? JSON.stringify(antes[k]) : antes[k];
    if (a === despues[k]) return [];
    if (k === "pruebas") {
      const p = JSON.parse(despues[k]);
      return [`pruebas QA: ${p.filter((x) => x.resultado === "ok").length}/${p.length} pasan`];
    }
    if (k === "ambientes") {
      const on = Object.entries(JSON.parse(despues[k])).filter(([, v]) => v).map(([x]) => x);
      return [`ambientes: ${on.join(", ") || "ninguno"}`];
    }
    if (LARGOS.has(k)) return [`${k} editado`];
    return [`${k}: ${a || "—"} → ${despues[k] || "—"}`];
  });
}

export function listar() {
  return db.prepare("SELECT * FROM items ORDER BY actualizado DESC").all().map(parse);
}

// Commits guardados con su ambiente ya calculado (ver refrescarCommits en el servidor).
const leerCommit = (c) => ({
  repo: c.repo, sha: c.sha, asunto: c.asunto ?? "", cuando: c.cuando ?? "", autor: c.autor ?? "",
  ambientes: c.ambientes ? JSON.parse(c.ambientes) : null, error: c.error ?? null,
});

// Un ticket está en un ambiente cuando TODOS sus commits ya llegaron a esa rama.
function ambientesDeCommits(lista) {
  if (!lista.length || lista.some((c) => !c.ambientes)) return null;
  return Object.fromEntries(AMBIENTES.map((a) => [a, lista.every((c) => c.ambientes[a])]));
}

// Resumen liviano para la lista: sin avances ni historial, con conteo de commits y ambiente de git.
function conResumen(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marcas = ids.map(() => "?").join(",");
  const porItem = new Map();
  for (const c of db.prepare(`SELECT * FROM commits WHERE item_id IN (${marcas})`).all(...ids)) {
    if (!porItem.has(c.item_id)) porItem.set(c.item_id, []);
    porItem.get(c.item_id).push(leerCommit(c));
  }
  return rows.map((row) => {
    const i = parse(row), cs = porItem.get(i.id) ?? [];
    return { ...i, totalCommits: cs.length, commitRepos: [...new Set(cs.map((c) => c.repo))], ambientesGit: ambientesDeCommits(cs) };
  });
}

export function abiertos() {
  return conResumen(db.prepare("SELECT * FROM items WHERE estado != 'listo' ORDER BY actualizado DESC").all());
}

// Histórico por ventanas de fecha de cierre (más reciente primero). `q` busca en todo el histórico.
export function historico({ desde, q } = {}) {
  const like = q ? `%${String(q).trim()}%` : null;
  // "#41" o "41, 34 25": número de ticket exacto en vez de texto.
  const ids = like && /^#?\d+([\s,]+#?\d+)*$/.test(String(q).trim()) ? String(q).match(/\d+/g).map(Number) : null;
  const filtroQ = ids ? ` AND id IN (${ids.map(() => "?").join(",")})`
    : like ? " AND (titulo LIKE ? OR incluye LIKE ? OR excluye LIKE ? OR dudas LIKE ?)" : "";
  const argsQ = ids ?? (like ? [like, like, like, like] : []);
  const rows = like
    ? db.prepare(`SELECT * FROM items WHERE estado = 'listo'${filtroQ} ORDER BY cerrado DESC LIMIT 200`).all(...argsQ)
    : db.prepare("SELECT * FROM items WHERE estado = 'listo' AND cerrado >= ? ORDER BY cerrado DESC").all(desde);
  const hayMas = !like && !!db.prepare("SELECT 1 FROM items WHERE estado = 'listo' AND cerrado < ? LIMIT 1").get(desde);
  return { items: conResumen(rows), hayMas };
}

// Descarga a Excel (ver xlsx.mjs): por estado ("terminados", "abiertos" o uno del catálogo; vacío = todos),
// solo ciertos números de ticket y/o los últimos N. Más recientes primero; incluye commits y avances.
export function exportar({ estado = "", ids = "", n = "" } = {}) {
  const where = [], args = [];
  if (estado === "terminados") where.push("estado = 'listo'");
  else if (estado === "abiertos") where.push("estado != 'listo'");
  else if (ESTADOS.includes(estado)) { where.push("estado = ?"); args.push(estado); }
  const nums = String(ids).match(/\d+/g)?.map(Number) ?? [];
  if (nums.length) { where.push(`id IN (${nums.map(() => "?").join(",")})`); args.push(...nums); }
  const lim = Math.max(0, Math.floor(Number(n) || 0));
  const rows = db.prepare(`SELECT id FROM items${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
    ORDER BY COALESCE(cerrado, actualizado) DESC, id DESC${lim ? ` LIMIT ${lim}` : ""}`).all(...args);
  const columnas = [["Ticket", 9], ["Tipo", 14], ["Título", 50], ["Sistema", 22], ["Estado", 12], ["Prioridad", 11], ["Severidad", 11],
    ["Creado", 18], ["Cerrado", 18], ["Ambientes", 16], ["Pruebas QA", 13], ["Incluye", 60], ["Excluye", 40], ["Dudas", 50], ["Commits", 60], ["Avances", 80]]
    .map(([titulo, ancho]) => ({ titulo, ancho }));
  const filas = rows.map(({ id }) => {
    const i = detalle(id);
    const amb = i.ambientesGit ?? i.ambientes;
    return [i.id, i.tipo, i.titulo, i.sistema, i.estado, i.prioridad, i.severidad, i.creado, i.cerrado,
      AMBIENTES.filter((a) => amb[a]).join(", "),
      i.pruebas.length ? `${i.pruebas.filter((p) => p.resultado === "ok").length}/${i.pruebas.length} pasan` : "",
      i.incluye, i.excluye, i.dudas,
      i.commits.map((c) => `${c.repo} ${c.sha.slice(0, 8)} ${c.asunto}`.trim()).join("\n"),
      [...i.avances].reverse().map((a) => `${a.fecha} ${a.autor}: ${a.texto}`).join("\n")];
  });
  return { total: rows.length, columnas, filas };
}

export function detalle(id) {
  const i = obtener(id);
  if (!i) throw new Error(`no existe el ítem #${id}`);
  const commits = db.prepare("SELECT * FROM commits WHERE item_id = ?").all(i.id).map(leerCommit);
  return {
    ...i,
    commits,
    ambientesGit: ambientesDeCommits(commits),
    avances: db.prepare("SELECT * FROM avances WHERE item_id = ? ORDER BY fecha DESC, id DESC").all(i.id),
    historial: db.prepare("SELECT cambio, fecha FROM historial WHERE item_id = ? ORDER BY fecha DESC, id DESC").all(i.id),
  };
}

// Huella de "algo cambió": la UI la consulta cada 5 s y solo recarga si es distinta.
export function version() {
  const v = db.prepare(`SELECT
      (SELECT MAX(actualizado) FROM items) a, (SELECT COUNT(*) FROM items) b,
      (SELECT COUNT(*) FROM avances) c, (SELECT COUNT(*) FROM historial) d,
      (SELECT COUNT(*) FROM items WHERE estado = 'listo') cerrados,
      (SELECT MAX(revisado) FROM commits) e`).get();
  return { huella: [v.a, v.b, v.c, v.d, v.e].join("|"), cerrados: v.cerrados };
}

// Commits que todavía pueden cambiar de ambiente (no han llegado a todos) o nunca se revisaron.
export function commitsPendientes() {
  return db.prepare("SELECT DISTINCT repo, sha FROM commits WHERE ambientes IS NULL OR ambientes NOT LIKE '%\"prod\":true%'").all();
}

export function guardarCommit(repo, sha, info) {
  db.prepare(`UPDATE commits SET asunto = ?, cuando = ?, autor = ?, ambientes = ?, error = ?, revisado = datetime('now','localtime')
    WHERE repo = ? AND sha = ?`).run(
    info.asunto ?? null, info.cuando ?? null, info.autor ?? null,
    info.ambientes ? JSON.stringify(info.ambientes) : null, info.error ?? null, repo, sha);
}

export function asociar(id, repo, sha) {
  if (!obtener(id)) throw new Error(`no existe el ítem #${id}`);
  const r = String(repo ?? "").trim(), s = String(sha ?? "").trim();
  if (!r || !/^[0-9a-f]{6,40}$/i.test(s)) throw new Error("indicá el repo y un sha de commit válido");
  const nuevo = db.prepare("INSERT OR IGNORE INTO commits (item_id, repo, sha) VALUES (?, ?, ?)").run(Number(id), r, s);
  if (nuevo.changes) registrar(id, `commit ${s.slice(0, 8)} de ${r} asociado`);
  db.prepare("UPDATE items SET actualizado = datetime('now','localtime') WHERE id = ?").run(Number(id));
}

export function desasociar(id, repo, sha) {
  const fuera = db.prepare("DELETE FROM commits WHERE item_id = ? AND repo = ? AND sha = ?").run(Number(id), String(repo), String(sha));
  if (fuera.changes) registrar(id, `commit ${String(sha).slice(0, 8)} de ${repo} quitado`);
}

export function obtener(id) {
  return parse(db.prepare("SELECT * FROM items WHERE id = ?").get(Number(id)));
}

export function crear(input) {
  const data = limpiar({ tipo: "tarea", ...input });
  if (!data.titulo) throw new Error("el título no puede ir vacío");
  const keys = Object.keys(data);
  if (data.estado === "listo") { data.cerrado = new Date().toLocaleString("sv-SE").slice(0, 19); keys.push("cerrado"); }
  const r = db.prepare(`INSERT INTO items (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => data[k]));
  registrar(r.lastInsertRowid, `creado como ${data.tipo} (${data.estado ?? "pendiente"})`);
  return obtener(r.lastInsertRowid);
}

export function actualizar(id, input) {
  const antes = obtener(id);
  if (!antes) throw new Error(`no existe el ítem #${id}`);
  const data = limpiar(input);
  const keys = Object.keys(data);
  describirCambios(antes, data).forEach((c) => registrar(id, c));
  if (data.estado && data.estado !== antes.estado) {
    data.cerrado = data.estado === "listo" ? new Date().toLocaleString("sv-SE").slice(0, 19) : null;
    keys.push("cerrado");
  }
  if (keys.length) {
    db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(", ")}, actualizado = datetime('now','localtime') WHERE id = ?`)
      .run(...keys.map((k) => data[k]), Number(id));
  }
  return obtener(id);
}

export function borrar(id) {
  db.prepare("DELETE FROM avances WHERE item_id = ?").run(Number(id));
  db.prepare("DELETE FROM commits WHERE item_id = ?").run(Number(id));
  db.prepare("DELETE FROM historial WHERE item_id = ?").run(Number(id));
  db.prepare("DELETE FROM items WHERE id = ?").run(Number(id));
}

export function avance(id, texto, autor = "yo") {
  if (!obtener(id)) throw new Error(`no existe el ítem #${id}`);
  const t = String(texto ?? "").trim();
  if (!t) throw new Error("el avance no puede ir vacío");
  db.prepare("INSERT INTO avances (item_id, texto, autor) VALUES (?, ?, ?)").run(Number(id), t, autor === "claude" ? "claude" : "yo");
  db.prepare("UPDATE items SET actualizado = datetime('now','localtime') WHERE id = ?").run(Number(id));
}
