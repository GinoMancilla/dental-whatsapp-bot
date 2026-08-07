require("dotenv").config();
const express   = require("express");
const axios     = require("axios");
const { Resend } = require("resend");
const { google } = require("googleapis");
const Anthropic  = require("@anthropic-ai/sdk");
const crypto    = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ─── Configuración ────────────────────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  RESEND_API_KEY,
  GOOGLE_CALENDAR_ID,
  GOOGLE_SPREADSHEET_ID,
} = process.env;

const CLINICA_NOMBRE    = process.env.CLINICA_NOMBRE    || "Clínica Dental";
const CLINICA_TELEFONO  = process.env.CLINICA_TELEFONO  || "";
const CLINICA_EMAIL     = process.env.CLINICA_EMAIL     || "";
const DOCTOR_EMAIL      = process.env.DOCTOR_EMAIL      || "";
const EMAIL_DOMAIN      = process.env.EMAIL_DOMAIN      || "clinica.cl";
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const DASHBOARD_TOKEN   = process.env.DASHBOARD_TOKEN   || VERIFY_TOKEN;
const DASHBOARD_USER    = process.env.DASHBOARD_USER    || "";  // login legado (1 solo usuario)
const DASHBOARD_PASS    = process.env.DASHBOARD_PASS    || "";  // si vacío → solo acceso por token

// ─── Cuentas del panel (multi-usuario) ───────────────────────────────────────
// PANEL_USERS = JSON [{ user, pass }]. El par legado DASHBOARD_USER/PASS se
// mantiene como una cuenta más (compatibilidad hacia atrás).
let PANEL_USERS = [];
try { PANEL_USERS = JSON.parse(process.env.PANEL_USERS || "[]"); } catch { PANEL_USERS = []; }
if (!Array.isArray(PANEL_USERS)) PANEL_USERS = [];
if (DASHBOARD_USER && DASHBOARD_PASS && !PANEL_USERS.some(u => u.user === DASHBOARD_USER)) {
  PANEL_USERS.push({ user: DASHBOARD_USER, pass: DASHBOARD_PASS });
}
const HAY_LOGIN = PANEL_USERS.length > 0;   // hay al menos una cuenta configurada

// ─── Sesiones del dashboard (login usuario/contraseña, cookie firmada 8h) ────
const panelSessions = new Map();
const PANEL_TTL = 8 * 60 * 60 * 1000;
function getPanelSession(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)panel_sid=([^;]+)/);
  if (!m) return null;
  const exp = panelSessions.get(m[1]);
  if (!exp || Date.now() > exp) { panelSessions.delete(m[1]); return null; }
  return m[1];
}
function createPanelSession(res) {
  const sid = crypto.randomBytes(32).toString("hex");
  panelSessions.set(sid, Date.now() + PANEL_TTL);
  res.setHeader("Set-Cookie", `panel_sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${PANEL_TTL / 1000}`);
}
function clearPanelSession(req, res) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)panel_sid=([^;]+)/);
  if (m) panelSessions.delete(m[1]);
  res.setHeader("Set-Cookie", "panel_sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
}
// Limpia sesiones vencidas cada hora
setInterval(() => { const now = Date.now(); for (const [sid, exp] of panelSessions) if (now > exp) panelSessions.delete(sid); }, 60 * 60 * 1000);
const SECRETARIA_PHONE  = process.env.SECRETARIA_PHONE  || "";   // WhatsApp de la secretaria para notificaciones
const LINK_PAGO         = process.env.LINK_PAGO         || "";   // Link de pago para abonos (Mercado Pago / Flow)
const GOOGLE_MAPS_URL   = process.env.GOOGLE_MAPS_URL   || "";   // Link para reseñas de Google Maps
const CLINICA_DIRECCION = process.env.CLINICA_DIRECCION || "";
const CLINICA_HORARIO   = process.env.CLINICA_HORARIO   || "Lunes a Viernes, 9:00 a 19:00 hrs";
const RECALL_MESES      = parseInt(process.env.RECALL_MESES || "6", 10); // Meses sin venir para recall

// ─── Rubro (vertical) de la clínica ──────────────────────────────────────────
// El bot adapta su vocabulario según el rubro. RUBRO elige el preset; las
// variables RUBRO_* permiten ajuste fino puntual sin tocar el código.
const { RUBROS } = require("./rubros");
const R = { ...(RUBROS[process.env.RUBRO] || RUBROS.dental) };
if (process.env.RUBRO_EMOJI)     R.emoji        = process.env.RUBRO_EMOJI;
if (process.env.RUBRO_SERVICIO)  R.servicioSing = process.env.RUBRO_SERVICIO;
if (process.env.RUBRO_URGENCIA)  R.urgencia     = /^(1|true|si|sí)$/i.test(process.env.RUBRO_URGENCIA);
if (process.env.RUBRO_PIDE_RUT)  R.pideRut      = /^(1|true|si|sí)$/i.test(process.env.RUBRO_PIDE_RUT);
// Regex de urgencia compilada una vez (o null si el rubro no maneja urgencias)
const URGENCIA_RE = R.urgencia && R.urgenciaPalabras
  ? new RegExp(R.urgenciaPalabras + "|emergencia|urgente|urgencia", "i")
  : null;

// ─── Servicios de la clínica ─────────────────────────────────────────────────
// Se editan en la pestaña "Servicios" del Sheet (o desde el panel maestro).
// El bot los lee en vivo con caché de 5 min — la secretaria cambia precios sin redeploy.
// El catálogo inicial de una clínica nueva viene del preset de su rubro.
const TRATAMIENTOS_DEFAULT = R.servicios;
// Cada clínica decide si publica precios por WhatsApp
const MOSTRAR_PRECIOS = /^(1|true|si|sí)$/i.test(process.env.MOSTRAR_PRECIOS || "");

// ─── Pagos: Mercado Pago (cuenta propia de la clínica) ───────────────────────
const pago = require("./pago");
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";   // token de la cuenta MP de la clínica
const PAGO_EXPIRA_MIN = parseInt(process.env.PAGO_EXPIRA_MIN || "20", 10);
const PUBLIC_URL      = (process.env.PUBLIC_URL || "").replace(/\/$/, ""); // dominio del bot (para el webhook de MP)
const pagosPendientes = new Map(); // citaId → { ts, datos } — respaldo en memoria
const cobrosActivo = () => !!(MP_ACCESS_TOKEN && PUBLIC_URL);

// ─── Disponibilidad del calendario ───────────────────────────────────────────
// La clínica define su horario tipo en la pestaña "Horario" del Sheet y el bot
// genera los eventos "DISPONIBLE". Manual (desde el panel) o automático.
const TZ = "America/Santiago";
const DIAS_SEMANA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const DURACION_BLOQUE_MIN  = parseInt(process.env.DURACION_BLOQUE_MIN || "30", 10);
const AUTO_DISPONIBILIDAD  = /^(1|true|si|sí)$/i.test(process.env.AUTO_DISPONIBILIDAD || "");
const AUTO_SEMANAS         = parseInt(process.env.AUTO_SEMANAS || "4", 10);

// Horario por defecto de una clínica nueva: lun-vie 9-13 y 15-19
const HORARIO_DEFAULT = [
  ["Lunes",     "09:00", "13:00", "15:00", "19:00"],
  ["Martes",    "09:00", "13:00", "15:00", "19:00"],
  ["Miércoles", "09:00", "13:00", "15:00", "19:00"],
  ["Jueves",    "09:00", "13:00", "15:00", "19:00"],
  ["Viernes",   "09:00", "13:00", "15:00", "19:00"],
  ["Sábado",    "",      "",      "",      ""     ],
  ["Domingo",   "",      "",      "",      ""     ],
];

// "YYYY-MM-DD" del día de hoy en horario de Chile
function hoyLocal() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}
// Día de la semana (0=dom) de una fecha "YYYY-MM-DD", sin líos de zona horaria
function diaSemanaDe(fecha) {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}
function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const hhmmAMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const minAHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
// Clave local "YYYY-MM-DD HH:MM" de un instante — evita aritmética de offsets/DST
function claveLocal(dateLike) {
  return new Date(dateLike).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16);
}

// Lee la pestaña "Horario" → { 0..6: [{desde,hasta}, ...] }
async function getHorario() {
  const vacio = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) return vacio;
  try {
    const sheets = await sheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Horario!A2:E8",
    });
    const horario = { ...vacio };
    for (const row of (r.data.values || [])) {
      const idx = DIAS_SEMANA.findIndex(d => d.toLowerCase() === (row[0] || "").trim().toLowerCase());
      if (idx < 0) continue;
      const tramos = [];
      for (const [ini, fin] of [[row[1], row[2]], [row[3], row[4]]]) {
        const a = (ini || "").trim(), b = (fin || "").trim();
        if (/^\d{1,2}:\d{2}$/.test(a) && /^\d{1,2}:\d{2}$/.test(b) && hhmmAMin(b) > hhmmAMin(a)) {
          tramos.push({ desde: a, hasta: b });
        }
      }
      horario[idx] = tramos;
    }
    return horario;
  } catch (e) {
    console.error("getHorario:", e.message);
    return vacio;
  }
}

// Genera eventos DISPONIBLE entre dos fechas "YYYY-MM-DD" (inclusive).
// No pisa citas existentes ni duplica bloques ya publicados.
async function generarDisponibilidad(fechaDesde, fechaHasta, calendarId = GOOGLE_CALENDAR_ID) {
  if (!googleAuth || !calendarId) throw new Error("Google Calendar no configurado");
  const horario = await getHorario();
  if (!Object.values(horario).some(t => t.length)) {
    return { creados: 0, saltados: 0, error: "La clínica no tiene horario configurado" };
  }

  const auth = await googleAuth.getClient();
  const cal  = google.calendar({ version: "v3", auth });

  // Bloques ya ocupados (DISPONIBLE o CITA) en el rango — una sola consulta
  const ocupados = new Set();
  const r = await cal.events.list({
    calendarId,
    timeMin: new Date(`${fechaDesde}T00:00:00Z`).toISOString(),
    timeMax: new Date(`${sumarDias(fechaHasta, 1)}T23:59:59Z`).toISOString(),
    singleEvents: true, maxResults: 2500,
  });
  for (const ev of (r.data.items || [])) {
    if (!ev.start?.dateTime) continue;
    // Marcar todos los sub-bloques que cubre el evento (una cita de 60min tapa 2 de 30min)
    let t = new Date(ev.start.dateTime).getTime();
    const fin = new Date(ev.end?.dateTime || ev.start.dateTime).getTime();
    do {
      ocupados.add(claveLocal(t));
      t += DURACION_BLOQUE_MIN * 60000;
    } while (t < fin);
  }

  // Construir la lista de bloques a crear
  const ahoraClave = claveLocal(Date.now());
  const aCrear = [];
  for (let f = fechaDesde; f <= fechaHasta; f = sumarDias(f, 1)) {
    for (const tramo of horario[diaSemanaDe(f)]) {
      for (let m = hhmmAMin(tramo.desde); m + DURACION_BLOQUE_MIN <= hhmmAMin(tramo.hasta); m += DURACION_BLOQUE_MIN) {
        const hora  = minAHhmm(m);
        const clave = `${f} ${hora}`;
        if (ocupados.has(clave)) continue;   // ya hay algo ahí
        if (clave <= ahoraClave) continue;   // en el pasado
        aCrear.push({ fecha: f, desde: hora, hasta: minAHhmm(m + DURACION_BLOQUE_MIN) });
      }
    }
  }

  // Insertar en lotes pequeños con backoff: Calendar limita las ráfagas de escritura
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function insertarSlot(b) {
    for (let intento = 0; intento < 4; intento++) {
      try {
        await cal.events.insert({
          calendarId,
          requestBody: {
            summary: "DISPONIBLE",
            start: { dateTime: `${b.fecha}T${b.desde}:00`, timeZone: TZ },
            end:   { dateTime: `${b.fecha}T${b.hasta}:00`, timeZone: TZ },
            colorId: "5",
          },
        });
        return true;
      } catch (e) {
        const limite = /rate limit|quota|429|403/i.test(e.message);
        if (!limite || intento === 3) {
          console.error(`slot ${b.fecha} ${b.desde}:`, e.message);
          return false;
        }
        await sleep(500 * Math.pow(2, intento) + Math.random() * 300); // backoff con jitter
      }
    }
    return false;
  }

  let creados = 0;
  const LOTE = 3;
  for (let i = 0; i < aCrear.length; i += LOTE) {
    const res = await Promise.all(aCrear.slice(i, i + LOTE).map(insertarSlot));
    creados += res.filter(Boolean).length;
    if (i + LOTE < aCrear.length) await sleep(250);
  }
  const fallidos = aCrear.length - creados;
  console.log(`📅 Disponibilidad ${fechaDesde}→${fechaHasta}: ${creados} creados${fallidos ? `, ${fallidos} fallidos` : ""}, ${ocupados.size} ocupados previos`);
  return { creados, fallidos, ocupados: ocupados.size };
}

// Traduce un período ("semana", "mes", …) a un rango de fechas
function rangoDePeriodo(periodo) {
  const hoy = hoyLocal();
  const [y, m] = hoy.split("-").map(Number);
  const ultimoDiaDe = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  switch (periodo) {
    case "semana":       return [hoy, sumarDias(hoy, 7)];
    case "2semanas":     return [hoy, sumarDias(hoy, 14)];
    case "mes":          return [hoy, `${y}-${String(m).padStart(2, "0")}-${ultimoDiaDe(y, m)}`];
    case "proximo-mes": {
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      const mm = String(nm).padStart(2, "0");
      return [`${ny}-${mm}-01`, `${ny}-${mm}-${ultimoDiaDe(ny, nm)}`];
    }
    default:             return [hoy, sumarDias(hoy, 28)];
  }
}

// Multi-doctor: DOCTORES = [{"nombre":"Dra. Pérez","calendarId":"...@group.calendar.google.com"}]
// Si está vacío, se usa GOOGLE_CALENDAR_ID (modo un solo calendario)
let DOCTORES = [];
try { DOCTORES = JSON.parse(process.env.DOCTORES || "[]"); }
catch { console.warn("⚠️  DOCTORES no es JSON válido — modo un solo calendario"); }

function calendarIdForDoctor(nombreDoctor) {
  const doc = DOCTORES.find(d => d.nombre === nombreDoctor);
  return doc?.calendarId || GOOGLE_CALENDAR_ID;
}

if (!WHATSAPP_APP_SECRET) console.warn("⚠️  WHATSAPP_APP_SECRET no configurado — verificación de firma Meta desactivada");
if (!GOOGLE_CALENDAR_ID)  console.warn("⚠️  GOOGLE_CALENDAR_ID no configurado — usando slots de demo");
if (!GOOGLE_SPREADSHEET_ID) console.warn("⚠️  GOOGLE_SPREADSHEET_ID no configurado — registro en Sheets desactivado");

// Google Auth (Service Account JSON codificado en base64)
let googleAuth = null;
const GOOGLE_SA_RAW = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (GOOGLE_SA_RAW) {
  try {
    const credentials = JSON.parse(Buffer.from(GOOGLE_SA_RAW, "base64").toString("utf8"));
    googleAuth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });
    console.log("✅ Google Auth configurado");
  } catch (e) {
    console.warn("⚠️  Error parseando GOOGLE_SERVICE_ACCOUNT_JSON:", e.message);
  }
}

const resendClient = RESEND_API_KEY                ? new Resend(RESEND_API_KEY) : null;
const anthropic    = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ─── Google Sheets: helpers de bajo nivel ─────────────────────────────────────
// Columnas de "Citas" (A→R):
//  0 A ID | 1 B Timestamp | 2 C Teléfono | 3 D Nombre | 4 E RUT | 5 F Email
//  6 G Tratamiento | 7 H Urgente | 8 I Fecha Cita | 9 J Hora Cita | 10 K Estado
// 11 L Notas | 12 M FechaHora ISO | 13 N EventID | 14 O Canal | 15 P Recordatorio
// 16 Q Encuesta | 17 R Doctor
async function sheetsClient() {
  const auth = await googleAuth.getClient();
  return google.sheets({ version: "v4", auth });
}

