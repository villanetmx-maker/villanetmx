// openpayService.js
// Cliente HTTP hacia la API REST de Openpay (https://www.openpay.mx/docs/api/).
// Nunca recibe ni guarda numeros de tarjeta: solo tokens generados en el navegador
// con Openpay.js (ver tarjeta-villanet.html) y los IDs que Openpay regresa.

const axios = require('axios');

const OPENPAY_ID = process.env.OPENPAY_MERCHANT_ID;
const OPENPAY_PRIVATE_KEY = process.env.OPENPAY_PRIVATE_KEY;
// 'true' mientras se prueba en sandbox; cambiar a 'false' cuando la cuenta
// de Openpay este verificada y aprobada para produccion.
const OPENPAY_SANDBOX = (process.env.OPENPAY_SANDBOX || 'true').toLowerCase() !== 'false';

if (!OPENPAY_ID || !OPENPAY_PRIVATE_KEY) {
  console.warn(
    '[openpayService] Faltan OPENPAY_MERCHANT_ID / OPENPAY_PRIVATE_KEY en las variables de entorno.'
  );
}

const BASE_URL = OPENPAY_SANDBOX
  ? `https://sandbox-api.openpay.mx/v1/${OPENPAY_ID}`
  : `https://api.openpay.mx/v1/${OPENPAY_ID}`;

const client = axios.create({
  baseURL: BASE_URL,
  auth: { username: OPENPAY_PRIVATE_KEY, password: '' },
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

function mensajeError(err) {
  // Openpay regresa { error_code, description, category, request_id }
  return (err.response && err.response.data && err.response.data.description) || err.message;
}

// Crea un "customer" en Openpay para un cliente de VillaNet (una sola vez por cliente).
// Se usa tanto para el flujo de tarjeta guardada como para el de SPEI.
async function crearCliente({ nombre, apellido, email, telefono }) {
  try {
    const { data } = await client.post('/customers', {
      name: nombre || 'Cliente',
      last_name: apellido || 'VillaNet',
      email: email || `cliente-${Date.now()}@villanetmx.local`,
      phone_number: telefono || undefined,
    });
    return data; // { id, name, ... }
  } catch (err) {
    throw new Error('Openpay (crear cliente): ' + mensajeError(err));
  }
}

// Asocia una tarjeta tokenizada en el navegador (Openpay.js) al customer, para
// poder cobrarla despues sin que el cliente vuelva a teclear su tarjeta.
async function guardarTarjeta({ openpayCustomerId, tokenId, deviceSessionId }) {
  try {
    const { data } = await client.post(`/customers/${openpayCustomerId}/cards`, {
      token_id: tokenId,
      device_session_id: deviceSessionId,
    });
    return data; // { id (card_id), brand, card_number ("... 1234"), ... }
  } catch (err) {
    throw new Error('Openpay (guardar tarjeta): ' + mensajeError(err));
  }
}

// Cobra la tarjeta ya guardada de un cliente. order_id debe ser unico por
// mes/cliente (ej. "VN-004-2026-08") -- si por lo que sea el cron corre dos
// veces el mismo dia, Openpay regresa el cargo original en vez de duplicarlo.
async function cobrarTarjetaGuardada({ openpayCustomerId, openpayCardId, monto, descripcion, ordenId }) {
  try {
    const { data } = await client.post(`/customers/${openpayCustomerId}/charges`, {
      method: 'card',
      source_id: openpayCardId,
      amount: monto,
      currency: 'MXN',
      description: descripcion,
      order_id: ordenId,
    });
    return data; // { id, status: 'completed' | 'in_progress' | 'failed', ... }
  } catch (err) {
    throw new Error('Openpay (cobrar): ' + mensajeError(err));
  }
}

// Genera una ficha de deposito SPEI (CLABE + referencia) por el monto exacto
// de la mensualidad. El cliente transfiere manualmente -- no existe forma de
// "jalar" dinero de una cuenta bancaria mexicana por SPEI sin tarjeta -- pero
// en cuanto el deposito llega, Openpay lo confirma via webhook y el sistema
// lo registra solo (ver /webhook/openpay en index.js).
async function crearCargoSPEI({ openpayCustomerId, monto, descripcion, ordenId, fechaVencimiento }) {
  try {
    const body = {
      method: 'bank_account',
      amount: monto,
      currency: 'MXN',
      description: descripcion,
      order_id: ordenId,
    };
    if (fechaVencimiento) {
      body.due_date = fechaVencimiento; // ISO 8601, ej. "2026-08-05T23:59:59"
    }
    const { data } = await client.post(`/customers/${openpayCustomerId}/charges`, body);
    return data;
    // data.payment_method = { type: 'bank_account', bank: 'STP', clabe: '...', reference: '...' }
    // data.status = 'in_progress' hasta que llega el deposito, luego 'completed'
  } catch (err) {
    throw new Error('Openpay (crear cargo SPEI): ' + mensajeError(err));
  }
}

// Consulta un cargo directo con Openpay (para confirmar webhooks, que no
// traen firma -- nunca hay que confiar en el body del webhook a ciegas).
async function consultarCargo(chargeId) {
  try {
    const { data } = await client.get(`/charges/${chargeId}`);
    return data;
  } catch (err) {
    throw new Error('Openpay (consultar cargo): ' + mensajeError(err));
  }
}

async function eliminarTarjeta({ openpayCustomerId, openpayCardId }) {
  try {
    await client.delete(`/customers/${openpayCustomerId}/cards/${openpayCardId}`);
  } catch (err) {
    throw new Error('Openpay (eliminar tarjeta): ' + mensajeError(err));
  }
}

module.exports = {
  crearCliente,
  guardarTarjeta,
  cobrarTarjetaGuardada,
  crearCargoSPEI,
  consultarCargo,
  eliminarTarjeta,
};
