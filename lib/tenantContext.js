// Contexto por clinica usando AsyncLocalStorage (ALS). Permite que las ~25
// variables de configuracion que antes eran const/let a nivel de modulo
// (una sola clinica por proceso) pasen a resolverse por request, sin tocar
// los 200+ sitios donde se usan por nombre suelto en server.js.
//
// Por que ALS y no mutar una variable compartida al llegar cada request:
// con mensajes de distintas clinicas entreverados (awaits de por medio),
// mutar un `let` compartido es una condicion de carrera real -- el mensaje
// de la clinica A podria terminar de procesarse con la config de la B si
// ambas llegan casi juntas. ALS amarra el contexto a toda la cadena async
// de un request (incluidos callbacks de setTimeout programados adentro),
// sin esa condicion de carrera.
const { AsyncLocalStorage } = require("async_hooks");
const als = new AsyncLocalStorage();

function currentClinic() {
  const store = als.getStore();
  if (!store) throw new Error("tenantContext: no hay clinica activa -- este codigo corrio fuera de runAsClinic()");
  return store;
}

function hasClinicContext() {
  return als.getStore() !== undefined;
}

function runAsClinic(ctx, fn) {
  return als.run(ctx, fn);
}

// Campos que antes se leian una vez de process.env al cargar el modulo y
// ahora se resuelven por clinica. Acotado al camino de mensajeria de
// WhatsApp (los dos webhooks + los jobs periodicos) -- deliberadamente
// AFUERA de esta fase: el login del panel de administracion (DASHBOARD_*,
// PANEL_USERS, PANEL_SOLO_LOGIN -- tiene su propio mapa de sesiones,
// panelSessions, que necesita su propio namespacing por clinica antes de
// convertir estos valores) y el rubro/vocabulario (RUBRO deriva un objeto
// completo + una regex compilada al cargar el modulo, no es un valor plano;
// convertirlo requiere el mismo tratamiento que R/URGENCIA_RE, no solo la
// variable RUBRO). RESEND_API_KEY / ANTHROPIC_API_KEY / TWILIO_* quedan
// compartidos (ya lo son hoy via SHARED_VARS de clinic-manager).
// VERIFY_TOKEN NO está acá: en el modelo Tech Provider (una sola app de Meta)
// el verify token del handshake GET /webhook es por APP, no por clínica --
// server.js lo lee directo de process.env.VERIFY_TOKEN.
const TENANT_FIELDS = [
  "CLINICA_NOMBRE", "CLINICA_TELEFONO", "CLINICA_EMAIL", "DOCTOR_EMAIL",
  "GOOGLE_CALENDAR_ID", "GOOGLE_SPREADSHEET_ID", "DOCTORES",
  "WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_APP_SECRET",
  "SECRETARIA_PHONE", "LINK_PAGO", "GOOGLE_MAPS_URL", "CLINICA_DIRECCION",
  "CLINICA_HORARIO", "RECALL_MESES", "MP_ACCESS_TOKEN", "AUTO_DISPONIBILIDAD", "PUBLIC_URL",
];

let installed = false;

function installGlobalAccessors() {
  if (installed) return; // evita redefinir si algo vuelve a llamar esto
  installed = true;
  for (const name of TENANT_FIELDS) {
    Object.defineProperty(global, name, {
      configurable: true,
      enumerable: true,
      get() { return currentClinic()[name]; },
    });
  }
  // googleAuth es un caso aparte: no es un valor plano del registro, es un
  // cliente construido a partir de la cuenta de servicio de la clinica.
  const googleClients = require("./googleClients");
  Object.defineProperty(global, "googleAuth", {
    configurable: true,
    enumerable: true,
    get() {
      const c = currentClinic();
      if (!c.serviceAccountJson) return null;
      return googleClients.getOrBuild(c.clinicId, c.serviceAccountJson).auth;
    },
  });
}

module.exports = {
  als, runAsClinic, currentClinic, hasClinicContext, installGlobalAccessors, TENANT_FIELDS,
};