async function getCitasRows() {
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) return [];
  try {
    const sheets = await sheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Citas!A2:S",
    });
    return (r.data.values || [])
      .map((row, i) => ({ row, rowNum: i + 2 }))
      .filter(({ row }) => row.length > 1);
  } catch (e) {
    console.error("getCitasRows:", e.message);
    return [];
  }
}

async function setCitaCell(rowNum, colLetter, value) {
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) return;
  try {
    const sheets = await sheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `Citas!${colLetter}${rowNum}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] },
    });
  } catch (e) {
    console.error("setCitaCell:", e.message);
  }
}

async function appendTabRow(tab, values) {
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) return;
  try {
    const sheets = await sheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${tab}!A:Z`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
  } catch (e) {
    console.error(`appendTabRow ${tab}:`, e.message);
  }
}

// Crea las pestañas ListaEspera, Recalls y Servicios si no existen, y actualiza los headers
async function ensureSheetSetup() {
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) return;
  try {
    const sheets = await sheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID });
    const titles = meta.data.sheets.map(s => s.properties.title);
    const requests = [];
    for (const t of ["ListaEspera", "Recalls", "Servicios", "Horario"]) {
      if (!titles.includes(t)) requests.push({ addSheet: { properties: { title: t } } });
    }
    if (requests.length) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: GOOGLE_SPREADSHEET_ID, requestBody: { requests } });
    }

    // Horario: headers + horario tipo inicial solo si está vacío
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Horario!A1:E1",
      valueInputOption: "RAW",
      requestBody: { values: [["Día", "Desde", "Hasta", "Desde 2", "Hasta 2"]] },
    });
    const hor = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: "Horario!A2:A" });
    if (!(hor.data.values || []).length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: "Horario!A2:E8",
        valueInputOption: "RAW", // conserva "09:00" como texto
        requestBody: { values: HORARIO_DEFAULT },
      });
      console.log("🕐 Horario de atención inicial creado");
    }

    // Servicios: headers + catálogo inicial solo si la pestaña está vacía
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Servicios!A1:E1",
      valueInputOption: "RAW",
      requestBody: { values: [["Servicio", "Precio", "Duración", "Activo", "Abono"]] },
    });
    const svc = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: "Servicios!A2:A" });
    if (!(svc.data.values || []).length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: "Servicios!A2:E",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: TRATAMIENTOS_DEFAULT.map(n => [n, "", "", "Sí", ""]) },
      });
      console.log("📋 Catálogo de servicios inicial creado");
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Citas!A1:S1",
      valueInputOption: "RAW",
      requestBody: { values: [[
        "ID","Timestamp","Teléfono","Nombre","RUT","Email","Tratamiento","Urgente",
        "Fecha Cita","Hora Cita","Estado","Notas","FechaHora ISO","EventID","Canal",
        "Recordatorio","Encuesta","Doctor","Precio",
      ]] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "ListaEspera!A1:F1",
      valueInputOption: "RAW",
      requestBody: { values: [["Timestamp","Teléfono","Nombre","Tratamiento","Canal","Estado"]] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Recalls!A1:C1",
      valueInputOption: "RAW",
      requestBody: { values: [["Timestamp","Teléfono","Nombre"]] },
    });
    console.log("✅ Estructura de Sheets verificada (Citas, ListaEspera, Recalls)");
  } catch (e) {
    console.error("ensureSheetSetup:", e.message);
  }
}
ensureSheetSetup();

// ─── Twilio (canal alternativo para sandbox/demo) ─────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM        = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    const TwilioSDK = require("twilio");
    twilioClient = TwilioSDK(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log("✅ Twilio client configurado");
  } catch (e) {
    console.warn("⚠️  Twilio SDK no disponible:", e.message);
  }
}

// ─── Seguridad: firma Meta ────────────────────────────────────────────────────
function verificarFirma(req) {
  if (!WHATSAPP_APP_SECRET) return true;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WHATSAPP_APP_SECRET)
    .update(req.rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}

// ─── Seguridad: firma Twilio ──────────────────────────────────────────────────
// Valida X-Twilio-Signature para que solo Twilio pueda invocar /webhook-twilio.
// Sin esto, cualquiera que conozca la URL puede suplantar pacientes.
function verificarFirmaTwilio(req) {
  if (!TWILIO_AUTH_TOKEN) return true; // sin auth token no hay forma de validar (modo demo sin Twilio)
  const sig = req.headers["x-twilio-signature"];
  if (!sig) return false;
  try {
    const TwilioSDK = require("twilio");
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    return TwilioSDK.validateRequest(TWILIO_AUTH_TOKEN, sig, url, req.body || {});
  } catch (e) {
    console.error("verificarFirmaTwilio:", e.message);
    return false;
  }
}

// ─── Seguridad: comparación de tokens sin fuga de timing ─────────────────────
function tokenOk(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Valida un login contra cualquiera de las cuentas del panel (comparación segura)
function loginValido(user, pass) {
  for (const u of PANEL_USERS) {
    if (tokenOk(user, u.user || "") && tokenOk(pass, u.pass || "")) return true;
  }
  return false;
}

// ─── Seguridad: escape HTML (anti-XSS en dashboard y emails) ─────────────────
function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─── Rate limiting HTTP por IP (ventana deslizante 60s) ──────────────────────
const httpRl = new Map();
function httpRateLimitOk(ip, max = 30) {
  const now = Date.now();
  const recent = (httpRl.get(ip) || []).filter(t => now - t < 60000);
  recent.push(now);
  httpRl.set(ip, recent);
  return recent.length <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of httpRl.entries()) {
    const recent = arr.filter(t => now - t < 60000);
    if (recent.length) httpRl.set(ip, recent); else httpRl.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── Rate limiting (ventana deslizante) ──────────────────────────────────────
const rlMap = new Map();
function rateLimitOk(phone) {
  const now = Date.now();
  const e = rlMap.get(phone) || { msgs: [], block: 0 };
  if (e.block > now) return false;
  e.msgs = e.msgs.filter(t => now - t < 60000);
  e.msgs.push(now);
  rlMap.set(phone, e);
  if (e.msgs.length > 15) { e.block = now + 60000; return false; }
  return true;
}

// ─── Deduplicación de mensajes ────────────────────────────────────────────────
const seen = new Map();
function isDuplicate(id, phone, text) {
  if (seen.has(id)) return true;
  const key = `${phone}:${text}`;
  if (seen.has(key) && Date.now() - seen.get(key) < 5000) return true;
  seen.set(id, Date.now());
  seen.set(key, Date.now());
  setTimeout(() => { seen.delete(id); seen.delete(key); }, 60000);
  return false;
}

// ─── Jobs periódicos (persistentes — leen desde Google Sheets) ──────────────
// Sobreviven reinicios de Railway: la fuente de verdad es la planilla, no la memoria.
const ESTADOS_INACTIVOS = ["Cancelada", "Reagendada"];
const pendingSurveys = new Map(); // phone → { rowNum, ts } (respaldo en col Q de Sheets)

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function horaChile() {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "America/Santiago", hour: "2-digit", hour12: false }), 10);
}

// 1) Recordatorio 24h antes con confirmación de asistencia (entre 9-11 AM)
async function jobRecordatorios() {
  const manana = new Date(Date.now() + 24 * 3600 * 1000);
  const rows = await getCitasRows();
  for (const { row, rowNum } of rows) {
    if (ESTADOS_INACTIVOS.includes(row[10])) continue;
    if (row[15] === "Enviado") continue;
    if (!row[12]) continue;
    const citaDate = new Date(row[12]);
    if (isNaN(citaDate) || !sameDay(citaDate, manana)) continue;
    const phone = (row[2] || "").replace(/\D/g, "");
    if (!phone) continue;
    try {
      const session = getSession(phone);
      session.channel = row[14] || "twilio";
      session.paso    = "recordatorio_resp";
      session.d = {
        nombre: row[3], rut: row[4], email: row[5], tratamiento: row[6],
        doctor: row[17] || null, recRowNum: rowNum, recEventId: row[13],
        fechaCita: row[8], horaCita: row[9],
      };
      await btns(phone,
        `⏰ *Recordatorio — ${CLINICA_NOMBRE}*\n\n` +
        `Hola ${row[3]} 👋, *mañana* tienes una cita:\n\n` +
        `${R.emoji} ${row[6]}\n📅 ${row[8]}\n⏰ ${row[9]}\n\n` +
        `¿Confirmas tu asistencia?`,
        [
          { id: "rec_confirmo",  label: "✅ Confirmo asistencia" },
          { id: "rec_reagendar", label: "🔄 Necesito reagendar" },
          { id: "rec_cancelar",  label: "❌ Cancelar cita" },
        ]
      );
      await setCitaCell(rowNum, "P", "Enviado");
      console.log(`⏰ Recordatorio con confirmación enviado a ${phone}`);
    } catch (e) {
      console.error(`Recordatorio a ${phone}:`, e.message);
    }
  }
}

// 1b) Estados de citas pasadas: Confirmada → Atendida | Agendada sin confirmar → No asistió
async function jobEstadosPasados() {
  const now = Date.now();
  const rows = await getCitasRows();
  for (const { row, rowNum } of rows) {
    if (!row[12]) continue;
    const ms = new Date(row[12]).getTime();
    if (isNaN(ms) || now < ms + 60 * 60 * 1000) continue; // 1h de gracia tras la hora de la cita
    const estado = row[10];
    if (estado === "Confirmada") {
      await setCitaCell(rowNum, "K", "Atendida");
      console.log(`✔️ Cita de ${row[3]} marcada Atendida`);
    } else if (estado === "Agendada" || estado === "Pendiente confirmación") {
      await setCitaCell(rowNum, "K", "No asistió");
      notifySecretaria(
        `📵 Paciente no asistió (no confirmó su cita):\n` +
        `👤 ${row[3]}\n📅 ${row[8]} · ${row[9]}\n${R.emoji} ${row[6]}\n📱 ${row[2]}\n\n` +
        `Sugerencia: contactar para reagendar.`
      );
      console.log(`📵 Cita de ${row[3]} marcada No asistió`);
    }
  }
}

// 2) Encuesta post-atención (2 horas después de la cita)
async function jobEncuestas() {
  const now = Date.now();
  const rows = await getCitasRows();
  for (const { row, rowNum } of rows) {
    if (ESTADOS_INACTIVOS.includes(row[10])) continue;
    if (row[10] === "No asistió") continue; // sin atención no hay encuesta
    if (row[16]) continue; // encuesta ya enviada o respondida
    if (!row[12]) continue;
    const citaMs = new Date(row[12]).getTime();
    if (isNaN(citaMs)) continue;
    if (now < citaMs + 2 * 3600 * 1000) continue;        // aún no pasan 2h
    if (now > citaMs + 7 * 24 * 3600 * 1000) continue;   // cita muy antigua, no molestar
    const phone = (row[2] || "").replace(/\D/g, "");
    if (!phone) continue;
    try {
      const session = getSession(phone);
      session.channel = row[14] || "twilio";
      await msg(phone,
        `Hola ${row[3]} 👋 Gracias por visitarnos hoy en *${CLINICA_NOMBRE}*.\n\n` +
        `*¿Cómo calificarías tu atención?*\nResponde con un número del *1 al 5* ⭐\n\n` +
        `_1 = muy mala · 5 = excelente_`
      );
      await setCitaCell(rowNum, "Q", "Enviada");
      pendingSurveys.set(phone, { rowNum, ts: now });
      console.log(`📝 Encuesta enviada a ${phone}`);
    } catch (e) {
      console.error(`Encuesta a ${phone}:`, e.message);
    }
  }
  // Limpiar encuestas pendientes de más de 48h
  for (const [p, v] of pendingSurveys.entries()) {
    if (now - v.ts > 48 * 3600 * 1000) pendingSurveys.delete(p);
  }
}

// 3) Recall: pacientes que no vienen hace RECALL_MESES meses (1 vez al día)
let lastRecallDay = "";
async function jobRecalls() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (lastRecallDay === hoy) return;
  lastRecallDay = hoy;

  const rows = await getCitasRows();
  const ultimaCita = {}; // phone → { ms, nombre, channel }
  for (const { row } of rows) {
    if (ESTADOS_INACTIVOS.includes(row[10])) continue;
    if (!row[12]) continue;
    const ms = new Date(row[12]).getTime();
    if (isNaN(ms)) continue;
    const phone = (row[2] || "").replace(/\D/g, "");
    if (!phone) continue;
    if (!ultimaCita[phone] || ms > ultimaCita[phone].ms) {
      ultimaCita[phone] = { ms, nombre: row[3], channel: row[14] || "twilio" };
    }
  }

  // Recalls ya enviados en los últimos 60 días
  let recallRecientes = new Set();
  try {
    const sheets = await sheetsClient();
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: "Recalls!A2:C" });
    const limite60d = Date.now() - 60 * 24 * 3600 * 1000;
    for (const rr of (r.data.values || [])) {
      const ts = new Date(rr[0]).getTime();
      if (!isNaN(ts) && ts > limite60d) recallRecientes.add((rr[1] || "").replace(/\D/g, ""));
    }
  } catch { /* pestaña puede no existir aún */ }

  const limiteMeses = new Date();
  limiteMeses.setMonth(limiteMeses.getMonth() - RECALL_MESES);

  for (const [phone, info] of Object.entries(ultimaCita)) {
    if (info.ms > limiteMeses.getTime()) continue; // vino hace poco
    if (info.ms > Date.now()) continue;            // tiene cita futura
    if (recallRecientes.has(phone)) continue;
    try {
      const session = getSession(phone);
      session.channel = info.channel;
      await msg(phone,
        `Hola ${info.nombre} 👋 Te escribimos de *${CLINICA_NOMBRE}*.\n\n` +
        `Ya han pasado más de ${RECALL_MESES} meses desde tu última visita ${R.emoji}\n` +
        `Un control preventivo a tiempo evita tratamientos más complejos.\n\n` +
        `¿Quieres agendar una hora? Escribe *1* y te muestro los horarios disponibles 😊`
      );
      await appendTabRow("Recalls", [new Date().toISOString(), phone, info.nombre]);
      console.log(`🔁 Recall enviado a ${phone}`);
    } catch (e) {
      console.error(`Recall a ${phone}:`, e.message);
    }
  }
}

setInterval(async () => {
  const h = horaChile();
  try {
    if (h >= 9 && h <= 11) await jobRecordatorios();
    await jobEstadosPasados(); // antes de encuestas: los No asistió no reciben encuesta
    await jobEncuestas();
    if (h === 10) await jobRecalls();
    if (h === 7)  await jobAutoDisponibilidad(); // publica horas antes de abrir
  } catch (e) {
    console.error("Job periódico:", e.message);
  }
}, 60 * 60 * 1000); // Cada hora

// ─── Sesiones en memoria (TTL 30 min) ────────────────────────────────────────
const sessions = {};
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions)) {
    if (now - s.ts > 30 * 60 * 1000) { delete sessions[k]; }
  }
}, 5 * 60 * 1000);

function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { paso: "inicio", d: {}, err: 0, ts: Date.now() };
  sessions[phone].ts = Date.now();
  return sessions[phone];
}

// ─── WhatsApp: envío de mensajes ──────────────────────────────────────────────
async function waPost(phone, payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to: phone, ...payload },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("WA error:", e.response?.data?.error?.message || e.message);
  }
}

async function msg(phone, text) {
  const channel = sessions[phone]?.channel;
  if (channel === "twilio" && twilioClient) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to:   `whatsapp:+${phone}`,
        body: text,
      });
    } catch (e) {
      console.error("Twilio msg error:", e.message);
    }
  } else {
    await waPost(phone, { type: "text", text: { body: text } });
  }
}

