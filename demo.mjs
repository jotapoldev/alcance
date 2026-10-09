// Demo con datos de ejemplo en una base aparte (.demo/): no toca tu base real.
//   npm run demo   ->  http://localhost:3221
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
process.env.ALCANCE_DB = join(root, ".demo", "alcance.db");
process.env.PORT ??= "3221";
process.env.ALCANCE_REPOS = join(root, ".demo", "sin-repos.json"); // la demo no lee tus repos
rmSync(join(root, ".demo"), { recursive: true, force: true });

const { crear, actualizar, avance } = await import("./db.mjs");
const t = (o, extra = {}) => {
  const i = crear(o);
  if (extra.nota) avance(i.id, extra.nota, "claude");
  if (extra.listo) actualizar(i.id, { estado: "listo" });
  return i;
};

t({ titulo: "Login: bloquear la cuenta tras 5 intentos fallidos", tipo: "requerimiento", sistema: "web", estado: "en-curso", prioridad: "alta",
  incluye: "Contador por usuario, bloqueo de 15 minutos y aviso por correo.", excluye: "Captcha (va en otro ticket).",
  dudas: "¿El bloqueo es por usuario o por IP?", ambientes: { dev: true },
  pruebas: [{ caso: "5 intentos fallidos bloquean la cuenta", resultado: "ok" }, { caso: "Al minuto 16 se puede volver a entrar", resultado: null }] },
  { nota: "Backend listo en develop; falta el mensaje en la pantalla de login." });
t({ titulo: "Reporte mensual exporta fechas en formato equivocado", tipo: "bug", sistema: "web", estado: "en-pruebas", prioridad: "media",
  incluye: "Usar dd/mm/aaaa en el Excel.", ambientes: { dev: true, qa: true },
  pruebas: [{ caso: "Exportar el reporte de marzo y revisar la columna fecha", resultado: null }] });
t({ titulo: "Subida de archivos acepta ejecutables renombrados", tipo: "pentest", sistema: "api", estado: "pendiente", prioridad: "alta", severidad: "alta",
  incluye: "Validar el tipo por contenido (magic bytes), lista blanca y tamaño máximo.", dudas: "¿Hay antivirus disponible para escanear?" });
t({ titulo: "Notificar al aprobador cuando tenga un delegado activo", tipo: "requerimiento", sistema: "app", estado: "pendiente", prioridad: "baja",
  dudas: "¿Dónde va el aviso: en el inicio o en la bandeja de aprobaciones?" });
t({ titulo: "Timeouts en el cliente HTTP del servicio externo", tipo: "tarea", sistema: "api", estado: "bloqueado", prioridad: "media",
  incluye: "Timeout de conexión y de lectura; cortar reintentos infinitos." }, { nota: "Esperando credenciales del ambiente de pruebas." });
t({ titulo: "Paginación del histórico de pedidos", tipo: "tarea", sistema: "web", estado: "listo", ambientes: { dev: true, qa: true, uat: true, prod: true } }, { listo: true });
t({ titulo: "El botón Guardar quedaba deshabilitado sin motivo", tipo: "bug", sistema: "app", estado: "listo", ambientes: { dev: true, qa: true, uat: true, prod: true } }, { listo: true });

console.log("Datos de ejemplo listos.");
await import("./server.mjs");
