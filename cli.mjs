// CLI para actualizar Alcance desde la sesión (Claude o terminal). Escribe directo a la base;
// la UI abierta lo ve en su siguiente refresco (cada 5 s).
//   node cli.mjs add "título" [--tipo requerimiento] [--sistema web] [--estado en-curso] [--prioridad alta]
//                    [--severidad alta] [--incluye "..."] [--excluye "..."] [--dudas "..."] [--ambientes dev,qa]
//   node cli.mjs set <id> --estado listo [--ambientes dev,qa,uat] [...mismos campos]
//   node cli.mjs set <id> --analisis-file analisis.md   (análisis de impacto en markdown, pestaña Análisis)
//   node cli.mjs nota <id> "texto del avance"        (queda firmado como claude)
//   node cli.mjs prueba <id> "caso" [ok|falla]
//   node cli.mjs ls [--estado en-curso] [--tipo pentest]
//   node cli.mjs commit <id> <repo> <sha> [<sha>...]  (asocia commits; el ambiente sale de las ramas que los contienen)
import { listar, crear, actualizar, avance, obtener, asociar, guardarCommit, AMBIENTES } from "./db.mjs";
import { commit } from "./git.mjs";
import { readFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i] ?? "";
  else pos.push(rest[i]);
}
delete flags.proyecto; // lo lee db.mjs para elegir la base
if ("analisis-file" in flags) {
  flags.analisis = readFileSync(flags["analisis-file"], "utf8");
  delete flags["analisis-file"];
}
if ("ambientes" in flags) {
  const on = flags.ambientes.split(",").map((s) => s.trim().toLowerCase());
  flags.ambientes = Object.fromEntries(AMBIENTES.map((a) => [a, on.includes(a)]));
}
const linea = (i) => `#${i.id} [${i.tipo}] ${i.estado.padEnd(10)} ${i.sistema ? `(${i.sistema}) ` : ""}${i.titulo}`;

try {
  if (cmd === "add") {
    const i = crear({ ...flags, titulo: pos[0] });
    console.log(`creado ${linea(i)}`);
  } else if (cmd === "set") {
    console.log(`actualizado ${linea(actualizar(pos[0], flags))}`);
  } else if (cmd === "nota") {
    avance(pos[0], pos[1], "claude");
    console.log(`avance agregado a #${pos[0]}`);
  } else if (cmd === "prueba") {
    const i = obtener(pos[0]);
    if (!i) throw new Error(`no existe el ítem #${pos[0]}`);
    const resultado = ["ok", "falla"].includes(pos[2]) ? pos[2] : null;
    const pruebas = i.pruebas.filter((p) => p.caso !== pos[1]).concat({ caso: pos[1], resultado });
    actualizar(i.id, { pruebas });
    console.log(`prueba en #${i.id}: ${pos[1]} -> ${resultado ?? "sin probar"}`);
  } else if (cmd === "commit") {
    const [id, repo, ...shas] = pos;
    for (const s of shas) {
      asociar(id, repo, s);
      guardarCommit(repo, s, await commit(repo, s));
    }
    console.log(`#${id}: ${shas.length} commit(s) de ${repo} asociados`);
  } else if (cmd === "ls") {
    listar()
      .filter((i) => (!flags.estado || i.estado === flags.estado) && (!flags.tipo || i.tipo === flags.tipo))
      .forEach((i) => console.log(linea(i)));
  } else {
    console.log("Uso: node cli.mjs add|set|nota|prueba|ls (ver cabecera de cli.mjs)");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