async function btns(phone, text, buttons) {
  const channel = sessions[phone]?.channel;
  if (channel === "twilio") {
    // Twilio sandbox no soporta botones interactivos — usar lista numerada
    await msg(phone, text + "\n\n" + buttons.map((b, i) => `${i + 1}. ${b.label}`).join("\n"));
  } else {
    try {
      if (buttons.length > 3) {
        // WhatsApp permite máx 3 botones → usar lista interactiva (hasta 10 filas)
        await waPost(phone, {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text },
            action: {
              button: "Ver opciones",
              sections: [{
                title: "Opciones",
                rows: buttons.map(b => ({ id: b.id, title: b.label.substring(0, 24) })),
              }],
            },
          },
        });
      } else {
        await waPost(phone, {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text },
            action: {
              buttons: buttons.map(b => ({
                type: "reply",
                reply: { id: b.id, title: b.label.substring(0, 20) },
              })),
            },
          },
        });
      }
    } catch {
      await msg(phone, text + "\n\n" + buttons.map((b, i) => `${i + 1}. ${b.label}`).join("\n"));
    }
  }
}

// ─── Notificaciones directas (secretaria / lista de espera) ──────────────────
async function sendToPhone(phone, text, channel) {
  if (channel === "twilio" && twilioClient) {
    try {
      await twilioClient.messages.create({ from: TWILIO_FROM, to: `whatsapp:+${phone}`, body: text });
    } catch (e) {
      console.error("sendToPhone twilio:", e.message);
    }
  } else {
    await waPost(phone, { type: "text", text: { body: text } });
  }
}

async function notifySecretaria(text) {
  if (!SECRETARIA_PHONE) return;
  // En demo la secretaria usa el sandbox Twilio; en producción el canal Meta
  await sendToPhone(SECRETARIA_PHONE.replace(/\D/g, ""), `🔔 *${CLINICA_NOMBRE} — Aviso interno*\n\n${text}`, twilioClient ? "twilio" : "meta");
}

// ─── Cancelación / reagendamiento de citas ────────────────────────────────────
async function citasActivasDe(phone) {
  const clean = phone.replace(/\D/g, "");
  const rows = await getCitasRows();
  const now = Date.now();
  return rows.filter(({ row }) =>
    (row[2] || "").replace(/\D/g, "") === clean &&
    !ESTADOS_INACTIVOS.includes(row[10]) &&
    row[12] && new Date(row[12]).getTime() > now
  );
}

// Devuelve el evento de Calendar a estado DISPONIBLE para que otro paciente lo tome
async function liberarSlot(eventId, calendarId) {
  if (!googleAuth || !calendarId || !eventId || eventId.startsWith("demo-")) return;
  try {
    const auth = await googleAuth.getClient();
    const cal  = google.calendar({ version: "v3", auth });
    await cal.events.patch({
      calendarId,
      eventId,
      requestBody: { summary: "DISPONIBLE", description: "", colorId: "5" },
    });
    console.log(`📅 Slot ${eventId} liberado (DISPONIBLE)`);
  } catch (e) {
    console.error("liberarSlot:", e.message);
  }
}

async function cancelarCitaRow(citaObj, nuevoEstado = "Cancelada") {
  const { row, rowNum } = citaObj;
  await setCitaCell(rowNum, "K", nuevoEstado);
  await liberarSlot(row[13], calendarIdForDoctor(row[17]));
  notifySecretaria(
    `❌ Cita ${nuevoEstado.toLowerCase()}:\n` +
    `👤 ${row[3]}\n📅 ${row[8]} · ${row[9]}\n${R.emoji} ${row[6]}\n📱 ${row[2]}`
  );
  notificarListaEspera(row[8], row[9]);
}

// ─── Lista de espera ──────────────────────────────────────────────────────────
async function agregarListaEspera(phone, nombre, tratamiento, channel) {
  await appendTabRow("ListaEspera", [
    new Date().toISOString(), phone, nombre || "", tratamiento || "", channel || "twilio", "Esperando",
  ]);
  notifySecretaria(`📋 Nuevo paciente en lista de espera:\n👤 ${nombre}\n${R.emoji} ${tratamiento}\n📱 ${phone}`);
}

// Cuando se libera un cupo, avisa al primero de la lista
async function notificarListaEspera(fecha, hora) {
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) return;
  try {
    const sheets = await sheetsClient();
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID, range: "ListaEspera!A2:F" });
    const rows = r.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][5] || "") !== "Esperando") continue;
      const phone   = (rows[i][1] || "").replace(/\D/g, "");
      const nombre  = rows[i][2] || "";
      const channel = rows[i][4] || "twilio";
      if (!phone) continue;
      await sendToPhone(phone,
        `🎉 ¡Buenas noticias, ${nombre}!\n\n` +
        `Se liberó un cupo en *${CLINICA_NOMBRE}*:\n📅 ${fecha} · ⏰ ${hora}\n\n` +
        `Escribe *1* para agendar antes de que se ocupe ${R.emoji}`, channel);
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `ListaEspera!F${i + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["Notificado"]] },
      });
      console.log(`📣 Lista de espera: notificado ${phone}`);
      break; // solo el primero
    }
  } catch (e) {
    console.error("notificarListaEspera:", e.message);
  }
}

// ─── Google Calendar: slots disponibles ──────────────────────────────────────
// La secretaria crea eventos con título "DISPONIBLE" en el calendario del doctor.
// El bot lee esos eventos y los presenta al paciente como horarios disponibles.
// Al confirmar la cita, el bot renombra el evento con los datos del paciente.
async function getSlots(calendarId = GOOGLE_CALENDAR_ID) {
  if (!googleAuth || !calendarId) return getDemoSlots();
  try {
    const auth  = await googleAuth.getClient();
    const cal   = google.calendar({ version: "v3", auth });
    const now   = new Date();
    const limit = new Date(now);
    limit.setDate(limit.getDate() + 21);
    const r = await cal.events.list({
      calendarId,
      timeMin:     now.toISOString(),
      timeMax:     limit.toISOString(),
      q:           "DISPONIBLE",
      singleEvents: true,
      orderBy:     "startTime",
      maxResults:  30,
    });
    const eventos = (r.data.items || []).filter(e => /DISPONIBLE/i.test(e.summary || ""));
    return eventos.slice(0, 8).map(e => ({
      id:    e.id,
      start: e.start.dateTime,
      label: fmtDT(e.start.dateTime),
    }));
  } catch (e) {
    console.error("Calendar getSlots error:", e.message);
    return getDemoSlots();
  }
}

// Todos los slots DISPONIBLE entre dos fechas "YYYY-MM-DD" (para el panel de agenda)
async function getSlotsRango(fechaDesde, fechaHasta, calendarId = GOOGLE_CALENDAR_ID) {
  if (!googleAuth || !calendarId) return [];
  try {
    const auth = await googleAuth.getClient();
    const cal  = google.calendar({ version: "v3", auth });
    const r = await cal.events.list({
      calendarId,
      timeMin: new Date(`${fechaDesde}T00:00:00`).toISOString(),
      timeMax: new Date(`${sumarDias(fechaHasta, 1)}T00:00:00`).toISOString(),
      q: "DISPONIBLE", singleEvents: true, orderBy: "startTime", maxResults: 2500,
    });
    return (r.data.items || [])
      .filter(e => /DISPONIBLE/i.test(e.summary || "") && e.start?.dateTime)
      .map(e => {
        const d = new Date(e.start.dateTime);
        return {
          id: e.id,
          fecha: e.start.dateTime.slice(0, 10),
          hora: e.start.dateTime.slice(11, 16),
          start: e.start.dateTime,
        };
      });
  } catch (e) {
    console.error("getSlotsRango:", e.message);
    return [];
  }
}

function getDemoSlots() {
  const slots = [];
  const base  = new Date();
  base.setHours(0, 0, 0, 0);
  for (let d = 1; slots.length < 8 && d <= 21; d++) {
    const day = new Date(base);
    day.setDate(day.getDate() + d);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    for (const h of [9, 10, 11, 14, 15, 16]) {
      if (slots.length >= 8) break;
      const s = new Date(day);
      s.setHours(h, 0, 0, 0);
      slots.push({ id: `demo-${d}-${h}`, start: s.toISOString(), label: fmtDT(s.toISOString()) });
    }
  }
  return slots;
}

async function bookSlot(eventId, datos, calendarId = GOOGLE_CALENDAR_ID) {
  if (!googleAuth || !calendarId || eventId.startsWith("demo-")) {
    console.log("📅 [Demo] Cita agendada:", datos.nombre, datos.fechaCita, datos.horaCita);
    return;
  }
  try {
    const auth = await googleAuth.getClient();
    const cal  = google.calendar({ version: "v3", auth });
    await cal.events.patch({
      calendarId,
      eventId,
      requestBody: {
        summary: `CITA: ${datos.nombre} | ${datos.tratamiento}`,
        description: [
          `Paciente: ${datos.nombre}`,
          `RUT: ${datos.rut || "—"}`,
          `Teléfono: ${datos.phone}`,
          `Email: ${datos.email || "—"}`,
          `Tratamiento: ${datos.tratamiento}`,
          datos.urgente ? "⚠️ URGENTE" : "",
        ].filter(Boolean).join("\n"),
        colorId: datos.urgente ? "11" : "2", // rojo si urgente, verde si normal
      },
    });
    console.log(`📅 Evento ${eventId} actualizado en Calendar`);
  } catch (e) {
    console.error("Calendar bookSlot error:", e.message);
  }
}

// ─── Google Sheets: registro de pacientes ────────────────────────────────────
// Columnas: ID | Timestamp | Teléfono | Nombre | RUT | Email |
//           Tratamiento | Urgente | Fecha Cita | Hora Cita | Estado | Notas
async function logSheets(datos) {
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) {
    console.log("📊 [Demo] Registro Sheets:", datos.nombre);
    return;
  }
  try {
    const auth   = await googleAuth.getClient();
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId:   GOOGLE_SPREADSHEET_ID,
      range:           "Citas!A:S",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          datos.citaId   || `CITA-${Date.now()}`,
          new Date().toLocaleString("es-CL"),
          datos.phone,
          datos.nombre   || "",
          datos.rut      || "",
          datos.email    || "",
          datos.tratamiento || "",
          datos.urgente  ? "Sí" : "No",
          datos.fechaCita || "",
          datos.horaCita  || "",
          datos.estado   || "Agendada",
          datos.reagendando ? "Reagendada por el paciente" : "",
          datos.fechaHora || "",
          datos.slotId    || "",
          datos.channel   || "twilio",
          "",   // Recordatorio (lo llena el job)
          "",   // Encuesta (la llena el job)
          datos.doctor    || "",
          datos.precio    || "",
        ]],
      },
    });
    console.log("📊 Cita registrada en Sheets");
  } catch (e) {
    console.error("Sheets logSheets error:", e.message);
  }
}

// ─── Email: confirmación al paciente y al doctor/secretaria ──────────────────
async function sendConfirmation(datos) {
  if (!resendClient) return;
  // EMAIL_DOMAIN resend.dev = dominio compartido (demo). En producción usar dominio verificado de la clínica.
  const from    = `${CLINICA_NOMBRE} <onboarding@${EMAIL_DOMAIN}>`;
  const toEmail = datos.email || DOCTOR_EMAIL; // Si no hay email del paciente, enviar solo al doctor
  // Los datos del paciente son entrada no confiable — escapar antes de insertar en HTML
  const detalle = `Tratamiento: ${escapeHtml(datos.tratamiento)}\nFecha: ${escapeHtml(datos.fechaCita)}\nHora: ${escapeHtml(datos.horaCita)}`;

  if (toEmail && toEmail !== DOCTOR_EMAIL) {
    resendClient.emails.send({
      from,
      to:      toEmail,
      subject: `✅ Confirmación de cita — ${datos.fechaCita}, ${datos.horaCita}`,
      html:    `<h2>¡Tu cita está confirmada! ${R.emoji}</h2>
                <p><strong>Paciente:</strong> ${escapeHtml(datos.nombre)}</p>
                <pre>${detalle}</pre>
                <p>Recuerda llegar <strong>10 minutos antes</strong>. Para cancelar o reagendar llama al ${escapeHtml(CLINICA_TELEFONO)}.</p>
                <p style="color:#666"><em>${escapeHtml(CLINICA_NOMBRE)}</em></p>`,
    }).catch(e => console.error("Email paciente:", e.message));
  }

  if (DOCTOR_EMAIL) {
    resendClient.emails.send({
      from,
      to: DOCTOR_EMAIL,
      subject: `${R.emoji} Nueva cita: ${datos.nombre} — ${datos.fechaCita} ${datos.horaCita}`,
      html:    `<h2>Nueva cita agendada vía WhatsApp Bot</h2>
                <p><strong>Nombre:</strong> ${escapeHtml(datos.nombre)}</p>
                <p><strong>RUT:</strong> ${escapeHtml(datos.rut) || "—"}</p>
                <p><strong>Teléfono:</strong> ${escapeHtml(datos.phone)}</p>
                <p><strong>Email:</strong> ${escapeHtml(datos.email) || "—"}</p>
                <pre>${detalle}</pre>
                <p><strong>Urgente:</strong> ${datos.urgente ? "⚠️ SÍ" : "No"}</p>`,
    }).catch(e => console.error("Email doctor:", e.message));
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────
// Recibe el ISO del slot (con offset de Chile, ej "2026-07-30T11:00:00-04:00").
// Deriva fecha/hora LOCALES del propio string — nunca depende de la TZ del servidor.
function fmtDT(iso) {
  const dias  = ["dom","lun","mar","mié","jue","vie","sáb"];
  const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const fecha = String(iso).slice(0, 10);       // "2026-07-30"
  const hora  = String(iso).slice(11, 16);      // "11:00"
  const d = new Date(`${fecha}T12:00:00Z`);     // mediodía UTC: día calendario sin corrimientos
  return `${dias[d.getUTCDay()]} ${d.getUTCDate()} ${meses[d.getUTCMonth()]} — ${hora} hrs`;
}

function validRut(rut) {
  const clean = rut.replace(/[.\-\s]/g, "").toUpperCase();
  if (!/^\d{7,8}[0-9K]$/.test(clean)) return false;
  const cuerpo = clean.slice(0, -1);
  const dv     = clean.slice(-1);
  let s = 0, m = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { s += +cuerpo[i] * m; m = m === 7 ? 2 : m + 1; }
  const calc = 11 - (s % 11);
  return dv === (calc === 11 ? "0" : calc === 10 ? "K" : String(calc));
}

function fmtRut(rut) {
  const clean = rut.replace(/[.\-\s]/g, "").toUpperCase();
  return clean.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "-" + clean.slice(-1);
}

function fmtCLP(valor) {
  const n = parseInt(String(valor).replace(/\D/g, ""), 10);
  if (!n) return "";
  return "$" + n.toLocaleString("es-CL");
}

let serviciosCache = { data: null, ts: 0 };
const SERVICIOS_TTL = 5 * 60 * 1000;

// Devuelve [{ nombre, precio, duracion }] activos. Fallback a la lista por defecto.
async function getServicios() {
  if (serviciosCache.data && Date.now() - serviciosCache.ts < SERVICIOS_TTL) {
    return serviciosCache.data;
  }
  let servicios = TRATAMIENTOS_DEFAULT.map(nombre => ({ nombre, precio: "", duracion: "" }));
  if (googleAuth && GOOGLE_SPREADSHEET_ID) {
    try {
      const sheets = await sheetsClient();
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: "Servicios!A2:E",
      });
      const filas = (r.data.values || [])
        .filter(row => (row[0] || "").trim())                       // con nombre
        .filter(row => !/^(no|inactivo|0)$/i.test((row[3] || "sí").trim())) // col D Activo
        .map(row => ({
          nombre:   row[0].trim(),
          precio:   (row[1] || "").trim(),
          duracion: (row[2] || "").trim(),
          abono:    (row[4] || "").replace(/\D/g, ""),              // col E: monto a cobrar al reservar
        }));
      if (filas.length) servicios = filas;
    } catch (e) {
      console.error("getServicios:", e.message);
    }
  }
  serviciosCache = { data: servicios, ts: Date.now() };
  return servicios;
}

// Texto del menú de servicios, con precios si la clínica los publica
function listaServicios(servicios) {
  return servicios.map((s, i) => {
    let linea = `${i + 1}. ${s.nombre}`;
    if (MOSTRAR_PRECIOS && s.precio) linea += ` — desde ${fmtCLP(s.precio)}`;
    if (s.duracion) linea += ` (${s.duracion})`;
    return linea;
  }).join("\n");
}

async function aiReply(text, session) {
  if (!anthropic) return null;
  try {
    const r = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 280,
      system:     `Eres el asistente virtual de ${CLINICA_NOMBRE}.
