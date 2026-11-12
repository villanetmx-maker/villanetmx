// clipService.js
// Cliente HTTP hacia la API de Checkout Redireccionado (Link de Pago) de Clip.
// Docs: https://developer.clip.mx/reference?page=cnp-lk-i
// Nunca recibe datos de tarjeta: el cliente paga en la pagina hospedada por Clip.
//
// Variables de entorno en Render:
//   CLIP_API_KEY  (API Key del Panel de Desarrollador de Clip)
//   CLIP_SECRET   (Clave Secreta)
//   CLIP_AUTH_TOKEN (opcional: si Clip te da el token ya armado, se usa este)

const axios = require('axios');

const CLIP_API_KEY = process.env.CLIP_API_KEY;
const CLIP_SECRET = process.env.CLIP_SECRET;

if (!process.env.CLIP_AUTH_TOKEN && (!CLIP_API_KEY || !CLIP_SECRET)) {
  console.warn('[clipService] Faltan CLIP_API_KEY / CLIP_SECRET en las variables de entorno.');
}

// Token de autenticacion: Base64 de "API_KEY:SECRET" (header Authorization: Basic ...)
const TOKEN =
  process.env.CLIP_AUTH_TOKEN ||
  Buffer.from(`${CLIP_API_KEY || ''}:${CLIP_SECRET || ''}`).toString('base64');

const client = axios.create({
  baseURL: 'https://api.payclip.com',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Basic ${TOKEN}`,
  },
  timeout: 15000,
});

function mensajeError(err) {
  const d = err.response && err.response.data;
  return (d && (d.message || d.error || JSON.stringify(d))) || err.message;
}

// Crea un link de pago. Regresa { payment_request_id, payment_request_url, status, ... }
async function crearCheckout({ monto, descripcion, referencia, urlExito, urlError, urlDefault, webhookUrl, minutosVigencia = 30 }) {
  const expira = new Date(Date.now() + minutosVigencia * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const { data } = await client.post('/v2/checkout', {
      amount: Number(monto),
      currency: 'MXN',
      purchase_description: descripcion,
      redirection_url: { success: urlExito, error: urlError, default: urlDefault },
      override_settings: { locale: 'es-MX', tip_enabled: false },
      metadata: { external_reference: referencia },
      custom_payment_options: {
        international_enabled: false,
        payment_method_types: ['debit', 'credit'],
      },
      expires_at: expira,
      webhook_url: webhookUrl,
    });
    return data;
  } catch (err) {
    throw new Error('Clip crearCheckout: ' + mensajeError(err));
  }
}

// Consulta el estado real de un link de pago (siempre se usa para confirmar,
// nunca se confia solo en el webhook o en la redireccion).
async function consultarCheckout(paymentRequestId) {
  try {
    const { data } = await client.get(`/v2/checkout/${encodeURIComponent(paymentRequestId)}`);
    return data;
  } catch (err) {
    throw new Error('Clip consultarCheckout: ' + mensajeError(err));
  }
}

module.exports = { crearCheckout, consultarCheckout };
