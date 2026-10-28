// Servidor local: sirve la UI y una API JSON mínima. Solo escucha en 127.0.0.1.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  abiertos, historico, exportar, detalle, version, crear, actualizar, borrar, avance, asociar, desasociar,
  commitsPendientes, guardarCommit, TIPOS, ESTADOS, PRIORIDADES, SEVERIDADES, AMBIENTES, PROYECTO, PROYECTOS } from "./db.mjs";
import { estadoRepos, commit, recientes, repos } from "./git.mjs";
import { juego } from "./juego.mjs";
import { xlsx } from "./xlsx.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? PROYECTOS[PROYECTO] ?? 3220);
// Selector de proyecto en el encabezado: cada proyecto es otro servidor con su propia base.
const selector = () => `<style>.proy{display:flex;gap:2px;padding:3px;border:1px solid var(--line,#ddd);border-radius:10px;margin-left:12px}
.proy a{padding:4px 12px;border-radius:7px;font:600 12px ui-monospace,monospace;color:inherit;opacity:.7;text-decoration:none;text-transform:uppercase}
.proy a[aria-current]{background:#3B2FD6;color:#fff;opacity:1}</style><script>document.querySelector("header .spacer")?.insertAdjacentHTML("beforebegin",
'<nav class="proy" aria-label="Proyecto">${Object.entries(PROYECTOS).map(([n, p]) => `<a href="http://localhost:${p}/"${n === PROYECTO ? " aria-current=page" : ""}>${n}</a>`).join("")}</nav>');
document.title="${PROYECTO} · "+document.title</script>`;

// El ambiente de cada commit se guarda en la base: solo se vuelven a revisar los que todavía no
// llegan a prod, en segundo plano, cada 2 min o con el botón "Actualizar" de la UI.
let revisando = null;
function refrescarCommits() {
  revisando ??= (async () => {
    for (const { repo, sha } of commitsPendientes()) guardarCommit(repo, sha, await commit(repo, sha));
  })().finally(() => { revisando = null; });
  return revisando;
}
setInterval(() => refrescarCommits().catch(() => {}), 120_000);
refrescarCommits().catch(() => {});

// Estado de los repos con caché corto: son varios procesos de git por repo.
let reposCache = { t: 0, v: [] };
async function reposEstado(fresco) {
  if (fresco || Date.now() - reposCache.t > 60_000) reposCache = { t: Date.now(), v: await estadoRepos() };
  return reposCache.v;
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const body = async (req) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("cuerpo demasiado grande");
  }
  return raw ? JSON.parse(raw) : {};
};

const ESTATICOS = { "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"], "/icon.svg": ["icon.svg", "image/svg+xml"] };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const fresco = url.searchParams.has("fresco");
  const m = p.match(/^\/api\/items(?:\/(\d+))?(\/avances|\/commits)?$/);
  try {
    if (ESTATICOS[p]) {
      const [archivo, tipo] = ESTATICOS[p];
      res.writeHead(200, { "content-type": tipo });
      const cuerpo = await readFile(join(root, "public", archivo));
      return res.end(archivo === "index.html" ? cuerpo.toString("utf8").replace("</body>", selector() + "</body>") : cuerpo);
    }
    if (p === "/api/meta") return json(res, 200, { TIPOS, ESTADOS, PRIORIDADES, SEVERIDADES, AMBIENTES, REPOS: repos().map((r) => r.nombre) });
    if (p === "/api/version") return json(res, 200, version());
    if (p === "/api/juego") return json(res, 200, juego());
    if (p === "/api/exportar") {
      const { columnas, filas } = exportar(Object.fromEntries(url.searchParams));
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="alcance-${new Date().toLocaleDateString("sv-SE")}.xlsx"`,
      });
      return res.end(xlsx("Tickets", columnas, filas));
    }
    if (p === "/api/repos") return json(res, 200, await reposEstado(fresco));
    const rc = p.match(/^\/api\/repos\/([\w.-]+)\/commits$/);
    if (rc) return json(res, 200, await recientes(rc[1]));
    if (m && !m[1] && req.method === "GET") {
      if (fresco) await refrescarCommits();
      if (url.searchParams.get("vista") === "historico") {
        return json(res, 200, historico({ desde: url.searchParams.get("desde") ?? "", q: url.searchParams.get("q") ?? "" }));
      }
      return json(res, 200, abiertos());
    }
    if (m && !m[1] && req.method === "POST") return json(res, 201, crear(await body(req)));
    if (m && m[1] && !m[2] && req.method === "GET") return json(res, 200, detalle(m[1]));
    if (m && m[1] && m[2] === "/avances" && req.method === "POST") {
      const b = await body(req);
      avance(m[1], b.texto, b.autor);
      return json(res, 201, { ok: true });
    }
    if (m && m[1] && m[2] === "/commits") {
      const b = await body(req);
      if (req.method === "POST") {
        asociar(m[1], b.repo, b.sha);
        guardarCommit(String(b.repo), String(b.sha), await commit(b.repo, b.sha));
      } else if (req.method === "DELETE") desasociar(m[1], b.repo, b.sha);
      return json(res, 200, { ok: true });
    }
    if (m && m[1] && !m[2] && req.method === "PATCH") return json(res, 200, actualizar(m[1], await body(req)));
    if (m && m[1] && !m[2] && req.method === "DELETE") {
      borrar(m[1]);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "Ruta no encontrada" });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`alcance_ en http://localhost:${PORT}`));