Datos de la clínica:
- Horario de atención: ${CLINICA_HORARIO}
${CLINICA_DIRECCION ? `- Dirección: ${CLINICA_DIRECCION}` : ""}
${CLINICA_TELEFONO ? `- Teléfono: ${CLINICA_TELEFONO}` : ""}
Responde preguntas breves sobre ${R.ia} (precios referenciales en CLP, preparación, cuidados, duración), horarios, ubicación y convenios.
Sé amable, profesional y muy conciso (máx 3 oraciones).
No confirmes citas aquí; para eso el paciente debe seguir el flujo del bot (opción 1 del menú).`,
      messages: [{ role: "user", content: text }],
    });
    return r.content[0].text;
  } catch (e) {
    console.error("AI error:", e.message);
    return null;
  }
}

// Busca horarios (según doctor si hay varios) y los ofrece; si no hay, ofrece lista de espera
async function ofrecerSlots(phone, s) {
  const slots = await getSlots(calendarIdForDoctor(s.d.doctor));
  if (!slots.length) {
    s.paso = "espera_confirmar";
    await btns(phone,
      `Por ahora no tenemos horarios disponibles 😔\n\n` +
      `¿Quieres que te avise por WhatsApp apenas se libere un cupo?`,
      [
        { id: "espera_si", label: "🔔 Sí, avísame" },
        { id: "espera_no", label: "No, gracias" },
      ]
    );
    return;
  }
  s.d.slots = slots;
  s.paso    = "seleccionar_hora";
  await msg(phone,
    `*Horarios disponibles:* 📅${s.d.doctor ? `\n👨‍⚕️ ${s.d.doctor}` : ""}\n\n${slots.map((sl, i) => `${i + 1}. ${sl.label}`).join("\n")}\n\nResponde con el *número* del horario que prefieras.`
  );
}

// Busca una cita por su ID (columna A) → { row, rowNum } o null
async function buscarCitaPorId(citaId) {
  const rows = await getCitasRows();
  return rows.find(({ row }) => row[0] === citaId) || null;
}

// Reserva un slot temporalmente mientras se espera el pago (queda fuera de oferta)
async function reservarTemporal(eventId, datos, calendarId) {
  if (!googleAuth || !calendarId || !eventId || eventId.startsWith("demo-")) return;
  try {
    const auth = await googleAuth.getClient();
    const cal  = google.calendar({ version: "v3", auth });
    await cal.events.patch({ calendarId, eventId, requestBody: {
      summary: `RESERVANDO: ${datos.nombre}`, colorId: "8",
    }});
  } catch (e) { console.error("reservarTemporal:", e.message); }
}

// Completa el agendamiento: bloquea el slot, registra/actualiza en Sheets, envía
// confirmación y avisa a la secretaria. Sirve para el flujo sin pago y para cuando
// se aprueba el pago (yaEnSheet=true → solo actualiza el estado, no inserta).
async function finalizarCita(phone, datos) {
  const session = getSession(phone);
  session.channel = datos.channel || "twilio";

  if (datos.yaEnSheet) {
    const cita = await buscarCitaPorId(datos.citaId);
    if (cita) await setCitaCell(cita.rowNum, "K", "Agendada");
  } else {
    await logSheets({ ...datos, phone, estado: "Agendada" });
  }
  await bookSlot(datos.slotId, { ...datos, phone }, calendarIdForDoctor(datos.doctor));
  sendConfirmation({ ...datos, phone });
  notifySecretaria(
    `${datos.reagendando ? "🔄 Cita reagendada" : `${R.emoji} Nueva cita`}:\n` +
    `👤 ${datos.nombre}\n📅 ${datos.fechaCita} · ${datos.horaCita}\n${R.emoji} ${datos.tratamiento}` +
    (datos.doctor ? `\n👨‍⚕️ ${datos.doctor}` : "") +
    (datos.urgente ? "\n⚠️ URGENTE" : "") +
    (datos.abonoPagado ? `\n💵 Abono pagado: ${fmtCLP(datos.abonoPagado)}` : "") +
    `\n📱 ${phone}`
  );
  await msg(phone,
    `✅ *¡Cita ${datos.reagendando ? "reagendada" : "agendada"} con éxito!* ${R.emoji}\n\n` +
    `📅 ${datos.fechaCita}\n⏰ ${datos.horaCita}\n${R.emoji} ${datos.tratamiento}` +
    (datos.doctor ? `\n👨‍⚕️ ${datos.doctor}` : "") +
    (datos.abonoPagado ? `\n💵 Abono recibido: ${fmtCLP(datos.abonoPagado)} ✔` : "") +
    (datos.email ? `\n📧 Confirmación enviada a ${datos.email}` : "") +
    `\n\n_Te enviaremos un recordatorio el día anterior. Recuerda llegar 10 minutos antes._\n\n¡Hasta pronto! 😊`
  );
}

// Se llama cuando Mercado Pago aprueba un pago (desde el webhook)
async function confirmarPago(citaId, monto) {
  const cita = await buscarCitaPorId(citaId);
  // Evita doble confirmación si el webhook llega repetido
  if (cita && !["Pendiente de pago"].includes(cita.row[10])) return;

  let datos = pagosPendientes.get(citaId)?.datos;
  if (!datos && cita) {
    const r = cita.row;
    datos = {
      phone: (r[2] || "").replace(/\D/g, ""), nombre: r[3], rut: r[4], email: r[5],
      tratamiento: r[6], urgente: r[7] === "Sí", fechaCita: r[8], horaCita: r[9],
      fechaHora: r[12], slotId: r[13], channel: r[14], doctor: r[17] || null, precio: r[18], citaId,
    };
  }
  if (!datos) { console.warn("confirmarPago: cita no encontrada", citaId); return; }
  pagosPendientes.delete(citaId);
  console.log(`💵 Pago aprobado para ${citaId} → agendando`);
  await finalizarCita(datos.phone, { ...datos, yaEnSheet: true, abonoPagado: monto });
}

// Libera las reservas cuyo pago no llegó a tiempo (cada 5 min)
setInterval(async () => {
  const ahora = Date.now();
  for (const [citaId, p] of pagosPendientes.entries()) {
    if (ahora - p.ts < PAGO_EXPIRA_MIN * 60000) continue;
    pagosPendientes.delete(citaId);
    try {
      await liberarSlot(p.datos.slotId, calendarIdForDoctor(p.datos.doctor));
      const cita = await buscarCitaPorId(citaId);
      if (cita && cita.row[10] === "Pendiente de pago") await setCitaCell(cita.rowNum, "K", "Cancelada (sin pago)");
      const session = getSession(p.datos.phone); session.channel = p.datos.channel;
      await msg(p.datos.phone, `⌛ Tu reserva de *${p.datos.tratamiento}* expiró porque no recibimos el pago a tiempo.\n\nSi aún quieres la hora, escribe *1* para agendar de nuevo.`);
      console.log(`⌛ Reserva ${citaId} expirada por falta de pago`);
    } catch (e) { console.error("expirar pago:", e.message); }
  }
}, 5 * 60 * 1000);

// Busca las citas activas del paciente y arranca el flujo de gestión (cancelar/reagendar)
async function iniciarGestionCita(phone, s) {
  const citas = await citasActivasDe(phone);
  if (!citas.length) {
    s.paso = "menu";
    await msg(phone, `No encontré citas activas asociadas a este número 🔍\n\nSi quieres agendar una hora nueva, escribe *1*.`);
    return;
  }
  s.d.citasActivas = citas.map(c => ({ rowNum: c.rowNum, row: c.row }));
  if (citas.length === 1) {
    s.d.citaSel = s.d.citasActivas[0];
    s.paso = "gestionar_opcion";
    const r = citas[0].row;
    await btns(phone,
      `Encontré tu cita 📋\n\n${R.emoji} ${r[6]}\n📅 ${r[8]}\n⏰ ${r[9]}${r[17] ? `\n👨‍⚕️ ${r[17]}` : ""}\n\n¿Qué deseas hacer?`,
      [
        { id: "gest_reagendar", label: "🔄 Reagendar" },
        { id: "gest_cancelar",  label: "❌ Cancelar cita" },
        { id: "gest_volver",    label: "↩️ Volver" },
      ]
    );
  } else {
    s.paso = "gestionar_cual";
    await msg(phone,
      `Tienes ${citas.length} citas activas 📋\n\n${citas.map((c, i) => `${i + 1}. ${c.row[6]} — ${c.row[8]} ${c.row[9]}`).join("\n")}\n\n¿Cuál quieres gestionar? Responde con el *número*.`
    );
  }
}

// ─── Máquina de estados ───────────────────────────────────────────────────────
async function handle(phone, text, s) {
  const t = text.toLowerCase().trim();

  // Intención de cancelar/reagendar en cualquier momento fuera del flujo de agendamiento.
  // En pasos intermedios (confirmar_cita, cancelar_confirmar, etc.) "cancelar" tiene
  // otro significado dentro del propio paso, por eso solo se intercepta en estos:
  if (["inicio", "menu", "agendado"].includes(s.paso) &&
      /\b(cancelar|anular|reagendar|cambiar\s+(mi\s+)?(hora|cita)|mi\s+cita)\b/i.test(t)) {
    await iniciarGestionCita(phone, s);
    return;
  }

  // Respuesta a encuesta post-atención (funciona aunque la sesión haya expirado)
  if (pendingSurveys.has(phone)) {
    const m = t.match(/^\s*([1-5])\b/);
    if (m) {
      const { rowNum } = pendingSurveys.get(phone);
      pendingSurveys.delete(phone);
      await setCitaCell(rowNum, "Q", `${m[1]} ⭐`);
      if (m[1] === "5" && GOOGLE_MAPS_URL) {
        await msg(phone, `¡Muchas gracias! 🌟 Nos alegra que hayas tenido una buena experiencia.\n\n¿Nos ayudarías con una reseña en Google? Toma 30 segundos:\n${GOOGLE_MAPS_URL}`);
      } else if (parseInt(m[1]) <= 3) {
        await msg(phone, `Gracias por tu honestidad 🙏 Lamentamos que la experiencia no haya sido ideal. La clínica se pondrá en contacto contigo.`);
        notifySecretaria(`⚠️ Encuesta con nota baja (${m[1]}/5):\n📱 ${phone}\nContactar al paciente para hacer seguimiento.`);
      } else {
        await msg(phone, `¡Muchas gracias por tu evaluación! 😊 ¡Te esperamos en tu próxima visita!`);
      }
      return;
    }
  }

  // Detección de urgencia en cualquier momento del flujo (si el rubro la maneja)
  if (URGENCIA_RE &&
      !["inicio", "menu", "urgencia", "urgencia_nivel"].includes(s.paso) &&
      URGENCIA_RE.test(t)) {
    s.d.urgente = true;
    s.paso = "urgencia";
  }

  switch (s.paso) {

    // ── Bienvenida ──────────────────────────────────────────────────────────
    case "inicio":
      s.paso = "menu";
      await btns(phone,
        `¡Hola! 👋 Bienvenido/a a *${CLINICA_NOMBRE}*.\nSoy tu asistente virtual. ¿En qué puedo ayudarte?`,
        [
          { id: "btn_agendar",  label: "📅 Agendar hora" },
          ...(R.urgencia ? [{ id: "btn_urgencia", label: "🚨 Urgencia" }] : []),
          { id: "btn_info",     label: "ℹ️ Información" },
          { id: "btn_gestion",  label: "🔄 Reagendar / Cancelar" },
        ]
      );
      break;

    // ── Menú principal ──────────────────────────────────────────────────────
    case "menu": {
      const esAgendar  = t === "btn_agendar"  || t === "1" || t.includes("agendar") || t.includes("hora");
      const esUrgencia = R.urgencia && (t === "btn_urgencia" || t === "2" || t.includes("urgencia") || t.includes("dolor") || t.includes("emergencia"));
      const esInfo     = t === "btn_info"     || t === "3" || t.includes("info")     || t.includes("precio") || t.includes(R.servicioSing);
      const esGestion  = t === "btn_gestion" || t === "4" || t.includes("cancelar") || t.includes("reagendar") || t.includes("mi cita") || t.includes("cambiar mi");

      if (esGestion) {
        await iniciarGestionCita(phone, s);
      } else if (esUrgencia) {
        s.d.urgente = true;
        s.paso = "urgencia";
        await btns(phone,
          `🚨 *Urgencia*\n\n¿Qué tan intenso es el problema?\n\n_Si es muy severo, te recomendamos llamar directamente al ${CLINICA_TELEFONO || "nuestro centro"}_`,
          [
            { id: "urg_alta",  label: "😰 Muy intenso / severo" },
            { id: "urg_media", label: "😐 Moderado / manejable" },
          ]
        );
      } else if (esAgendar) {
        s.d.urgente = false;
        s.paso = "datos_nombre";
        await msg(phone, `Para agendar tu hora, necesito algunos datos 📋\n\n*¿Cuál es tu nombre completo?*`);
      } else if (esInfo) {
        const respAI = await aiReply(text, s);
        if (respAI) {
          await msg(phone, respAI + `\n\nPara agendar una hora, escribe *1*.`);
        } else {
          const servicios = await getServicios();
          await msg(phone,
            `En *${CLINICA_NOMBRE}* ofrecemos:\n\n${servicios.filter(x => x.activo !== false).map(x => `${R.emoji} ${x.nombre}`).join("\n")}\n\nPara agendar una hora, escribe *1*.`
          );
        }
      } else {
        const respAI = await aiReply(text, s);
        if (respAI) {
          await msg(phone, respAI + "\n\n¿Deseas agendar una hora? Escribe *1*.");
        } else {
          await btns(phone, "Por favor selecciona una opción:",
            [
              { id: "btn_agendar",  label: "📅 Agendar hora" },
              ...(R.urgencia ? [{ id: "btn_urgencia", label: "🚨 Urgencia" }] : []),
              { id: "btn_info",     label: "ℹ️ Información" },
              { id: "btn_gestion",  label: "🔄 Reagendar / Cancelar" },
            ]
          );
        }
      }
      break;
    }

    // ── Urgencia ────────────────────────────────────────────────────────────
    case "urgencia": {
      const esAlta = t === "urg_alta" || t.includes("intenso") || t.includes("severo") || t.includes("muy") || t === "1";
      if (esAlta) {
        const h = horaChile();
        const clinicaAbierta = h >= 9 && h < 19;
        await msg(phone,
          clinicaAbierta
            ? `⚠️ Para urgencias con dolor intenso, llama de inmediato:\n📞 *${CLINICA_TELEFONO || "Contactar clínica directamente"}*\n\nTambién puedo buscarte el primer horario disponible.`
            : `⚠️ En este momento la clínica está cerrada (${CLINICA_HORARIO}).\n\nDejé aviso a nuestro equipo — te contactarán apenas abramos 📞\n\nMientras tanto puedo buscarte el primer horario disponible.`
        );
        notifySecretaria(`🚨 URGENCIA ALTA reportada por WhatsApp:\n📱 ${phone}\n${clinicaAbierta ? "El paciente fue derivado a llamar." : "⏰ FUERA DE HORARIO — contactar apenas abra la clínica."}`);
        s.d.nivelUrgencia = "alta";
      } else {
        s.d.nivelUrgencia = "media";
      }
      s.paso = "datos_nombre";
      await msg(phone, `Entendido. Vamos a conseguirte una hora pronto 📋\n\n*¿Cuál es tu nombre completo?*`);
      break;
    }

    // ── Datos del paciente: nombre ──────────────────────────────────────────
    case "datos_nombre": {
      if (t.length < 3 || /^\d+$/.test(t)) {
        await msg(phone, "Por favor ingresa tu nombre completo (mínimo 3 letras).");
        break;
      }
      s.d.nombre = text.trim().replace(/\b\w/g, c => c.toUpperCase());
      s.err  = 0;
      if (R.pideRut) {
        s.paso = "datos_rut";
        await msg(phone, `Gracias, *${s.d.nombre}* 😊\n\n*¿Cuál es tu RUT?* (ej: 12.345.678-9)\nEscribe *omitir* si prefieres no darlo.`);
      } else {
        s.d.rut = null;
        s.paso  = "datos_email";
        await msg(phone, `Gracias, *${s.d.nombre}* 😊\n\n*¿Cuál es tu correo electrónico?* Para enviarte la confirmación 📧\nEscribe *omitir* si no deseas darlo.`);
      }
      break;
    }

    // ── Datos del paciente: RUT ─────────────────────────────────────────────
    case "datos_rut": {
      if (t === "omitir" || t === "sin rut" || t === "no tengo") {
        s.d.rut = null;
        s.err   = 0;
        s.paso  = "datos_email";
        await msg(phone, `*¿Cuál es tu correo electrónico?* Para enviarte la confirmación 📧\nEscribe *omitir* si no deseas darlo.`);
        break;
      }
      if (!validRut(t.replace(/\s/g, ""))) {
        s.err++;
        await msg(phone, s.err >= 2
          ? "No se pudo validar el RUT. Escribe *omitir* para saltarlo."
          : "El RUT no parece válido. Intenta de nuevo (ej: 12.345.678-9) o escribe *omitir*."
        );
        break;
      }
      s.d.rut = fmtRut(t);
      s.err   = 0;
      s.paso  = "datos_email";
      await msg(phone, `✅ RUT: *${s.d.rut}*\n\n*¿Cuál es tu correo electrónico?* Para enviarte la confirmación 📧\nEscribe *omitir* si no deseas darlo.`);
      break;
    }

    // ── Datos del paciente: email ───────────────────────────────────────────
    case "datos_email": {
      if (t === "omitir" || t === "no tengo" || t === "no") {
        s.d.email = null;
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
        await msg(phone, "El correo no parece válido. Inténtalo de nuevo o escribe *omitir*.");
        break;
      } else {
        s.d.email = t;
      }
      s.paso = "tratamiento";
      const servicios = await getServicios();
      s.d.servicios = servicios;
      await msg(phone,
        `*¿Qué ${R.servicioSing} necesitas?* ${R.emoji}\n\n${listaServicios(servicios)}\n\nResponde con el *número* de tu opción.` +
        (MOSTRAR_PRECIOS ? `\n\n_Precios referenciales. El valor final se confirma en la evaluación._` : "")
      );
      break;
    }

    // ── Selección de tratamiento ────────────────────────────────────────────
    case "tratamiento": {
      const servicios = s.d.servicios?.length ? s.d.servicios : await getServicios();
      const num = parseInt(t);
      let servicio = null;
      if (!isNaN(num) && num >= 1 && num <= servicios.length) {
        servicio = servicios[num - 1];
      } else {
        servicio = servicios.find(sv => t.includes(sv.nombre.toLowerCase().split(" ")[0])) || null;
      }
      if (!servicio) {
        await msg(phone, `Por favor responde con un número del 1 al ${servicios.length}:\n\n${listaServicios(servicios)}`);
        break;
      }
      const tratamiento = servicio.nombre;
      s.d.tratamiento = tratamiento;
      s.d.precio      = servicio.precio || "";
      s.d.abono       = servicio.abono || "";   // monto a cobrar por adelantado (si aplica)

      // Multi-doctor: si hay más de un profesional, el paciente elige
      if (DOCTORES.length > 1) {
        s.paso = "seleccionar_doctor";
        await msg(phone,
          `*¿Con qué profesional deseas atenderte?* 👨‍⚕️\n\n${DOCTORES.map((d, i) => `${i + 1}. ${d.nombre}${d.especialidad ? ` — ${d.especialidad}` : ""}`).join("\n")}\n\nResponde con el *número*.`
        );
        break;
      }
      s.d.doctor = DOCTORES[0]?.nombre || null;
      await msg(phone, `Perfecto. Buscando horarios disponibles para *${tratamiento}*... ⏳`);
      await ofrecerSlots(phone, s);
      break;
    }

    // ── Selección de doctor (multi-doctor) ──────────────────────────────────
    case "seleccionar_doctor": {
      const num = parseInt(t);
      if (isNaN(num) || num < 1 || num > DOCTORES.length) {
        await msg(phone, `Por favor responde con un número del 1 al ${DOCTORES.length}.`);
        break;
      }
      s.d.doctor = DOCTORES[num - 1].nombre;
      await msg(phone, `Buscando horarios de *${s.d.doctor}*... ⏳`);
      await ofrecerSlots(phone, s);
      break;
    }

    // ── Lista de espera ─────────────────────────────────────────────────────
    case "espera_confirmar": {
      const si = t === "espera_si" || t === "1" || t.includes("sí") || t.includes("si") || t.includes("avísame") || t.includes("avisame");
      const no = t === "espera_no" || t === "2" || t.startsWith("no");
      if (si) {
        await agregarListaEspera(phone, s.d.nombre, s.d.tratamiento, s.channel || "twilio");
        s.paso = "menu";
        await msg(phone,
          `¡Listo, ${s.d.nombre}! 🔔 Estás en nuestra lista de espera.\n\nTe avisaré por WhatsApp apenas se libere un cupo para *${s.d.tratamiento}*.\n\nTambién puedes llamar al ${CLINICA_TELEFONO || "la clínica"} si es urgente.`
        );
      } else if (no) {
        s.paso = "menu";
        await msg(phone, `De acuerdo 👍 Puedes escribirnos cuando quieras para intentar de nuevo.\n\n📞 ${CLINICA_TELEFONO || ""}`);
      } else {
        await msg(phone, `Responde *sí* para entrar a la lista de espera o *no* para volver al menú.`);
      }
      break;
    }

    // ── Gestión de citas: elegir cuál (si hay varias) ───────────────────────
    case "gestionar_cual": {
      const num = parseInt(t);
      const citas = s.d.citasActivas || [];
      if (isNaN(num) || num < 1 || num > citas.length) {
        await msg(phone, `Por favor responde con un número del 1 al ${citas.length}.`);
        break;
      }
      s.d.citaSel = citas[num - 1];
      s.paso = "gestionar_opcion";
      const r = s.d.citaSel.row;
      await btns(phone,
        `Cita seleccionada 📋\n\n${R.emoji} ${r[6]}\n📅 ${r[8]}\n⏰ ${r[9]}\n\n¿Qué deseas hacer?`,
        [
          { id: "gest_reagendar", label: "🔄 Reagendar" },
          { id: "gest_cancelar",  label: "❌ Cancelar cita" },
          { id: "gest_volver",    label: "↩️ Volver" },
        ]
      );
      break;
    }

    // ── Gestión de citas: reagendar / cancelar ──────────────────────────────
    case "gestionar_opcion": {
      const reagendar = t === "gest_reagendar" || t === "1" || t.includes("reagendar") || t.includes("cambiar");
      const cancelar  = t === "gest_cancelar"  || t === "2" || t.includes("cancelar");
      const volver    = t === "gest_volver"    || t === "3" || t.includes("volver");
      const cita = s.d.citaSel;
      if (!cita) { s.paso = "menu"; await msg(phone, "Algo salió mal, volvamos al inicio. Escribe *hola*."); break; }

      if (reagendar) {
        const r = cita.row;
        // Liberar el slot antiguo y arrastrar los datos del paciente al nuevo agendamiento
        await cancelarCitaRow(cita, "Reagendada");
        s.d = {
          nombre: r[3], rut: r[4] || null, email: r[5] || null,
          tratamiento: r[6], doctor: r[17] || null, urgente: r[7] === "Sí",
          reagendando: true,
        };
        await msg(phone, `Sin problema, ${s.d.nombre} 🔄 Tu hora anterior quedó liberada.\n\nBuscando nuevos horarios... ⏳`);
        await ofrecerSlots(phone, s);
      } else if (cancelar) {
        s.paso = "cancelar_confirmar";
        await btns(phone, `¿Seguro que quieres *cancelar* tu cita del ${cita.row[8]} a las ${cita.row[9]}?`,
          [
            { id: "canc_si", label: "✅ Sí, cancelar" },
            { id: "canc_no", label: "↩️ No, mantenerla" },
          ]
        );
      } else if (volver) {
        s.paso = "menu";
        await msg(phone, `👍 Tu cita se mantiene sin cambios. ¿Necesitas algo más? Escribe *hola* para ver el menú.`);
      } else {
        await msg(phone, `Responde *Reagendar*, *Cancelar cita* o *Volver*.`);
      }
      break;
    }

    // ── Confirmación de cancelación ─────────────────────────────────────────
    case "cancelar_confirmar": {
      const si = t === "canc_si" || t === "1" || t.includes("sí") || t.includes("si, cancelar") || t.includes("si cancelar") || t === "si";
      const no = t === "canc_no" || t === "2" || t.startsWith("no");
      if (si) {
        await cancelarCitaRow(s.d.citaSel, "Cancelada");
        s.paso = "menu";
        await msg(phone,
          `Tu cita fue cancelada ✅\n\nEl horario quedó disponible para otro paciente.\nCuando quieras agendar de nuevo, escribe *1*. ¡Hasta pronto! 👋`
        );
      } else if (no) {
        s.paso = "menu";
        await msg(phone, `¡Perfecto! Tu cita se mantiene 😊 Te esperamos.`);
      } else {
        await msg(phone, `Responde *sí* para cancelar o *no* para mantener tu cita.`);
      }
      break;
    }

    // ── Respuesta al recordatorio 24h antes ─────────────────────────────────
    case "recordatorio_resp": {
      const confirmo  = t === "rec_confirmo"  || t === "1" || t.includes("confirmo") || t.includes("asistir") || t.includes("sí") || t === "si" || t === "ok";
      const reagendar = t === "rec_reagendar" || t === "2" || t.includes("reagendar") || t.includes("cambiar");
      const cancelar  = t === "rec_cancelar"  || t === "3" || t.includes("cancelar");

      if (confirmo) {
        await setCitaCell(s.d.recRowNum, "K", "Confirmada");
        s.paso = "agendado";
        await msg(phone, `¡Gracias por confirmar, ${s.d.nombre}! ✅\n\nTe esperamos mañana:\n📅 ${s.d.fechaCita}\n⏰ ${s.d.horaCita}\n\nRecuerda llegar *10 minutos antes* 😊`);
      } else if (reagendar) {
        await cancelarCitaRow({ row: [ , , phone, s.d.nombre, s.d.rut, s.d.email, s.d.tratamiento, , s.d.fechaCita, s.d.horaCita, , , , s.d.recEventId, , , , s.d.doctor ], rowNum: s.d.recRowNum }, "Reagendada");
        s.d.reagendando = true;
        await msg(phone, `Entendido 🔄 Tu hora quedó liberada. Buscando nuevos horarios... ⏳`);
        await ofrecerSlots(phone, s);
      } else if (cancelar) {
        await cancelarCitaRow({ row: [ , , phone, s.d.nombre, s.d.rut, s.d.email, s.d.tratamiento, , s.d.fechaCita, s.d.horaCita, , , , s.d.recEventId, , , , s.d.doctor ], rowNum: s.d.recRowNum }, "Cancelada");
        s.paso = "menu";
        await msg(phone, `Tu cita fue cancelada ✅ Gracias por avisar — el horario quedó libre para otro paciente.\n\nCuando quieras reagendar, escribe *1*. ¡Hasta pronto! 👋`);
      } else {
        await msg(phone, `Por favor responde:\n*1* — Confirmo asistencia ✅\n*2* — Necesito reagendar 🔄\n*3* — Cancelar cita ❌`);
      }
      break;
    }

    // ── Selección de horario ────────────────────────────────────────────────
    case "seleccionar_hora": {
      const num   = parseInt(t);
      const slots = s.d.slots || [];
      if (isNaN(num) || num < 1 || num > slots.length) {
        await msg(phone, `Por favor elige un número del 1 al ${slots.length}.`);
        break;
      }
      const slot = slots[num - 1];
      const dt   = new Date(slot.start);
      s.d.slotId    = slot.id;
      s.d.fechaHora = slot.start;
      s.d.fechaCita = dt.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
      s.d.horaCita  = slot.start.slice(11, 16);  // hora local del slot (Chile), formato 24h "11:00"
      s.paso = "confirmar_cita";
      await btns(phone,
        `📋 *Confirma tu cita*\n\n` +
        `👤 Nombre: ${s.d.nombre}\n` +
        `${R.emoji} Tratamiento: ${s.d.tratamiento}\n` +
        (MOSTRAR_PRECIOS && s.d.precio ? `💰 Valor referencial: ${fmtCLP(s.d.precio)}\n` : "") +
        `📅 Fecha: ${s.d.fechaCita}\n` +
        `⏰ Hora: ${s.d.horaCita}` +
        (s.d.rut      ? `\n🪪 RUT: ${s.d.rut}` : "") +
        (s.d.urgente  ? "\n⚠️ Marcada como urgente" : "") +
        "\n\n¿Confirmamos?",
        [
          { id: "cita_ok",      label: "✅ Confirmar cita" },
          { id: "cita_cambiar", label: "🔄 Cambiar horario" },
          { id: "cita_cancel",  label: "❌ Cancelar" },
        ]
      );
      break;
    }

    // ── Confirmación de cita ────────────────────────────────────────────────
    case "confirmar_cita": {
      const confirma = t === "cita_ok"     || t === "1" || t.includes("confirm") || t.includes("sí") || t.includes("si") || t === "ok";
      const cambia   = t === "cita_cambiar" || t === "2" || t.includes("cambiar") || t.includes("otro");
      const cancela  = t === "cita_cancel"  || t === "3" || t.includes("cancelar") || t.includes("no quiero");

      if (confirma) {
        const citaId = `CITA-${Date.now()}`;
        const montoAbono = parseInt(s.d.abono || "0", 10);
        const channel = s.channel || "twilio";

        // ── Con abono configurado y Mercado Pago conectado → cobrar antes de agendar ──
        if (montoAbono > 0 && cobrosActivo()) {
          s.paso = "esperando_pago";
          await msg(phone, "Generando tu link de pago seguro... ⏳");
          try {
            const pref = await pago.crearPreferencia(MP_ACCESS_TOKEN, {
              titulo: `Abono ${s.d.tratamiento} — ${CLINICA_NOMBRE}`,
              monto: montoAbono, citaId,
              notificationUrl: `${PUBLIC_URL}/webhook-mp`,
              expiraMin: PAGO_EXPIRA_MIN,
            });
            await reservarTemporal(s.d.slotId, { ...s.d, phone }, calendarIdForDoctor(s.d.doctor));
            await logSheets({ ...s.d, phone, channel, citaId, estado: "Pendiente de pago" });
            pagosPendientes.set(citaId, { ts: Date.now(), datos: { ...s.d, phone, channel, citaId } });
            s.d.linkPago = pref.link;
            await msg(phone,
              `Para asegurar tu hora deja un abono de *${fmtCLP(montoAbono)}* 💳\n\n` +
              `👉 Paga aquí:\n${pref.link}\n\n` +
              `Tu hora queda *reservada por ${PAGO_EXPIRA_MIN} minutos*. Apenas confirmemos el pago te llega la confirmación ✅\n\n` +
              `_El pago va directo a ${CLINICA_NOMBRE}._`
            );
            setTimeout(() => { if (sessions[phone]) delete sessions[phone]; }, 30 * 60 * 1000);
          } catch (e) {
            console.error("crearPreferencia:", e.response?.data || e.message);
            // Si MP falla, no bloqueamos al paciente: agendamos igual
            s.paso = "agendado";
            await finalizarCita(phone, { ...s.d, citaId, channel });
          }
          break;
        }

        // ── Sin abono → agendar de inmediato ──
        s.paso = "agendado";
        await msg(phone, "Agendando tu cita... ⏳");
        await finalizarCita(phone, { ...s.d, citaId, channel });
        setTimeout(() => delete sessions[phone], 10 * 60 * 1000);

      } else if (cambia) {
        s.paso = "seleccionar_hora";
        const slots = s.d.slots || [];
        await msg(phone, `Elige otro horario:\n\n${slots.map((sl, i) => `${i + 1}. ${sl.label}`).join("\n")}\n\nResponde con el número.`);

      } else if (cancela) {
        delete sessions[phone];
        await msg(phone, `De acuerdo, cancelamos el proceso 👍\nSi quieres agendar en otro momento, escríbenos aquí. ¡Hasta pronto!`);

      } else {
        const respAI = await aiReply(text, s);
        await msg(phone, respAI || "Responde *Confirmar cita*, *Cambiar horario* o *Cancelar*.");
      }
      break;
    }

    // ── Post-agendamiento ───────────────────────────────────────────────────
    // ── Esperando el pago del abono ─────────────────────────────────────────
    case "esperando_pago": {
      await msg(phone,
        `Tu hora está *reservada* mientras completas el abono 💳\n\n` +
        (s.d.linkPago ? `👉 ${s.d.linkPago}\n\n` : "") +
        `Apenas Mercado Pago confirme el pago, te llega la confirmación automáticamente ✅\n` +
        `Si ya pagaste, espera unos segundos. Para anular, escribe *cancelar*.`
      );
      break;
    }

    case "agendado": {
      // "hola" / "menú" reinicia el flujo (cancelar/reagendar ya se intercepta arriba)
      if (/\b(hola|menu|menú|volver|inicio|agendar)\b/.test(t) || t === "1") {
        s.paso = "inicio";
        s.d = {};
        await handle(phone, text, s);
        break;
      }
      const respAI = await aiReply(text, s);
      await msg(phone, respAI ||
        `Tu cita ya está agendada ✅${R.emoji}\n\n` +
        `• Escribe *cancelar* o *reagendar* para gestionar tu cita\n` +
        `• Escribe *hola* para volver al menú` +
        (CLINICA_TELEFONO ? `\n• O llámanos al ${CLINICA_TELEFONO}` : "")
      );
      break;
    }

    default:
      s.paso = "inicio";
      await handle(phone, text, s);
  }
}

// ─── Webhook WhatsApp ─────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  if (!verificarFirma(req)) { console.warn("⚠️  Firma Meta inválida"); return res.sendStatus(403); }
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const phone = message.from;
    let text = "";
    if (message.type === "text") {
      text = message.text.body;
    } else if (message.type === "interactive") {
      text = message.interactive.button_reply?.id || message.interactive.list_reply?.id || "";
    }
    if (!text) return;

    if (isDuplicate(message.id, phone, text)) return;
    if (!rateLimitOk(phone)) { console.warn(`Rate limit: ${phone}`); return; }

    const session = getSession(phone);
    console.log(`📨 [${phone}] paso=${session.paso} | "${text.substring(0, 60)}"`);
    await handle(phone, text, session);

  } catch (e) {
    console.error("Webhook error:", e.message, e.stack);
  }
});

// ─── Webhook Twilio WhatsApp Sandbox ─────────────────────────────────────────
app.post("/webhook-twilio", express.urlencoded({ extended: false }), async (req, res) => {
  if (!verificarFirmaTwilio(req)) {
    console.warn(`⚠️  Firma Twilio inválida — request rechazado (url=${req.protocol}://${req.get("host")}${req.originalUrl})`);
    return res.sendStatus(403);
  }
  // TwiML vacío — evita que Twilio reenvíe el body "OK" como mensaje al usuario
  res.set("Content-Type", "text/xml").status(200).send("<Response/>");
  try {
    const from   = req.body?.From  || "";  // "whatsapp:+56912345678"
    const body   = req.body?.Body  || "";
    const msgSid = req.body?.MessageSid || "";

    if (!from.startsWith("whatsapp:") || !body) return;

    // "whatsapp:+56912345678" → "56912345678"
    const phone = from.replace("whatsapp:+", "");
    if (!phone) return;

    if (!rateLimitOk(phone)) { console.warn(`Rate limit Twilio: ${phone}`); return; }
    if (isDuplicate(msgSid || `tw-${phone}-${body}`, phone, body)) return;

    const session = getSession(phone);
    session.channel = "twilio";

    console.log(`📨 [Twilio][${phone}] paso=${session.paso} | "${body.substring(0, 60)}"`);
    await handle(phone, body, session);
  } catch (e) {
    console.error("Twilio webhook error:", e.message, e.stack);
  }
});

