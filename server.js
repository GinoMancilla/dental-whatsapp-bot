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
  await waPost(phone, { type: "text", text: { body: text } });
}

async function btns(phone, text, buttons) {
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

// ─── Google Calendar: slots disponibles ──────────────────────────────────────
// La secretaria crea eventos con título "DISPONIBLE" en el calendario del doctor.
// El bot lee esos eventos y los presenta al paciente como horarios disponibles.
// Al confirmar la cita, el bot renombra el evento con los datos del paciente.
async function getSlots() {
  if (!googleAuth || !GOOGLE_CALENDAR_ID) return getDemoSlots();
  try {
    const auth  = await googleAuth.getClient();
    const cal   = google.calendar({ version: "v3", auth });
    const now   = new Date();
    const limit = new Date(now);
    limit.setDate(limit.getDate() + 21);
    const r = await cal.events.list({
      calendarId:  GOOGLE_CALENDAR_ID,
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

async function bookSlot(eventId, datos) {
  if (!googleAuth || !GOOGLE_CALENDAR_ID || eventId.startsWith("demo-")) {
    console.log("📅 [Demo] Cita agendada:", datos.nombre, datos.fechaCita, datos.horaCita);
    return;
  }
  try {
    const auth = await googleAuth.getClient();
    const cal  = google.calendar({ version: "v3", auth });
    await cal.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
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
      range:           "Citas!A:L",
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
          "Pendiente confirmación",
          "",
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
  const from  = `${CLINICA_NOMBRE} <no-reply@${EMAIL_DOMAIN}>`;
  const detalle = `Tratamiento: ${datos.tratamiento}\nFecha: ${datos.fechaCita}\nHora: ${datos.horaCita}`;

  if (datos.email) {
    resendClient.emails.send({
      from,
      to:      datos.email,
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
      to:      DOCTOR_EMAIL,
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
Responde preguntas breves sobre tratamientos dentales: precios referenciales en pesos chilenos (CLP), preparación, cuidados post-tratamiento y duración aproximada.
Sé amable, profesional y muy conciso (máx 3 oraciones).
No confirmes citas aquí; para eso el paciente debe seguir el flujo del bot.`,
      messages: [{ role: "user", content: text }],
    });
    return r.content[0].text;
  } catch (e) {
    console.error("AI error:", e.message);
    return null;
  }
}

// ─── Máquina de estados ───────────────────────────────────────────────────────
async function handle(phone, text, s) {
  const t = text.toLowerCase().trim();

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
        `¡Hola! 👋 Bienvenido/a a *${CLINICA_NOMBRE}*.\nSoy tu asistente virtual. ¿En qué puedo ayudarte?`,
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

      if (esUrgencia) {
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
        await msg(phone,
          `⚠️ Para urgencias con dolor intenso, llama de inmediato:\n📞 *${CLINICA_TELEFONO || "Contactar clínica directamente"}*\n\nTambién puedo buscarte el primer horario disponible.`
        );
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
      await msg(phone, `Perfecto. Buscando horarios disponibles para *${tratamiento}*... ⏳`);

      const slots = await getSlots();
      if (!slots.length) {
        s.paso = "menu";
        await msg(phone,
          `Lo sentimos, no encontramos horarios disponibles en este momento 😔\n\nContáctanos directamente:\n📞 ${CLINICA_TELEFONO || "Llamar a la clínica"}\n📧 ${CLINICA_EMAIL || ""}`
        );
        break;
      }
      s.d.slots = slots;
      s.paso    = "seleccionar_hora";
      await msg(phone,
        `*Horarios disponibles:* 📅\n\n${slots.map((sl, i) => `${i + 1}. ${sl.label}`).join("\n")}\n\nResponde con el *número* del horario que prefieras.`
      );
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
          bookSlot(s.d.slotId, { ...s.d, phone }),
          logSheets({ ...s.d, phone }),
          sendConfirmation({ ...s.d, phone }),
        ]);
        await msg(phone,
          `✅ *¡Cita agendada con éxito!* 🦷\n\n` +
          `📅 ${s.d.fechaCita}\n` +
          `⏰ ${s.d.horaCita}\n` +
          `🦷 ${s.d.tratamiento}` +
          (s.d.email ? `\n📧 Confirmación enviada a ${s.d.email}` : "") +
          `\n\n_Recuerda llegar 10 minutos antes. Para cancelar o reagendar, llama al ${CLINICA_TELEFONO || "la clínica"}._\n\n¡Hasta pronto! 😊`
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
      const respAI = await aiReply(text, s);
      await msg(phone, respAI ||
        `Tu cita ya está agendada 🦷 Si necesitas algo más, llama al ${CLINICA_TELEFONO || "la clínica"}. ¡Hasta pronto!`
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

// ─── Dashboard para secretaria y doctor ──────────────────────────────────────
app.get("/dashboard", (req, res) => {
  if (req.query.token !== DASHBOARD_TOKEN) return res.sendStatus(403);

  const calUrl   = GOOGLE_CALENDAR_ID
    ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(GOOGLE_CALENDAR_ID)}`
    : "https://calendar.google.com";
  const sheetUrl = GOOGLE_SPREADSHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${GOOGLE_SPREADSHEET_ID}`
    : "https://sheets.google.com";
  const sesionesActivas = Object.keys(sessions).length;

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CLINICA_NOMBRE} — Panel de Citas</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f0f4f8; color: #2d3748; min-height: 100vh; }
  header { background: #1a365d; color: #fff; padding: 24px 32px; }
  header h1 { font-size: 1.5rem; font-weight: 700; }
  header p  { opacity: .75; margin-top: 4px; font-size: .9rem; }
  main { max-width: 800px; margin: 32px auto; padding: 0 20px; }
  .card { display: flex; align-items: flex-start; gap: 16px; background: #fff; border-radius: 12px;
          padding: 24px; margin-bottom: 16px; text-decoration: none; color: inherit;
          box-shadow: 0 2px 8px rgba(0,0,0,.08); border-left: 4px solid #3182ce;
          transition: transform .15s, box-shadow .15s; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,.12); }
  .card .icon { font-size: 2rem; flex-shrink: 0; }
  .card h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 4px; }
  .card p  { color: #718096; font-size: .88rem; }
  .stats { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: #fff; border-radius: 10px; padding: 16px 20px; flex: 1; min-width: 140px;
          box-shadow: 0 2px 6px rgba(0,0,0,.07); text-align: center; }
  .stat .num { font-size: 2rem; font-weight: 700; color: #3182ce; }
  .stat .lbl { font-size: .8rem; color: #a0aec0; margin-top: 2px; }
  footer { text-align: center; color: #a0aec0; font-size: .8rem; margin: 32px 0; }
</style>
</head>
<body>
<header>
  <h1>🦷 ${CLINICA_NOMBRE} — Panel de Citas</h1>
  <p>Acceso para secretaria y doctor · ${new Date().toLocaleDateString("es-CL", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</p>
</header>
<main>
  <div class="stats">
    <div class="stat"><div class="num">${sesionesActivas}</div><div class="lbl">Chats activos ahora</div></div>
    <div class="stat"><div class="num">🟢</div><div class="lbl">Bot en línea</div></div>
  </div>
  <a class="card" href="${calUrl}" target="_blank">
    <div class="icon">📅</div>
    <div>
      <h2>Google Calendar — Horarios y Citas</h2>
      <p>Ver y gestionar horarios disponibles (DISPONIBLE) y citas agendadas por el bot. Para agregar un horario, crea un evento con título <strong>DISPONIBLE</strong>.</p>
    </div>
  </a>
  <a class="card" href="${sheetUrl}" target="_blank">
    <div class="icon">📊</div>
    <div>
      <h2>Google Sheets — Registro de Pacientes</h2>
      <p>Historial completo de citas agendadas vía WhatsApp: nombre, RUT, tratamiento, fecha, estado y notas de seguimiento.</p>
    </div>
  </a>
</main>
<footer>Panel protegido — ${CLINICA_NOMBRE} WhatsApp Bot</footer>
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
