// Lee la misma Google Sheet "Registro Maestro de Clinicas" que clinic-manager
// mantiene (solo lectura desde aca), con cache en memoria. Resuelve que
// clinica corresponde a un mensaje entrante por su phone_number_id (Meta) o
// su numero "To" (Twilio).
//
// Usa una cuenta de servicio PROPIA y acotada (solo lectura de esa Sheet),
// distinta de la cuenta OAuth personal que usa clinic-manager -- evita que
// el bot dependa de un token de usuario.
const { google } = require("googleapis");

const TTL_MS = parseInt(process.env.CLINIC_CACHE_TTL_MS || "60000", 10);

let cache = { byPhoneNumberId: new Map(), byTwilioTo: new Map(), byId: new Map(), all: [], loadedAt: 0 };
let refreshing = null;

function sheetsClient() {
  const raw = process.env.REGISTRY_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Falta REGISTRY_SERVICE_ACCOUNT_JSON");
  const credentials = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

function parseJsonSafe(str, fallback) {
  try { return JSON.parse(str || ""); } catch { return fallback; }
}

// Columnas A-AC del Registro Maestro (ver clinic-manager/lib/registry.js).
// Indices 0-based dentro de la fila (A=0).
function rowToClinic(row) {
  return {
    clinicId: row[0] || "",
    nombre: row[1] || "",
    calendarId: row[6] || "",
    spreadsheetId: row[7] || "",
    dashboardToken: row[8] || "",
    canalWhatsApp: row[10] || "",
    mostrarPrecios: row[11] || "",
    bloqueMin: row[12] || "",
    autoDisponibilidad: row[13] || "",
    rubro: row[14] || "",
    numeroBot: row[15] || "",
    mpConectado: row[16] || "",
    panelUser: row[18] || "",
    razonSocial: row[19] || "",
    rutEmpresa: row[20] || "",
    doctores: parseJsonSafe(row[21], []),
    serviceAccountEmail: row[22] || "",
    metaPhoneNumberId: row[23] || "",
    metaToken: row[24] || "",
    metaAppSecret: row[25] || "",
    twilioTo: row[26] || "",
    serviceAccountJson: row[27] || "",
    extraConfig: parseJsonSafe(row[28], {}),
  };
}

// Arma el objeto de contexto que entra a tenantContext.runAsClinic(...).
// Acotado al camino de mensajeria de WhatsApp (ver nota en tenantContext.js
// sobre que queda deliberadamente afuera de esta fase: login del panel
// admin y rubro/vocabulario).
function toTenantContext(clinic) {
  const extra = clinic.extraConfig || {};
  return {
    clinicId: clinic.clinicId,
    serviceAccountJson: clinic.serviceAccountJson,
    CLINICA_NOMBRE: clinic.nombre,
    CLINICA_TELEFONO: extra.CLINICA_TELEFONO || "",
    CLINICA_EMAIL: extra.CLINICA_EMAIL || "",
    DOCTOR_EMAIL: extra.DOCTOR_EMAIL || "",
    GOOGLE_CALENDAR_ID: clinic.calendarId,
    GOOGLE_SPREADSHEET_ID: clinic.spreadsheetId,
    DOCTORES: clinic.doctores,
    WHATSAPP_TOKEN: clinic.metaToken,
    WHATSAPP_PHONE_ID: clinic.metaPhoneNumberId,
    WHATSAPP_APP_SECRET: clinic.metaAppSecret,
    SECRETARIA_PHONE: extra.SECRETARIA_PHONE || "",
    LINK_PAGO: extra.LINK_PAGO || "",
    GOOGLE_MAPS_URL: extra.GOOGLE_MAPS_URL || "",
    CLINICA_DIRECCION: extra.CLINICA_DIRECCION || "",
    CLINICA_HORARIO: extra.CLINICA_HORARIO || "Lunes a Viernes, 9:00 a 19:00 hrs",
    RECALL_MESES: parseInt(extra.RECALL_MESES || "6", 10),
    MP_ACCESS_TOKEN: extra.MP_ACCESS_TOKEN || "",
    AUTO_DISPONIBILIDAD: /^(1|true|si|sí)$/i.test(String(clinic.autoDisponibilidad || "")),
    PUBLIC_URL: extra.PUBLIC_URL || "",
  };
}

async function refresh() {
  const sheets = sheetsClient();
  const spreadsheetId = process.env.REGISTRY_SHEET_ID;
  if (!spreadsheetId) throw new Error("Falta REGISTRY_SHEET_ID");
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Clinicas!A2:AC" });
  const rows = (r.data.values || []).filter(row => row.length > 1);
  const next = { byPhoneNumberId: new Map(), byTwilioTo: new Map(), byId: new Map(), all: [], loadedAt: Date.now() };
  for (const row of rows) {
    const clinic = rowToClinic(row);
    if (!clinic.clinicId) continue;
    next.byId.set(clinic.clinicId, clinic);
    next.all.push(clinic);
    if (clinic.metaPhoneNumberId) next.byPhoneNumberId.set(clinic.metaPhoneNumberId, clinic);
    if (clinic.twilioTo) next.byTwilioTo.set(clinic.twilioTo, clinic);
  }
  cache = next;
}

// Un solo refresco en vuelo compartido entre llamadas concurrentes (evita
// una estampida de lecturas a Sheets si llegan varios mensajes justo cuando
// vence el TTL). Si el refresco falla, se sigue sirviendo el cache anterior
// en vez de tumbar el ruteo de mensajes por un problema transitorio.
async function ensureFresh() {
  if (Date.now() - cache.loadedAt < TTL_MS) return;
  if (!refreshing) {
    refreshing = refresh()
      .catch(e => { console.error("clinicRegistry: error refrescando:", e.message); })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
}

async function getClinicByPhoneNumberId(id) {
  await ensureFresh();
  return cache.byPhoneNumberId.get(id) || null;
}

async function getClinicByTwilioTo(to) {
  await ensureFresh();
  return cache.byTwilioTo.get(to) || null;
}

async function getClinicByDashboardToken(token) {
  await ensureFresh();
  return cache.all.find(c => c.dashboardToken === token) || null;
}

async function listAllClinics() {
  await ensureFresh();
  return cache.all;
}

async function forceRefresh() {
  await refresh();
}

module.exports = {
  getClinicByPhoneNumberId, getClinicByTwilioTo, getClinicByDashboardToken,
  listAllClinics, toTenantContext, forceRefresh,
};