// ─── Webhook de Mercado Pago (confirmación automática de pago) ────────────────
// MP notifica aquí al aprobarse un pago. Consultamos el pago contra la cuenta de
// la clínica (esa consulta ES la verificación) y confirmamos la cita.
app.post("/webhook-mp", async (req, res) => {
  res.sendStatus(200); // responder rápido siempre; MP reintenta si no
  try {
    if (!cobrosActivo()) return;
    const tipo  = req.query.type || req.query.topic || req.body?.type;
    const payId = req.query["data.id"] || req.query.id || req.body?.data?.id;
    if (tipo !== "payment" || !payId) return;
    const info = await pago.consultarPago(MP_ACCESS_TOKEN, payId);
    if (!info || info.status !== "approved" || !info.citaId) return;
    await confirmarPago(info.citaId, info.monto);
  } catch (e) {
    console.error("webhook-mp:", e.message);
  }
});

// ─── Panel de agenda propio (vista semana/mes + alta manual de citas) ────────
// Acceso: sesión de login O token (igual que el dashboard)
function accesoPanel(req) {
  return !!getPanelSession(req) || tokenOk(req.query.token || req.body?.token, DASHBOARD_TOKEN);
}

// Página del panel de agenda (vista semana/mes, alta y cancelación de citas)
app.get("/agenda", (req, res) => {
  if (!httpRateLimitOk(req.ip, 30)) return res.status(429).send("Demasiadas solicitudes — intenta en 1 minuto");
  const porSesion = !!getPanelSession(req);
  const porToken  = tokenOk(req.query.token, DASHBOARD_TOKEN);
  if (!porSesion && !porToken) return HAY_LOGIN ? res.redirect("/dashboard/login") : res.sendStatus(403);
  res.set({
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
  });
  const tok = porToken ? encodeURIComponent(req.query.token) : "";
  res.send(paginaAgenda(tok, porSesion));
});

