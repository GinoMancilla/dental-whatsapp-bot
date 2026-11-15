// Cachea un cliente de Google (GoogleAuth) por clinica, construido a partir
// de la cuenta de servicio PROPIA de esa clinica. Reemplaza el `googleAuth`
// unico que antes se armaba una sola vez al cargar el modulo (una sola
// clinica por proceso).
const { google } = require("googleapis");

const cache = new Map(); // clinicId -> { auth }

function getOrBuild(clinicId, serviceAccountJsonBase64) {
  if (cache.has(clinicId)) return cache.get(clinicId);
  const credentials = JSON.parse(Buffer.from(serviceAccountJsonBase64, "base64").toString("utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
  const entry = { auth };
  cache.set(clinicId, entry);
  return entry;
}

module.exports = { getOrBuild, cache };
