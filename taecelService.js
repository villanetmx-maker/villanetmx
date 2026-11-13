// taecelService.js
// Módulo de integración con la API de Taecel (Tiempo Aire y Pago de Servicios)
// Documentación oficial: https://app.taecel.com/api
//
// IMPORTANTE: este archivo NO lleva el key/nip escritos directamente.
// Se leen desde variables de entorno para no exponerlos en el código:
//   TAECEL_KEY
//   TAECEL_NIP
// En Render: Dashboard -> tu servicio (lapape-facturacion) -> Environment -> Add Environment Variable

const TAECEL_BASE_URL = 'https://app.taecel.com/api';

function getCredentials() {
  const key = process.env.TAECEL_KEY;
  const nip = process.env.TAECEL_NIP;
  if (!key || !nip) {
    throw new Error('Faltan las variables de entorno TAECEL_KEY o TAECEL_NIP en Render.');
  }
  return { key, nip };
}

async function taecelPost(endpoint, params = {}) {
  const { key, nip } = getCredentials();
  const body = new URLSearchParams({ key, nip, ...params });

  const response = await fetch(`${TAECEL_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  // Taecel siempre responde JSON, incluso en error
  const data = await response.json();
  return data;
}

// ---- Métodos de consulta ----

async function getBalance() {
  return taecelPost('getBalance');
}

async function getProducts() {
  return taecelPost('getProducts');
}

async function getSales(fecha, bolsa = 1) {
  // fecha en formato YYYY-MM-DD
  return taecelPost('getSales', { fecha, bolsa });
}

// ---- Métodos de transacción ----

async function requestTXN(producto, referencia, monto = null) {
  const params = { producto, referencia };
  if (monto !== null && monto !== undefined) {
    params.monto = monto; // sólo aplica a pago de servicios
  }
  return taecelPost('requestTXN', params);
}

async function statusTXN(transID) {
  return taecelPost('statusTXN', { transID });
}

async function progRequestTXN(producto, referencia, fecha) {
  // fecha en formato YYYY-MM-DD HH:MM:SS
  return taecelPost('ProgRequestTXN', { producto, referencia, fecha });
}

async function cancelProgRequestTXN(transID) {
  return taecelPost('CancelProgRequestTXN', { transID });
}

// ---- Flujo completo recomendado por Taecel ----
// 1) requestTXN -> obtiene transID
// 2) statusTXN cada 5 seg, hasta 60 seg, hasta tener success:true o data con status final
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function realizarTransaccionCompleta(producto, referencia, monto = null, opciones = {}) {
  const { maxEsperaSegundos = 60, intervaloSegundos = 5 } = opciones;

  const solicitud = await requestTXN(producto, referencia, monto);

  if (!solicitud.success) {
    return {
      exito: false,
      etapa: 'requestTXN',
      transID: null,
      respuesta: solicitud
    };
  }

  const transID = solicitud.data.transID;
  const inicio = Date.now();

  while ((Date.now() - inicio) / 1000 < maxEsperaSegundos) {
    await delay(intervaloSegundos * 1000);

    const status = await statusTXN(transID);

    // success:true -> transacción concluyó (exitosa o fracasada, pero con resultado final)
    if (status.success) {
      const esExitosa = status.data && status.data.Status &&
        status.data.Status.trim().toLowerCase() === 'exitosa';
      return {
        exito: esExitosa,
        etapa: 'statusTXN',
        transID,
        respuesta: status
      };
    }

    // success:false con data vacío -> seguir esperando (aún en proceso)
    // success:false con error distinto de "sin respuesta" -> falla definitiva
    if (status.data && Array.isArray(status.data) === false && Object.keys(status.data || {}).length > 0) {
      return {
        exito: false,
        etapa: 'statusTXN',
        transID,
        respuesta: status
      };
    }
    // si data es null/[] seguimos el ciclo de reintentos
  }

  return {
    exito: false,
    etapa: 'timeout',
    transID,
    respuesta: null
  };
}

// ---- Igual que realizarTransaccionCompleta, pero además arma el LOG técnico
// con el mismo formato que "ejemplo_logs" de Taecel (útil para enviar a Taecel
// como evidencia junto con la matriz de pruebas).
async function realizarTransaccionConLog(producto, referencia, monto = null, opciones = {}) {
  const { maxEsperaSegundos = 60, intervaloSegundos = 5 } = opciones;
  const { key, nip } = getCredentials();

  const log = { RequestTXN: null, StatusTXN: [] };

  const paramsReq = { key, nip, producto, referencia };
  if (monto !== null && monto !== undefined) paramsReq.monto = monto;

  const fechaReqReq = new Date().toISOString();
  const solicitud = await requestTXN(producto, referencia, monto);
  const fechaRespReq = new Date().toISOString();

  log.RequestTXN = {
    fecha_request: fechaReqReq,
    parametros: paramsReq,
    fecha_respuesta: fechaRespReq,
    respuesta: solicitud
  };

  if (!solicitud.success) {
    return { exito: false, etapa: 'requestTXN', transID: null, respuesta: solicitud, log };
  }

  const transID = solicitud.data.transID;
  const inicio = Date.now();
  let intento = 0;

  while ((Date.now() - inicio) / 1000 < maxEsperaSegundos) {
    await delay(intervaloSegundos * 1000);
    intento++;

    const fechaReqStatus = new Date().toISOString();
    let status = null;
    let errorTxt = null;
    try {
      status = await statusTXN(transID);
    } catch (e) {
      errorTxt = e.message;
    }
    const fechaRespStatus = new Date().toISOString();

    const entry = {
      intento,
      fecha_request: fechaReqStatus,
      parametros: { key, nip, transID },
      fecha_respuesta: fechaRespStatus
    };
    if (errorTxt) {
      entry.error = errorTxt;
    } else {
      entry.respuesta = status;
    }
    log.StatusTXN.push(entry);

    if (status && status.success) {
      const esExitosa = status.data && status.data.Status &&
        status.data.Status.trim().toLowerCase() === 'exitosa';
      return { exito: esExitosa, etapa: 'statusTXN', transID, respuesta: status, log };
    }
    if (status && status.data && Object.keys(status.data || {}).length > 0) {
      return { exito: false, etapa: 'statusTXN', transID, respuesta: status, log };
    }
  }

  return { exito: false, etapa: 'timeout', transID, respuesta: null, log };
}

module.exports = {
  getBalance,
  getProducts,
  getSales,
  requestTXN,
  statusTXN,
  progRequestTXN,
  cancelProgRequestTXN,
  realizarTransaccionCompleta,
  realizarTransaccionConLog
};