function paginaAgenda(tok, porSesion) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(CLINICA_NOMBRE)} — Agenda</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f0f4f8;color:#1e293b;font-size:15px}
  header{background:linear-gradient(135deg,#065f52,#0f9d8e);color:#fff;padding:16px 22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  header h1{font-size:1.15rem;font-weight:800}
  header .sub{opacity:.8;font-size:.8rem}
  .hbtns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .btn{background:#fff;color:#065f52;border:none;border-radius:9px;padding:9px 15px;font-weight:700;font-size:.85rem;cursor:pointer;text-decoration:none;display:inline-block}
  .btn.ghost{background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.3)}
  .btn:hover{opacity:.9}
  main{max-width:1100px;margin:18px auto;padding:0 16px}
  .toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .nav{display:flex;align-items:center;gap:8px}
  .nav button{width:36px;height:36px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;font-size:1.1rem;cursor:pointer;color:#334155}
  .nav .hoy{width:auto;padding:0 14px;font-size:.85rem;font-weight:600}
  .rango{font-weight:700;font-size:1rem;color:#334155;min-width:180px;text-align:center;text-transform:capitalize}
  .switch{display:flex;background:#e2e8f0;border-radius:10px;padding:3px}
  .switch button{border:none;background:none;padding:7px 16px;border-radius:8px;font-weight:600;font-size:.85rem;cursor:pointer;color:#64748b}
  .switch button.on{background:#fff;color:#065f52;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  .card{background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,.06);overflow:hidden}
  #cal{min-height:300px}
  .load{padding:60px;text-align:center;color:#94a3b8}
  /* Semana */
  .wk{display:grid;grid-template-columns:56px repeat(7,1fr);font-size:.8rem}
  .wk .hcol{position:sticky;top:0;background:#f7fafc;border-bottom:1px solid #e2e8f0;padding:8px 4px;text-align:center;font-weight:700;color:#475569;z-index:2}
  .wk .hcol small{display:block;font-weight:400;color:#94a3b8;font-size:.7rem}
  .wk .hcol.today{color:#0f9d8e}
  .wk .hr{border-bottom:1px solid #f1f5f9;border-right:1px solid #f1f5f9;padding:4px;text-align:right;color:#94a3b8;font-size:.7rem}
  .wk .cell{border-bottom:1px solid #f1f5f9;border-right:1px solid #f1f5f9;min-height:34px;padding:2px}
  .slot{background:#e8f6f3;color:#0a6b60;border:1px solid #6ee7b7;border-radius:6px;padding:3px 5px;font-size:.72rem;cursor:pointer;width:100%;text-align:left;font-weight:600}
  .slot:hover{background:#0f9d8e;color:#fff}
  .cita{background:#3182ce;color:#fff;border-radius:6px;padding:3px 6px;font-size:.72rem;cursor:pointer;width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cita.conf{background:#38a169}
  /* Mes */
  .mo{display:grid;grid-template-columns:repeat(7,1fr)}
  .mo .dh{background:#f7fafc;padding:8px;text-align:center;font-weight:700;font-size:.75rem;color:#475569;border-bottom:1px solid #e2e8f0}
  .mo .day{min-height:92px;border-bottom:1px solid #f1f5f9;border-right:1px solid #f1f5f9;padding:6px;cursor:pointer}
  .mo .day:hover{background:#f7fafc}
  .mo .day.out{background:#fafbfc;color:#cbd5e1;cursor:default}
  .mo .day .dn{font-size:.8rem;font-weight:600;color:#64748b}
  .mo .day.today .dn{background:#0f9d8e;color:#fff;border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center}
  .mo .day .tags{margin-top:5px;display:flex;flex-direction:column;gap:3px}
  .tag{font-size:.68rem;border-radius:5px;padding:2px 5px;font-weight:600}
  .tag.libre{background:#e8f6f3;color:#0a6b60}
  .tag.ocup{background:#dbeafe;color:#1e40af}
  /* Modal */
  .ov{position:fixed;inset:0;background:rgba(15,32,29,.5);display:none;align-items:center;justify-content:center;padding:16px;z-index:10}
  .ov.on{display:flex}
  .modal{background:#fff;border-radius:16px;max-width:420px;width:100%;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.3)}
  .modal h3{font-size:1.1rem;margin-bottom:4px;color:#065f52}
  .modal .when{font-size:.85rem;color:#64748b;margin-bottom:16px;text-transform:capitalize}
  .modal label{display:block;font-size:.8rem;font-weight:600;color:#334155;margin:12px 0 5px}
  .modal input,.modal select{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:.9rem;font-family:inherit}
  .modal input:focus,.modal select:focus{outline:none;border-color:#0f9d8e;box-shadow:0 0 0 3px rgba(15,157,142,.15)}
  .modal .row{display:flex;gap:10px;margin-top:20px}
  .modal .row button{flex:1;padding:11px;border-radius:10px;border:none;font-weight:700;font-size:.9rem;cursor:pointer}
  .b-ok{background:#0f9d8e;color:#fff}.b-cancel{background:#e2e8f0;color:#475569}.b-del{background:#e53e3e;color:#fff}
  .msg{margin-top:12px;font-size:.82rem;padding:8px 10px;border-radius:8px;display:none}
  .msg.err{background:#fee2e2;color:#b91c1c;display:block}.msg.ok{background:#dcfce7;color:#15803d;display:block}
  .hint{text-align:center;color:#94a3b8;font-size:.78rem;margin-top:14px}
</style></head><body>
<header>
  <div><h1>🗓 ${escapeHtml(CLINICA_NOMBRE)} — Agenda</h1><div class="sub">Gestión de citas y disponibilidad</div></div>
  <div class="hbtns">
    <a class="btn" href="/dashboard${tok ? "?token=" + tok : ""}">← Panel</a>
    ${porSesion ? `<a class="btn ghost" href="/dashboard/logout">🔒 Salir</a>` : ""}
  </div>
</header>
<main>
  <div class="toolbar">
    <div class="nav">
      <button id="prev" title="Anterior">‹</button>
      <button class="hoy" id="hoy">Hoy</button>
      <button id="next" title="Siguiente">›</button>
      <span class="rango" id="rango"></span>
    </div>
    <div style="display:flex;gap:10px;align-items:center">
      <select id="selDoc" style="display:none;padding:8px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:.85rem;font-family:inherit"></select>
      <div class="switch"><button id="vSem" class="on">Semana</button><button id="vMes">Mes</button></div>
    </div>
  </div>
  <div class="card"><div id="cal"><div class="load">Cargando agenda…</div></div></div>
  <div class="hint">💡 Toca un horario <b style="color:#0a6b60">disponible</b> para agendar. Toca una <b style="color:#3182ce">cita</b> para ver o cancelar.</div>
</main>

<div class="ov" id="ov"><div class="modal" id="modal"></div></div>

<script>
const TOK = ${JSON.stringify(tok)};
const qs = TOK ? "?token=" + TOK : "";
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function addDays(s,n){const d=new Date(s+"T12:00:00");d.setDate(d.getDate()+n);return iso(d);}
function lunes(d){const x=new Date(d+"T12:00:00");const g=(x.getDay()+6)%7;x.setDate(x.getDate()-g);return iso(x);}
const HOY = iso(new Date());
let vista="sem", ancla=HOY, datos=null, doctorSel="", pacientes=[];
const DIAS=["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"], MESES=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const HORAS=[]; for(let h=8;h<=20;h++){HORAS.push(h+":00");HORAS.push(h+":30");}

function rangoActual(){
  if(vista==="sem"){const d=lunes(ancla);return[d,addDays(d,6)];}
  const x=new Date(ancla+"T12:00:00");const y=x.getFullYear(),m=x.getMonth();
  const first=iso(new Date(y,m,1)),last=iso(new Date(y,m+1,0));
  // el mes se dibuja desde el lunes de la 1a semana al domingo de la última
  return[lunes(first),addDays(lunes(iso(new Date(y,m+1,0))),6)];
}
async function cargar(){
  const [desde,hasta]=rangoActual();
  document.getElementById("cal").innerHTML='<div class="load">Cargando…</div>';
  try{
    const dq=doctorSel?"&doctor="+encodeURIComponent(doctorSel):"";
    const r=await fetch("/agenda/datos"+qs+(qs?"&":"?")+"desde="+desde+"&hasta="+hasta+dq);
    if(!r.ok)throw new Error(r.status===403?"Sesión expirada, vuelve a entrar":"Error "+r.status);
    datos=await r.json();
    // Selector de doctor (solo si hay multi-doctor)
    const sd=document.getElementById("selDoc");
    if((datos.doctores||[]).length>1){
      if(!sd.dataset.filled){sd.innerHTML='<option value="">Todos los profesionales</option>'+datos.doctores.map(d=>'<option value="'+esc(d)+'">'+esc(d)+"</option>").join("");sd.dataset.filled="1";sd.onchange=()=>{doctorSel=sd.value;cargar();};}
      sd.style.display="";
    }
    vista==="sem"?pintarSemana():pintarMes();
  }catch(e){document.getElementById("cal").innerHTML='<div class="load">⚠️ '+e.message+'</div>';}
}
function label(){
  if(vista==="sem"){const d=lunes(ancla),f=new Date(d+"T12:00:00"),g=new Date(addDays(d,6)+"T12:00:00");
    return f.getDate()+" "+MESES[f.getMonth()].slice(0,3)+" – "+g.getDate()+" "+MESES[g.getMonth()].slice(0,3)+" "+g.getFullYear();}
  const x=new Date(ancla+"T12:00:00");return MESES[x.getMonth()]+" "+x.getFullYear();
}
function pintarSemana(){
  document.getElementById("rango").textContent=label();
  const d0=lunes(ancla),dias=[...Array(7)].map((_,i)=>addDays(d0,i));
  const slotsBy={},citasBy={};
  (datos.slots||[]).forEach(s=>{(slotsBy[s.fecha]=slotsBy[s.fecha]||{})[s.hora.slice(0,5)]=s;});
  (datos.citas||[]).forEach(c=>{const h=(c.hora||"").slice(0,5);(citasBy[c.fecha]=citasBy[c.fecha]||{})[h]=c;});
  let h='<div class="wk"><div class="hcol"></div>';
  dias.forEach((f,i)=>{const x=new Date(f+"T12:00:00");h+='<div class="hcol'+(f===HOY?" today":"")+'">'+DIAS[i]+'<small>'+x.getDate()+"</small></div>";});
  HORAS.forEach(hora=>{
    h+='<div class="hr">'+hora+"</div>";
    dias.forEach(f=>{
      const cita=(citasBy[f]||{})[hora.length===4?"0"+hora:hora]||(citasBy[f]||{})[hora];
      const slot=(slotsBy[f]||{})[hora.length===4?"0"+hora:hora]||(slotsBy[f]||{})[hora];
      h+='<div class="cell">';
      if(cita)h+='<div class="cita '+(cita.estado==="Confirmada"?"conf":"")+'" onclick=\\'verCita('+JSON.stringify(cita.id)+')\\'>'+esc(cita.nombre)+"</div>";
      else if(slot)h+='<button class="slot" onclick=\\'nueva('+JSON.stringify(slot)+')\\'>+ '+hora+"</button>";
      h+="</div>";
    });
  });
  h+="</div>";document.getElementById("cal").innerHTML=h;
}
function pintarMes(){
  document.getElementById("rango").textContent=label();
  const [desde]=rangoActual();
  const x=new Date(ancla+"T12:00:00"),mes=x.getMonth();
  const libresBy={},citasBy={};
  (datos.slots||[]).forEach(s=>libresBy[s.fecha]=(libresBy[s.fecha]||0)+1);
  (datos.citas||[]).forEach(c=>citasBy[c.fecha]=(citasBy[c.fecha]||0)+1);
  let h='<div class="mo">';
  DIAS.forEach(d=>h+='<div class="dh">'+d+"</div>");
  for(let i=0;i<42;i++){
    const f=addDays(desde,i),dd=new Date(f+"T12:00:00");
    const out=dd.getMonth()!==mes;
    h+='<div class="day'+(out?" out":"")+(f===HOY?" today":"")+'"'+(out?"":' onclick=\\'irDia('+JSON.stringify(f)+')\\'')+'>';
    h+='<span class="dn">'+dd.getDate()+"</span>";
    if(!out){h+='<div class="tags">';
      if(citasBy[f])h+='<span class="tag ocup">'+citasBy[f]+" cita"+(citasBy[f]>1?"s":"")+"</span>";
      if(libresBy[f])h+='<span class="tag libre">'+libresBy[f]+" libre"+(libresBy[f]>1?"s":"")+"</span>";
      h+="</div>";}
    h+="</div>";
    if(i>=34&&addDays(desde,i+1)>iso(new Date(x.getFullYear(),mes+1,0))&&new Date(addDays(desde,i+1)+"T12:00:00").getMonth()!==mes)break;
  }
  h+="</div>";document.getElementById("cal").innerHTML=h;
}
function irDia(f){ancla=f;vista="sem";document.getElementById("vSem").classList.add("on");document.getElementById("vMes").classList.remove("on");cargar();}
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
// Modal nueva cita
function nueva(slot){
  const f=new Date(slot.start),cuando=f.toLocaleDateString("es-CL",{weekday:"long",day:"numeric",month:"long"})+" · "+slot.hora;
  const ops=(datos.servicios||[]).map(s=>'<option value="'+esc(s.nombre)+'">'+esc(s.nombre)+(s.precio?" — $"+Number(s.precio).toLocaleString("es-CL"):"")+"</option>").join("");
  const dl=pacientes.map(p=>'<option value="'+esc(p.nombre)+'">'+(p.telefono?esc(p.telefono):"")+"</option>").join("");
  document.getElementById("modal").innerHTML='<h3>Nueva cita</h3><div class="when">'+cuando+'</div>'+
    '<label>Nombre del paciente *</label><input id="mNom" list="dlPac" autocomplete="off" autofocus><datalist id="dlPac">'+dl+"</datalist>"+
    '<label>Teléfono (opcional)</label><input id="mTel" inputmode="tel" placeholder="56912345678">'+
    '<label>Servicio *</label><select id="mSrv">'+ops+"</select>"+
    '<div class="msg" id="mMsg"></div>'+
    '<div class="row"><button class="b-cancel" onclick="cerrar()">Cancelar</button><button class="b-ok" id="mSave">Agendar</button></div>';
  document.getElementById("ov").classList.add("on");
  // Al elegir un paciente existente, rellenar su teléfono
  document.getElementById("mNom").addEventListener("input",e=>{
    const p=pacientes.find(x=>x.nombre===e.target.value);
    if(p&&p.telefono)document.getElementById("mTel").value=p.telefono;
  });
  document.getElementById("mSave").onclick=async()=>{
    const nombre=document.getElementById("mNom").value.trim();
    const servicio=document.getElementById("mSrv").value;
    if(!nombre)return showMsg("mMsg","Falta el nombre.","err");
    document.getElementById("mSave").disabled=true;document.getElementById("mSave").textContent="Agendando…";
    try{
      const r=await fetch("/agenda/cita"+qs,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({slotId:slot.id,nombre,telefono:document.getElementById("mTel").value,servicio})});
      const d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||"Error");
      showMsg("mMsg","✅ Cita agendada","ok");setTimeout(()=>{cerrar();cargar();},700);
    }catch(e){showMsg("mMsg",e.message,"err");document.getElementById("mSave").disabled=false;document.getElementById("mSave").textContent="Agendar";}
  };
}
function verCita(id){
  const c=(datos.citas||[]).find(x=>x.id===id);if(!c)return;
  const ops=(datos.servicios||[]).map(s=>'<option value="'+esc(s.nombre)+'"'+(s.nombre===c.tratamiento?" selected":"")+">"+esc(s.nombre)+"</option>").join("");
  // Slots disponibles próximos para reagendar (del rango ya cargado)
  const slotsOrd=(datos.slots||[]).slice().sort((a,b)=>a.start<b.start?-1:1);
  const slotOps='<option value="">— mantener horario actual —</option>'+slotsOrd.map(s=>{
    const f=new Date(s.start);return '<option value="'+esc(s.id)+'">'+f.toLocaleDateString("es-CL",{weekday:"short",day:"numeric",month:"short"})+" · "+s.hora+"</option>";
  }).join("");
  document.getElementById("modal").innerHTML='<h3>Cita de '+esc(c.nombre)+'</h3><div class="when">'+esc(c.fecha)+' · '+esc(c.hora)+' — '+esc(c.estado)+'</div>'+
    '<label>Nombre</label><input id="eNom" value="'+esc(c.nombre)+'">'+
    '<label>Teléfono</label><input id="eTel" inputmode="tel" value="'+esc(c.telefono||"")+'">'+
    '<label>Servicio</label><select id="eSrv">'+ops+"</select>"+
    '<label>Reagendar a otro horario</label><select id="eSlot">'+slotOps+"</select>"+
    '<div class="msg" id="mMsg"></div>'+
    '<div class="row"><button class="b-del" id="mDel">Cancelar cita</button><button class="b-ok" id="mSave">Guardar</button></div>'+
    '<div style="text-align:center;margin-top:10px"><a href="#" onclick="cerrar();return false" style="color:#94a3b8;font-size:.82rem">Cerrar sin cambios</a></div>';
  document.getElementById("ov").classList.add("on");
  document.getElementById("mSave").onclick=async()=>{
    document.getElementById("mSave").disabled=true;document.getElementById("mSave").textContent="Guardando…";
    try{
      const r=await fetch("/agenda/editar"+qs,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({citaId:id,nombre:document.getElementById("eNom").value,telefono:document.getElementById("eTel").value,servicio:document.getElementById("eSrv").value,nuevoSlotId:document.getElementById("eSlot").value})});
      const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Error");
      showMsg("mMsg","✅ Cambios guardados","ok");setTimeout(()=>{cerrar();cargar();},700);
    }catch(e){showMsg("mMsg",e.message,"err");document.getElementById("mSave").disabled=false;document.getElementById("mSave").textContent="Guardar";}
  };
  document.getElementById("mDel").onclick=async()=>{
    if(!confirm("¿Cancelar la cita de "+c.nombre+"? El horario quedará libre."))return;
    document.getElementById("mDel").disabled=true;document.getElementById("mDel").textContent="Cancelando…";
    try{
      const r=await fetch("/agenda/cancelar"+qs,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({citaId:id})});
      const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Error");
      showMsg("mMsg","Cita cancelada","ok");setTimeout(()=>{cerrar();cargar();},700);
    }catch(e){showMsg("mMsg",e.message,"err");document.getElementById("mDel").disabled=false;document.getElementById("mDel").textContent="Cancelar cita";}
  };
}
function showMsg(id,t,k){const m=document.getElementById(id);m.textContent=t;m.className="msg "+k;}
function cerrar(){document.getElementById("ov").classList.remove("on");}
document.getElementById("ov").onclick=e=>{if(e.target.id==="ov")cerrar();};
document.getElementById("prev").onclick=()=>{ancla=vista==="sem"?addDays(ancla,-7):iso(new Date(new Date(ancla+"T12:00:00").setMonth(new Date(ancla+"T12:00:00").getMonth()-1)));cargar();};
document.getElementById("next").onclick=()=>{ancla=vista==="sem"?addDays(ancla,7):iso(new Date(new Date(ancla+"T12:00:00").setMonth(new Date(ancla+"T12:00:00").getMonth()+1)));cargar();};
document.getElementById("hoy").onclick=()=>{ancla=HOY;cargar();};
document.getElementById("vSem").onclick=()=>{vista="sem";document.getElementById("vSem").classList.add("on");document.getElementById("vMes").classList.remove("on");cargar();};
document.getElementById("vMes").onclick=()=>{vista="mes";document.getElementById("vMes").classList.add("on");document.getElementById("vSem").classList.remove("on");cargar();};
// Cargar pacientes para autocompletar (no bloquea la agenda)
fetch("/agenda/pacientes"+qs).then(r=>r.ok?r.json():{pacientes:[]}).then(d=>{pacientes=d.pacientes||[];}).catch(()=>{});
cargar();
</script></body></html>`;
}

// Datos de un rango: slots disponibles + citas + catálogo de servicios
app.get("/agenda/datos", async (req, res) => {
  if (!httpRateLimitOk(req.ip, 60)) return res.sendStatus(429);
  if (!accesoPanel(req)) return res.sendStatus(403);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde) ? req.query.desde : hoyLocal();
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta) ? req.query.hasta : sumarDias(desde, 6);
  const doctorFiltro = (req.query.doctor || "").trim();  // multi-doctor: filtra por profesional
  const calId = doctorFiltro ? calendarIdForDoctor(doctorFiltro) : GOOGLE_CALENDAR_ID;
  try {
    const [slots, rows, servicios] = await Promise.all([
      getSlotsRango(desde, hasta, calId),
      getCitasRows(),
      getServicios(),
    ]);
    // Citas activas dentro del rango (usa col M FechaHora ISO)
    const citas = rows
      .map(({ row }) => row)
      .filter(r => r[12] && r[12].slice(0, 10) >= desde && r[12].slice(0, 10) <= hasta)
      .filter(r => !["Cancelada", "Reagendada", "Cancelada (sin pago)"].includes(r[10]))
      .filter(r => !doctorFiltro || (r[17] || "") === doctorFiltro)
      .map(r => ({
        id: r[0], nombre: r[3], telefono: r[2], tratamiento: r[6],
        fecha: r[12].slice(0, 10), hora: r[9] || r[12].slice(11, 16),
        estado: r[10], doctor: r[17] || "",
      }));
    res.set("Cache-Control", "no-store").json({
      desde, hasta, slots, citas,
      servicios: servicios.map(s => ({ nombre: s.nombre, precio: s.precio, abono: s.abono })),
      doctores: DOCTORES.map(d => d.nombre),
    });
  } catch (e) {
    console.error("/agenda/datos:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Alta manual de una cita desde el panel (elige un slot disponible)
app.post("/agenda/cita", async (req, res) => {
  if (!httpRateLimitOk(req.ip, 30)) return res.sendStatus(429);
  if (!accesoPanel(req)) return res.sendStatus(403);
  const { slotId, nombre, telefono, servicio } = req.body || {};
  if (!slotId || !nombre || !servicio) return res.status(400).json({ error: "Faltan datos (slot, nombre o servicio)." });
  try {
    // Ubicar el slot elegido (debe seguir disponible)
    const hoy = hoyLocal();
    const slots = await getSlotsRango(hoy, sumarDias(hoy, 120));
    const slot = slots.find(s => s.id === slotId);
    if (!slot) return res.status(409).json({ error: "Ese horario ya no está disponible. Actualiza la agenda." });

    const dt = new Date(slot.start);
    const servicios = await getServicios();
    const svc = servicios.find(s => s.nombre === servicio) || { precio: "" };
    const citaId = `CITA-${Date.now()}`;
    const datos = {
      citaId, phone: (telefono || "").replace(/\D/g, ""), nombre: nombre.trim(),
      tratamiento: servicio, precio: svc.precio || "",
      fechaCita: dt.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ }),
      horaCita: slot.hora, fechaHora: slot.start, slotId, channel: "manual",
      estado: "Agendada", origen: "manual",
    };
    await Promise.all([
      bookSlot(slotId, datos, GOOGLE_CALENDAR_ID),
      logSheets(datos),
    ]);
    // Avisar al paciente por WhatsApp solo si dio un número válido
    if (datos.phone && datos.phone.length >= 8) {
      const session = getSession(datos.phone); session.channel = "twilio";
      msg(datos.phone,
        `✅ *${CLINICA_NOMBRE}* — tu cita quedó agendada:\n\n` +
        `${R.emoji} ${servicio}\n📅 ${datos.fechaCita}\n⏰ ${slot.hora}\n\n` +
        `Recuerda llegar 10 minutos antes. ¡Te esperamos! 😊`
      ).catch(() => {});
    }
    res.json({ ok: true, citaId });
  } catch (e) {
    console.error("/agenda/cita:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Cancelar una cita desde el panel (libera el horario)
app.post("/agenda/cancelar", async (req, res) => {
  if (!httpRateLimitOk(req.ip, 30)) return res.sendStatus(429);
  if (!accesoPanel(req)) return res.sendStatus(403);
  const { citaId } = req.body || {};
  if (!citaId) return res.status(400).json({ error: "Falta el ID de la cita." });
  try {
    const cita = await buscarCitaPorId(citaId);
    if (!cita) return res.status(404).json({ error: "Cita no encontrada." });
    await setCitaCell(cita.rowNum, "K", "Cancelada");
    await liberarSlot(cita.row[13], calendarIdForDoctor(cita.row[17]));
    res.json({ ok: true });
  } catch (e) {
    console.error("/agenda/cancelar:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Pacientes ya registrados (para autocompletar en el alta) — dedupe por teléfono/nombre
app.get("/agenda/pacientes", async (req, res) => {
  if (!httpRateLimitOk(req.ip, 60)) return res.sendStatus(429);
  if (!accesoPanel(req)) return res.sendStatus(403);
  try {
    const rows = await getCitasRows();
    const vistos = new Map();
    for (const { row } of rows) {
      const nombre = (row[3] || "").trim();
      const tel = (row[2] || "").replace(/\D/g, "");
      if (!nombre) continue;
      const clave = tel || nombre.toLowerCase();
      if (!vistos.has(clave)) vistos.set(clave, { nombre, telefono: tel, rut: row[4] || "" });
    }
    res.set("Cache-Control", "no-store").json({ pacientes: [...vistos.values()].slice(0, 500) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Editar una cita: cambiar datos (nombre/teléfono/servicio) y/o reagendar a otro slot
app.post("/agenda/editar", async (req, res) => {
  if (!httpRateLimitOk(req.ip, 30)) return res.sendStatus(429);
  if (!accesoPanel(req)) return res.sendStatus(403);
  const { citaId, nombre, telefono, servicio, nuevoSlotId } = req.body || {};
  if (!citaId) return res.status(400).json({ error: "Falta la cita." });
  try {
    const cita = await buscarCitaPorId(citaId);
    if (!cita) return res.status(404).json({ error: "Cita no encontrada." });
    const r = cita.row, n = cita.rowNum;
    const calId = calendarIdForDoctor(r[17]);

    // 1) Datos editables
    if (nombre && nombre.trim() && nombre.trim() !== r[3]) await setCitaCell(n, "D", nombre.trim());
    if (telefono !== undefined) await setCitaCell(n, "C", (telefono || "").replace(/\D/g, ""));
    if (servicio && servicio !== r[6]) {
      await setCitaCell(n, "G", servicio);
      const servicios = await getServicios();
      const svc = servicios.find(s => s.nombre === servicio);
      if (svc) await setCitaCell(n, "S", svc.precio || "");
    }

    // 2) Reagendar a otro horario
    if (nuevoSlotId) {
      const hoy = hoyLocal();
      const slots = await getSlotsRango(hoy, sumarDias(hoy, 120), calId);
      const slot = slots.find(s => s.id === nuevoSlotId);
      if (!slot) return res.status(409).json({ error: "Ese horario ya no está disponible." });
      const dt = new Date(slot.start);
      const nombreFinal = (nombre && nombre.trim()) || r[3];
      const servFinal   = servicio || r[6];
      // liberar el slot viejo, bloquear el nuevo, actualizar la fila
      await liberarSlot(r[13], calId);
      await bookSlot(nuevoSlotId, { nombre: nombreFinal, tratamiento: servFinal, phone: r[2], rut: r[4], email: r[5] }, calId);
      await setCitaCell(n, "I", dt.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ }));
      await setCitaCell(n, "J", slot.hora);
      await setCitaCell(n, "M", slot.start);
      await setCitaCell(n, "N", nuevoSlotId);
      await setCitaCell(n, "P", "");  // reinicia el recordatorio (nueva fecha)
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("/agenda/editar:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Dashboard para secretaria y doctor ──────────────────────────────────────
// ── Login del dashboard ──────────────────────────────────────────────────────
function paginaLogin(msg = "") {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${CLINICA_NOMBRE} — Acceso</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f0f4f8;
min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.1);padding:36px 32px;width:100%;max-width:380px}
h1{font-size:1.2rem;color:#065f52;margin-bottom:4px}p.s{color:#94a3b8;font-size:.85rem;margin-bottom:22px}
label{display:block;font-size:.82rem;font-weight:600;color:#334155;margin:14px 0 6px}
input{width:100%;padding:11px 14px;border:1px solid #cbd5e1;border-radius:9px;font-size:.95rem}
input:focus{outline:none;border-color:#0f9d8e;box-shadow:0 0 0 3px rgba(15,157,142,.15)}
button{width:100%;margin-top:22px;background:#0f9d8e;color:#fff;border:none;padding:12px;border-radius:10px;
font-weight:700;font-size:.95rem;cursor:pointer}button:hover{background:#0c8a7c}
.err{background:#fee2e2;color:#b91c1c;border-radius:8px;padding:10px 12px;font-size:.85rem;margin-bottom:16px}</style>
</head><body><form class="box" method="POST" action="/dashboard/login">
<h1>${escapeHtml(CLINICA_NOMBRE)}</h1><p class="s">Panel de citas — acceso privado</p>
${msg ? `<div class="err">${escapeHtml(msg)}</div>` : ""}
<label>Usuario</label><input name="user" autocomplete="username" required autofocus>
<label>Contraseña</label><input name="pass" type="password" autocomplete="current-password" required>
<button type="submit">Ingresar</button></form></body></html>`;
}

app.get("/dashboard/login", (req, res) => {
  if (!HAY_LOGIN) return res.redirect("/dashboard");  // login no configurado
  if (getPanelSession(req)) return res.redirect("/dashboard");
  res.set("Cache-Control", "no-store").send(paginaLogin());
});

app.post("/dashboard/login", express.urlencoded({ extended: false }), (req, res) => {
  if (!httpRateLimitOk(req.ip, 10)) return res.status(429).send("Demasiados intentos — espera 1 minuto");
  if (!HAY_LOGIN) return res.redirect("/dashboard");
  if (loginValido(req.body.user || "", req.body.pass || "")) { createPanelSession(res); return res.redirect("/dashboard"); }
  res.status(401).set("Cache-Control", "no-store").send(paginaLogin("Usuario o contraseña incorrectos."));
});

app.get("/dashboard/logout", (req, res) => {
  clearPanelSession(req, res);
  res.redirect("/dashboard/login");
});

app.get("/dashboard", async (req, res) => {
  if (!httpRateLimitOk(req.ip, 30)) return res.status(429).send("Demasiadas solicitudes — intenta en 1 minuto");
  // Acceso: sesión de login (humano) O token en URL (manager / acceso rápido)
  const porSesion = !!getPanelSession(req);
  const porToken  = tokenOk(req.query.token, DASHBOARD_TOKEN);
  if (!porSesion && !porToken) {
    return HAY_LOGIN ? res.redirect("/dashboard/login") : res.sendStatus(403);
  }
  res.set({
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
    "X-Content-Type-Options":  "nosniff",
    "X-Frame-Options":         "DENY",
    "Referrer-Policy":         "no-referrer",
    "Cache-Control":           "no-store",
  });

  const calUrl   = GOOGLE_CALENDAR_ID
    ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(GOOGLE_CALENDAR_ID)}`
    : "https://calendar.google.com";
  const sheetUrl = GOOGLE_SPREADSHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${GOOGLE_SPREADSHEET_ID}/edit#gid=0`
    : "https://sheets.google.com";
  const sesionesActivas = Object.keys(sessions).length;

  // Leer citas desde Google Sheets (fuente de verdad)
  let citasRows = [];
  let allRows   = [];
  let totalCitas = 0;
  if (googleAuth && GOOGLE_SPREADSHEET_ID) {
    try {
      const rows = await getCitasRows();
      allRows    = rows.map(r => r.row);
      totalCitas = allRows.length;
      citasRows  = allRows.slice(-20).reverse(); // últimas 20, más reciente primero
    } catch (e) {
      console.error("Dashboard sheets error:", e.message);
    }
  }

  // Estadísticas (usan col M = FechaHora ISO)
  const hoyISO      = new Date().toISOString().slice(0, 10);
  const en7dias     = Date.now() + 7 * 24 * 3600 * 1000;
  const activas     = allRows.filter(r => !["Cancelada", "Reagendada"].includes(r[10]));
  const citasHoy    = activas.filter(r => (r[12] || "").slice(0, 10) === hoyISO).length;
  const citasSemana = activas.filter(r => {
    const ms = new Date(r[12] || 0).getTime();
    return ms > Date.now() && ms < en7dias;
  }).length;
  const canceladas  = allRows.filter(r => r[10] === "Cancelada").length;
  const noAsistio   = allRows.filter(r => r[10] === "No asistió").length;
  const conteoTrat  = {};
  for (const r of activas) if (r[6]) conteoTrat[r[6]] = (conteoTrat[r[6]] || 0) + 1;
  const topTrat = Object.entries(conteoTrat).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

  const estadoColor = {
    Agendada: "#3182ce", Confirmada: "#38a169", Atendida: "#0f9d8e",
    Cancelada: "#e53e3e", Reagendada: "#d69e2e",
    "No asistió": "#dd6b20", "Pendiente confirmación": "#718096",
  };

  const tablaCitas = citasRows.length === 0
    ? `<div class="empty">📭 Aún no hay citas registradas. Las citas agendadas por WhatsApp aparecerán aquí automáticamente.</div>`
    : `<div class="table-wrap">
        <table>
          <thead><tr>
            <th>Fecha</th><th>Hora</th><th>Nombre</th><th>Teléfono</th>
            <th>Tratamiento</th><th>RUT</th><th>Email</th><th>Estado</th>
          </tr></thead>
          <tbody>
            ${citasRows.map(r => {
              const estado = r[10] || "Agendada";
              const color  = estadoColor[estado] || "#718096";
              return `<tr>
                <td>${escapeHtml(r[8]) || "—"}</td>
                <td><strong>${escapeHtml(r[9]) || "—"}</strong></td>
                <td>${escapeHtml(r[3]) || "—"}</td>
                <td>${escapeHtml(r[2]) || "—"}</td>
                <td>${escapeHtml(r[6]) || "—"}</td>
                <td>${escapeHtml(r[4]) || "—"}</td>
                <td>${escapeHtml(r[5]) || "—"}</td>
                <td><span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${escapeHtml(estado)}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CLINICA_NOMBRE} — Panel de Citas</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f0f4f8; color: #2d3748; min-height: 100vh; }
  header { background: linear-gradient(135deg, #065f52, #0f9d8e); color: #fff; padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  header h1 { font-size: 1.4rem; font-weight: 700; }
  header p  { opacity: .75; margin-top: 3px; font-size: .85rem; }
  .hdr-links { display: flex; gap: 10px; }
  .hdr-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: .82rem; font-weight: 600; text-decoration: none; transition: opacity .15s; }
  .hdr-btn:hover { opacity: .85; }
  .btn-cal  { background: rgba(255,255,255,0.18); color: #fff; border: 1px solid rgba(255,255,255,0.3); }
  .btn-sheet{ background: #fff; color: #065f52; }
  main { max-width: 1000px; margin: 28px auto; padding: 0 20px; }
  .stats { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: #fff; border-radius: 12px; padding: 16px 20px; flex: 1; min-width: 140px;
          box-shadow: 0 2px 6px rgba(0,0,0,.07); text-align: center; }
  .stat .num { font-size: 2rem; font-weight: 800; color: #0f9d8e; line-height: 1; }
  .stat .lbl { font-size: .78rem; color: #a0aec0; margin-top: 4px; text-transform: uppercase; letter-spacing: .5px; }
  .section-title { font-size: 1rem; font-weight: 700; color: #2d3748; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .table-wrap { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.07); overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  thead tr { background: #f7fafc; }
  th { padding: 11px 14px; text-align: left; font-size: .75rem; font-weight: 700; color: #718096; text-transform: uppercase; letter-spacing: .5px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
  td { padding: 11px 14px; border-bottom: 1px solid #f0f4f8; color: #2d3748; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f7fafc; }
  .badge { font-size: .75rem; font-weight: 600; padding: 3px 10px; border-radius: 20px; white-space: nowrap; }
  .empty { background: #fff; border-radius: 12px; padding: 40px; text-align: center; color: #a0aec0; font-size: .95rem; box-shadow: 0 2px 8px rgba(0,0,0,.07); }
  .hint { margin-top: 16px; background: #e6fffa; border: 1px solid #81e6d9; border-radius: 10px; padding: 12px 18px; font-size: .83rem; color: #234e52; }
  .hint strong { color: #065f52; }
  footer { text-align: center; color: #a0aec0; font-size: .78rem; margin: 28px 0; }
  @media(max-width:600px){ th:nth-child(4),td:nth-child(4),th:nth-child(6),td:nth-child(6),th:nth-child(7),td:nth-child(7){ display:none; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>${R.emoji} ${CLINICA_NOMBRE} — Panel de Citas</h1>
    <p>${new Date().toLocaleDateString("es-CL", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</p>
  </div>
  <div class="hdr-links">
    <a class="hdr-btn btn-sheet" href="/agenda${porToken ? "?token=" + encodeURIComponent(req.query.token) : ""}">🗓 Agenda</a>
    <a class="hdr-btn btn-cal" href="${calUrl}" target="_blank">📅 Calendario</a>
    <a class="hdr-btn btn-sheet" href="${sheetUrl}" target="_blank">📊 Planilla</a>
    ${porSesion ? `<a class="hdr-btn btn-cal" href="/dashboard/logout">🔒 Salir</a>` : ""}
  </div>
</header>
<main>
  <div class="stats">
    <div class="stat"><div class="num">${totalCitas}</div><div class="lbl">Citas totales</div></div>
    <div class="stat"><div class="num">${citasHoy}</div><div class="lbl">Citas hoy</div></div>
    <div class="stat"><div class="num">${citasSemana}</div><div class="lbl">Próximos 7 días</div></div>
    <div class="stat"><div class="num">${canceladas}</div><div class="lbl">Canceladas</div></div>
    <div class="stat"><div class="num">${noAsistio}</div><div class="lbl">No asistieron</div></div>
    <div class="stat"><div class="num">${sesionesActivas}</div><div class="lbl">Chats activos</div></div>
    <div class="stat"><div class="num" style="font-size:1rem;padding-top:8px;">${escapeHtml(topTrat)}</div><div class="lbl">Tratamiento top</div></div>
  </div>
  <div class="section-title">📋 Últimas citas agendadas <span style="font-size:.78rem;font-weight:400;color:#a0aec0;">(máx. 20 · más reciente primero)</span></div>
  ${tablaCitas}
  <div class="hint">
    💡 <strong>¿Cómo agregar horarios disponibles?</strong> Abre Google Calendar y crea eventos con el título exacto <strong>DISPONIBLE</strong> en los horarios que quieres ofrecer. El bot los leerá en tiempo real.
  </div>
</main>
<footer>Panel protegido · ${CLINICA_NOMBRE} WhatsApp Bot · Actualiza la página para ver nuevas citas</footer>
</body>
</html>`);
});

// ─── Generar disponibilidad (lo invoca el panel maestro o la secretaria) ─────
app.post("/generar-disponibilidad", async (req, res) => {
  if (!httpRateLimitOk(req.ip, 10)) return res.status(429).json({ error: "Demasiadas solicitudes" });
  if (!tokenOk(req.query.token || req.body?.token, DASHBOARD_TOKEN)) return res.sendStatus(403);

  const periodo = (req.body?.periodo || req.query.periodo || "mes").toString();
  const doctor  = (req.body?.doctor || req.query.doctor || "").toString().trim();
  const calId   = doctor ? calendarIdForDoctor(doctor) : GOOGLE_CALENDAR_ID;
  const [desde, hasta] = rangoDePeriodo(periodo);
  try {
    const r = await generarDisponibilidad(desde, hasta, calId);
    res.json({ ok: !r.error, periodo, desde, hasta, doctor: doctor || null, ...r });
  } catch (e) {
    console.error("generar-disponibilidad:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Piloto automático: mantiene siempre AUTO_SEMANAS por delante (1 vez al día)
let ultimaAutoGen = "";
async function jobAutoDisponibilidad() {
  if (!AUTO_DISPONIBILIDAD || !GOOGLE_CALENDAR_ID) return;
  const hoy = hoyLocal();
  if (ultimaAutoGen === hoy) return;
  ultimaAutoGen = hoy;
  const hasta = sumarDias(hoy, AUTO_SEMANAS * 7);
  // Con multi-doctor, mantener la disponibilidad de cada agenda; si no, la general
  const calendarios = DOCTORES.length > 1
    ? DOCTORES.map(d => ({ nombre: d.nombre, calId: d.calendarId || GOOGLE_CALENDAR_ID }))
    : [{ nombre: "", calId: GOOGLE_CALENDAR_ID }];
  for (const { nombre, calId } of calendarios) {
    try {
      const r = await generarDisponibilidad(hoy, hasta, calId);
      if (r.creados) console.log(`🤖 Piloto automático${nombre ? ` (${nombre})` : ""}: ${r.creados} bloques`);
    } catch (e) { console.error("jobAutoDisponibilidad:", e.message); }
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  ok:      true,
  clinica: CLINICA_NOMBRE,
  ts:      new Date().toISOString(),
  sesiones: Object.keys(sessions).length,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${R.emoji} ${CLINICA_NOMBRE} WhatsApp Bot — puerto ${PORT}`);
  console.log(`   Webhook:   /webhook`);
  console.log(`   Dashboard: /dashboard?token=<DASHBOARD_TOKEN>`);
  console.log(`   Health:    /health`);
});
