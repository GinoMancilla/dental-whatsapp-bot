require("dotenv").config();
const express   = require("express");
const axios     = require("axios");
const { Resend } = require("resend");
const { google } = require("googleapis");
const Anthropic  = require("@anthropic-ai/sdk");
const crypto    = require("crypto");

const app = express();
app.set("trust proxy", 1);
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
const SECRETARIA_PHONE  = process.env.SECRETARIA_PHONE  || "";   // WhatsApp de la secretaria para notificaciones
const LINK_PAGO         = process.env.LINK_PAGO         || "";   // Link de pago para abonos (Mercado Pago / Flow)
const GOOGLE_MAPS_URL   = process.env.GOOGLE_MAPS_URL   || "";   // Link para reseñas de Google Maps
const CLINICA_DIRECCION = process.env.CLINICA_DIRECCION || "";
const CLINICA_HORARIO   = process.env.CLINICA_HORARIO   || "Lunes a Viernes, 9:00 a 19:00 hrs";
const RECALL_MESES      = parseInt(process.env.RECALL_MESES || "6", 10); // Meses sin venir para recall

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
      range: "Citas!A2:R",
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

// Crea las pestañas ListaEspera y Recalls si no existen, y actualiza los headers
async function ensureSheetSetup() {
  if (!googleAuth || !GOOGLE_SPREADSHEET_ID) return;
  try {
    const sheets = await sheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SPREADSHEET_ID });
    const titles = meta.data.sheets.map(s => s.properties.title);
    const requests = [];
    for (const t of ["ListaEspera", "Recalls"]) {
      if (!titles.includes(t)) requests.push({ addSheet: { properties: { title: t } } });
    }
    if (requests.length) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: GOOGLE_SPREADSHEET_ID, requestBody: { requests } });
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Citas!A1:R1",
      valueInputOption: "RAW",
      requestBody: { values: [[
        "ID","Timestamp","Teléfono","Nombre","RUT","Email","Tratamiento","Urgente",
        "Fecha Cita","Hora Cita","Estado","Notas","FechaHora ISO","EventID","Canal",
        "Recordatorio","Encuesta","Doctor",
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
        `🦷 ${row[6]}\n📅 ${row[8]}\n⏰ ${row[9]}\n\n` +
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
        `👤 ${row[3]}\n📅 ${row[8]} · ${row[9]}\n🦷 ${row[6]}\n📱 ${row[2]}\n\n` +
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
        `Ya han pasado más de ${RECALL_MESES} meses desde tu última visita 🦷\n` +
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
    `👤 ${row[3]}\n📅 ${row[8]} · ${row[9]}\n🦷 ${row[6]}\n📱 ${row[2]}`
  );
  notificarListaEspera(row[8], row[9]);
}

// ─── Lista de espera ──────────────────────────────────────────────────────────
async function agregarListaEspera(phone, nombre, tratamiento, channel) {
  await appendTabRow("ListaEspera", [
    new Date().toISOString(), phone, nombre || "", tratamiento || "", channel || "twilio", "Esperando",
  ]);
  notifySecretaria(`📋 Nuevo paciente en lista de espera:\n👤 ${nombre}\n🦷 ${tratamiento}\n📱 ${phone}`);
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
        `Escribe *1* para agendar antes de que se ocupe 🦷`, channel);
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
      label: fmtDT(new Date(e.start.dateTime)),
    }));
  } catch (e) {
    console.error("Calendar getSlots error:", e.message);
    return getDemoSlots();
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
      slots.push({ id: `demo-${d}-${h}`, start: s.toISOString(), label: fmtDT(s) });
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
      range:           "Citas!A:R",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          `CITA-${Date.now()}`,
          new Date().toLocaleString("es-CL"),
          datos.phone,
          datos.nombre   || "",
          datos.rut      || "",
          datos.email    || "",
          datos.tratamiento || "",
          datos.urgente  ? "Sí" : "No",
          datos.fechaCita || "",
          datos.horaCita  || "",
          "Agendada",
          datos.reagendando ? "Reagendada por el paciente" : "",
          datos.fechaHora || "",
          datos.slotId    || "",
          datos.channel   || "twilio",
          "",   // Recordatorio (lo llena el job)
          "",   // Encuesta (la llena el job)
          datos.doctor    || "",
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
  const detalle = `Tratamiento: ${datos.tratamiento}\nFecha: ${datos.fechaCita}\nHora: ${datos.horaCita}`;

  if (toEmail && toEmail !== DOCTOR_EMAIL) {
    resendClient.emails.send({
      from,
      to:      toEmail,
      subject: `✅ Confirmación de cita — ${datos.fechaCita}, ${datos.horaCita}`,
      html:    `<h2>¡Tu cita está confirmada! 🦷</h2>
                <p><strong>Paciente:</strong> ${datos.nombre}</p>
                <pre>${detalle}</pre>
                <p>Recuerda llegar <strong>10 minutos antes</strong>. Para cancelar o reagendar llama al ${CLINICA_TELEFONO}.</p>
                <p style="color:#666"><em>${CLINICA_NOMBRE}</em></p>`,
    }).catch(e => console.error("Email paciente:", e.message));
  }

  if (DOCTOR_EMAIL) {
    resendClient.emails.send({
      from,
      to: DOCTOR_EMAIL,
      subject: `🦷 Nueva cita: ${datos.nombre} — ${datos.fechaCita} ${datos.horaCita}`,
      html:    `<h2>Nueva cita agendada vía WhatsApp Bot</h2>
                <p><strong>Nombre:</strong> ${datos.nombre}</p>
                <p><strong>RUT:</strong> ${datos.rut || "—"}</p>
                <p><strong>Teléfono:</strong> ${datos.phone}</p>
                <p><strong>Email:</strong> ${datos.email || "—"}</p>
                <pre>${detalle}</pre>
                <p><strong>Urgente:</strong> ${datos.urgente ? "⚠️ SÍ" : "No"}</p>`,
    }).catch(e => console.error("Email doctor:", e.message));
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────
function fmtDT(d) {
  const dias  = ["dom","lun","mar","mié","jue","vie","sáb"];
  const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${dias[d.getDay()]} ${d.getDate()} ${meses[d.getMonth()]} — ${hh}:${mm} hrs`;
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

const TRATAMIENTOS = [
  "Limpieza dental",
  "Revisión general / chequeo",
  "Ortodoncia (brackets o alineadores)",
  "Implante o prótesis dental",
  "Extracción dental",
  "Blanqueamiento dental",
  "Tratamiento de conducto (endodoncia)",
  "Otro / No sé aún",
];

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
Responde preguntas breves sobre tratamientos dentales (precios referenciales en CLP, preparación, cuidados, duración), horarios, ubicación y convenios.
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
      `Encontré tu cita 📋\n\n🦷 ${r[6]}\n📅 ${r[8]}\n⏰ ${r[9]}${r[17] ? `\n👨‍⚕️ ${r[17]}` : ""}\n\n¿Qué deseas hacer?`,
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

  // Detección de urgencia en cualquier momento del flujo
  if (!["inicio", "menu", "urgencia", "urgencia_nivel"].includes(s.paso) &&
      /dolor\s*intenso|emergencia|urgente|urgencia|sangra|fractura|accidente|me caí/i.test(t)) {
    s.d.urgente = true;
    s.paso = "urgencia";
  }

  switch (s.paso) {

    // ── Bienvenida ──────────────────────────────────────────────────────────
    case "inicio":
      s.paso = "menu";
      await btns(phone,
        `¡Hola! 👋 Bienvenido/a a *${CLINICA_NOMBRE}*.\nSoy tu asistente virtual. ¿En qué puedo ayudarte?\n\n_Si ya tienes una cita, escribe *4* o *reagendar* para gestionarla._`,
        [
          { id: "btn_agendar",  label: "📅 Agendar hora" },
          { id: "btn_urgencia", label: "🚨 Urgencia dental" },
          { id: "btn_info",     label: "ℹ️ Información" },
        ]
      );
      break;

    // ── Menú principal ──────────────────────────────────────────────────────
    case "menu": {
      const esAgendar  = t === "btn_agendar"  || t === "1" || t.includes("agendar") || t.includes("hora");
      const esUrgencia = t === "btn_urgencia" || t === "2" || t.includes("urgencia") || t.includes("dolor") || t.includes("emergencia");
      const esInfo     = t === "btn_info"     || t === "3" || t.includes("info")     || t.includes("precio") || t.includes("tratamiento");
      const esGestion  = t === "4" || t.includes("cancelar") || t.includes("reagendar") || t.includes("mi cita") || t.includes("cambiar mi");

      if (esGestion) {
        await iniciarGestionCita(phone, s);
      } else if (esUrgencia) {
        s.d.urgente = true;
        s.paso = "urgencia";
        await btns(phone,
          `🚨 *Urgencia dental*\n\n¿Qué tan intenso es el dolor o problema?\n\n_Si el dolor es muy severo, te recomendamos llamar directamente al ${CLINICA_TELEFONO || "nuestra clínica"}_`,
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
        await msg(phone, respAI ||
          `En *${CLINICA_NOMBRE}* ofrecemos:\n\n🦷 Limpieza y revisión general\n🦷 Ortodoncia\n🦷 Implantes y prótesis\n🦷 Blanqueamiento\n🦷 Endodoncia\n🦷 Extracciones\n\nPara agendar una hora, escribe *1*.`
        );
      } else {
        const respAI = await aiReply(text, s);
        if (respAI) {
          await msg(phone, respAI + "\n\n¿Deseas agendar una hora? Escribe *1*.");
        } else {
          await btns(phone, "Por favor selecciona una opción:",
            [
              { id: "btn_agendar",  label: "📅 Agendar hora" },
              { id: "btn_urgencia", label: "🚨 Urgencia dental" },
              { id: "btn_info",     label: "ℹ️ Información" },
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
      s.paso = "datos_rut";
      await msg(phone, `Gracias, *${s.d.nombre}* 😊\n\n*¿Cuál es tu RUT?* (ej: 12.345.678-9)\nEscribe *omitir* si prefieres no darlo.`);
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
      await msg(phone,
        `*¿Qué tipo de tratamiento necesitas?* 🦷\n\n${TRATAMIENTOS.map((tr, i) => `${i + 1}. ${tr}`).join("\n")}\n\nResponde con el *número* de tu opción.`
      );
      break;
    }

    // ── Selección de tratamiento ────────────────────────────────────────────
    case "tratamiento": {
      const num  = parseInt(t);
      let tratamiento = null;
      if (!isNaN(num) && num >= 1 && num <= TRATAMIENTOS.length) {
        tratamiento = TRATAMIENTOS[num - 1];
      } else {
        tratamiento = TRATAMIENTOS.find(tr => t.includes(tr.toLowerCase().split(" ")[0])) || null;
      }
      if (!tratamiento) {
        await msg(phone, `Por favor responde con un número del 1 al ${TRATAMIENTOS.length}:\n\n${TRATAMIENTOS.map((tr, i) => `${i + 1}. ${tr}`).join("\n")}`);
        break;
      }
      s.d.tratamiento = tratamiento;

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
        `Cita seleccionada 📋\n\n🦷 ${r[6]}\n📅 ${r[8]}\n⏰ ${r[9]}\n\n¿Qué deseas hacer?`,
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
      s.d.fechaCita = dt.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      s.d.horaCita  = dt.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
      s.paso = "confirmar_cita";
      await btns(phone,
        `📋 *Confirma tu cita*\n\n` +
        `👤 Nombre: ${s.d.nombre}\n` +
        `🦷 Tratamiento: ${s.d.tratamiento}\n` +
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
        s.paso = "agendado";
        await msg(phone, "Agendando tu cita... ⏳");
        await Promise.all([
          bookSlot(s.d.slotId, { ...s.d, phone }, calendarIdForDoctor(s.d.doctor)),
          logSheets({ ...s.d, phone, channel: s.channel || "twilio" }),
          sendConfirmation({ ...s.d, phone }),
        ]);
        notifySecretaria(
          `${s.d.reagendando ? "🔄 Cita reagendada" : "🦷 Nueva cita"}:\n` +
          `👤 ${s.d.nombre}\n📅 ${s.d.fechaCita} · ${s.d.horaCita}\n🦷 ${s.d.tratamiento}` +
          (s.d.doctor ? `\n👨‍⚕️ ${s.d.doctor}` : "") +
          (s.d.urgente ? "\n⚠️ URGENTE" : "") +
          `\n📱 ${phone}`
        );
        await msg(phone,
          `✅ *¡Cita ${s.d.reagendando ? "reagendada" : "agendada"} con éxito!* 🦷\n\n` +
          `📅 ${s.d.fechaCita}\n` +
          `⏰ ${s.d.horaCita}\n` +
          `🦷 ${s.d.tratamiento}` +
          (s.d.doctor ? `\n👨‍⚕️ ${s.d.doctor}` : "") +
          (s.d.email ? `\n📧 Confirmación enviada a ${s.d.email}` : "") +
          (LINK_PAGO ? `\n\n💳 Si deseas, puedes dejar un abono para asegurar tu hora:\n${LINK_PAGO}` : "") +
          `\n\n_Te enviaremos un recordatorio el día anterior. Recuerda llegar 10 minutos antes._\n\n¡Hasta pronto! 😊`
        );
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
        `Tu cita ya está agendada ✅🦷\n\n` +
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

// ─── Dashboard para secretaria y doctor ──────────────────────────────────────
app.get("/dashboard", async (req, res) => {
  if (req.query.token !== DASHBOARD_TOKEN) return res.sendStatus(403);

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
              const estado = r[10] || "Confirmada";
              const color  = estadoColor[estado] || "#718096";
              return `<tr>
                <td>${r[8] || "—"}</td>
                <td><strong>${r[9] || "—"}</strong></td>
                <td>${r[3] || "—"}</td>
                <td>${r[2] || "—"}</td>
                <td>${r[6] || "—"}</td>
                <td>${r[4] || "—"}</td>
                <td>${r[5] || "—"}</td>
                <td><span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${estado}</span></td>
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
    <h1>🦷 ${CLINICA_NOMBRE} — Panel de Citas</h1>
    <p>${new Date().toLocaleDateString("es-CL", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</p>
  </div>
  <div class="hdr-links">
    <a class="hdr-btn btn-cal" href="${calUrl}" target="_blank">📅 Abrir Calendario</a>
    <a class="hdr-btn btn-sheet" href="${sheetUrl}" target="_blank">📊 Abrir Planilla</a>
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
    <div class="stat"><div class="num" style="font-size:1rem;padding-top:8px;">${topTrat}</div><div class="lbl">Tratamiento top</div></div>
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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  ok:      true,
  clinica: CLINICA_NOMBRE,
  ts:      new Date().toISOString(),
  sesiones: Object.keys(sessions).length,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🦷 ${CLINICA_NOMBRE} WhatsApp Bot — puerto ${PORT}`);
  console.log(`   Webhook:   /webhook`);
  console.log(`   Dashboard: /dashboard?token=<DASHBOARD_TOKEN>`);
  console.log(`   Health:    /health`);
});
