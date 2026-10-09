// Lectura de los repos locales con git (execFile, sin shell). Solo lee; nunca hace fetch ni escribe.
// Asíncrono para no congelar el servidor mientras git trabaja.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
// repos.json (local, ver repos.example.json): carpetas donde buscar repos y qué rama es cada ambiente.
// Sin repos.json la app funciona igual, solo sin la parte de git.
const archivo = process.env.ALCANCE_REPOS ?? join(root, "repos.json");
const conf = existsSync(archivo)
  ? JSON.parse(readFileSync(archivo, "utf8"))
  : { carpetas: [], ambientes: { develop: "dev", qa: "qa", uat: "uat", main: "prod" } };
export const RAMAS = conf.ambientes;

const git = async (cwd, ...args) => {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
};

export function repos() {
  return conf.carpetas.filter((base) => existsSync(base)).flatMap((base) =>
    readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(base, d.name, ".git")))
      .map((d) => ({ nombre: d.name, ruta: join(base, d.name) })));
}

const ruta = (repo) => repos().find((r) => r.nombre === repo)?.ruta;
const FECHA = "--date=format:%d/%m %H:%M";

// Estado de cada repo: rama actual, archivos sin commit y cuántos commits le faltan a cada ambiente.
export function estadoRepos() {
  return Promise.all(repos().map(async ({ nombre, ruta }) => {
    const [cambios, remotas, rama, sinPush, ultimo] = await Promise.all([
      git(ruta, "status", "--porcelain"),
      git(ruta, "branch", "-r", "--format=%(refname:short)"),
      git(ruta, "rev-parse", "--abbrev-ref", "HEAD"),
      git(ruta, "rev-list", "--count", "@{u}..HEAD"),
      git(ruta, "log", "-1", FECHA, "--format=%cd · %s"),
    ]);
    const ramas = Object.keys(RAMAS).filter((b) => remotas.split("\n").includes(`origin/${b}`) && b !== "develop");
    // develop es la fuente: cuánto de develop todavía no llegó a cada rama de ambiente.
    const conteos = await Promise.all(ramas.map((b) => git(ruta, "rev-list", "--count", "--no-merges", `origin/${b}..origin/develop`)));
    return {
      nombre,
      rama,
      sinCommit: cambios.split("\n").filter(Boolean).length,
      sinPush: Number(sinPush || 0),
      pendientes: Object.fromEntries(ramas.map((b, k) => [RAMAS[b], Number(conteos[k] || 0)])),
      ultimo,
    };
  }));
}

// Detalle de un commit y en qué ambientes ya está (ramas remotas que lo contienen).
export async function commit(repo, sha) {
  const r = ruta(repo);
  if (!r) return { error: "repo no encontrado" };
  const info = await git(r, "show", "-s", FECHA, "--format=%h%x1f%s%x1f%cd%x1f%an", sha);
  if (!info) return { error: "commit no encontrado en el repo local" };
  const [, asunto, cuando, autor] = info.split("\x1f");
  const contienen = (await git(r, "branch", "-r", "--contains", sha, "--format=%(refname:short)")).split("\n");
  const ambientes = Object.fromEntries(Object.entries(RAMAS).map(([b, amb]) => [amb, contienen.includes(`origin/${b}`)]));
  return { asunto, cuando, autor, ambientes };
}

// Commits recientes de un repo para elegir desde la UI.
export async function recientes(repo, n = 15) {
  const r = ruta(repo);
  if (!r) return [];
  return (await git(r, "log", "--all", `-${n}`, "--no-merges", FECHA, "--format=%h%x1f%s%x1f%cd"))
    .split("\n").filter(Boolean).map((l) => {
      const [sha, asunto, cuando] = l.split("\x1f");
      return { sha, asunto, cuando };
    });
}
