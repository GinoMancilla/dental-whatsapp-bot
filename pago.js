// ─── Mercado Pago (Checkout Pro) por clínica ────────────────────────────────
// Cada clínica conecta SU cuenta pegando su Access Token. El bot crea cobros con
// ese token → el dinero va directo a la clínica → MP avisa por webhook al aprobarse.
// No hay comisión ni cuenta de plataforma: es 100% de la clínica.
const axios = require("axios");

const API = "https://api.mercadopago.com";

// Crea una preferencia de pago y devuelve { id, link }. El link se manda al paciente.
async function crearPreferencia(accessToken, { titulo, monto, citaId, notificationUrl, expiraMin = 20 }) {
  const expira = new Date(Date.now() + expiraMin * 60000).toISOString();
  const body = {
    items: [{
      title: titulo.slice(0, 250),
      quantity: 1,
      unit_price: Math.round(monto),
      currency_id: "CLP",
    }],
    external_reference: citaId,           // vincula el pago con la cita
    notification_url: notificationUrl,    // MP nos avisa aquí (no requiere config en el panel MP)
    binary_mode: true,                    // solo approved/rejected, sin estados intermedios
    expires: true,
    expiration_date_to: expira,
    metadata: { citaId },
  };
  const r = await axios.post(`${API}/checkout/preferences`, body, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    timeout: 15000,
  });
  return { id: r.data.id, link: r.data.init_point };
}

// Consulta un pago por su ID. Devuelve { status, citaId, monto } o null.
// Consultar contra la cuenta de la clínica ES la verificación: un pago falso no existe ahí.
async function consultarPago(accessToken, paymentId) {
  try {
    const r = await axios.get(`${API}/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
    return {
      status: r.data.status,                       // approved | pending | rejected | ...
      citaId: r.data.external_reference || (r.data.metadata && r.data.metadata.cita_id) || "",
      monto:  r.data.transaction_amount || 0,
    };
  } catch (e) {
    console.error("consultarPago:", e.response?.status, e.message);
    return null;
  }
}

// Verifica que un Access Token sea válido (para el momento de conectar la cuenta)
async function validarToken(accessToken) {
  try {
    const r = await axios.get(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000,
    });
    return { ok: true, nombre: r.data.nickname || r.data.first_name || "", email: r.data.email || "" };
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

module.exports = { crearPreferencia, consultarPago, validarToken };
