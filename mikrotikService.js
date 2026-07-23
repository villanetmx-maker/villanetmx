/**
 * mikrotikService.js
 * VillaNet MX - Servicio de Internet Residencial
 * Módulo para comunicarse con la API de MikroTik (RouterOS API, puerto 8728)
 * Requiere: npm install node-routeros --save
 */

const { RouterOSAPI } = require('node-routeros');

// Configuración de conexión al MikroTik
// Guardar estos valores como variables de entorno en Render:
// VILLANET_MIKROTIK_HOST, VILLANET_MIKROTIK_USER, VILLANET_MIKROTIK_PASSWORD
const conn = new RouterOSAPI({
  host: process.env.VILLANET_MIKROTIK_HOST,
  user: process.env.VILLANET_MIKROTIK_USER,
  password: process.env.VILLANET_MIKROTIK_PASSWORD,
  port: 8728,
});

async function conectar() {
  if (!conn.connected) {
    await conn.connect();
  }
  return conn;
}

/**
 * Crea un nuevo cliente (secret) en el MikroTik
 */
async function crearCliente({ nombre_secret, password, profile }) {
  const api = await conectar();
  await api.write('/ppp/secret/add', [
    `=name=${nombre_secret}`,
    `=password=${password}`,
    `=service=pppoe`,
    `=profile=${profile}`,
  ]);
  return { ok: true };
}

/**
 * Suspende el servicio de un cliente (falta de pago)
 */
async function suspenderCliente(nombre_secret) {
  const api = await conectar();
  const secrets = await api.write('/ppp/secret/print', [
    `?name=${nombre_secret}`,
  ]);
  if (secrets.length === 0) {
    throw new Error(`Cliente ${nombre_secret} no encontrado en MikroTik`);
  }
  const id = secrets[0]['.id'];
  await api.write('/ppp/secret/set', [
    `=.id=${id}`,
    `=disabled=yes`,
  ]);

  // Además, si el cliente tiene sesión activa, la cerramos de inmediato
  const activos = await api.write('/ppp/active/print', [
    `?name=${nombre_secret}`,
  ]);
  if (activos.length > 0) {
    await api.write('/ppp/active/remove', [
      `=.id=${activos[0]['.id']}`,
    ]);
  }

  return { ok: true, suspendido: nombre_secret };
}

/**
 * Reactiva el servicio de un cliente (pago confirmado)
 */
async function reactivarCliente(nombre_secret) {
  const api = await conectar();
  const secrets = await api.write('/ppp/secret/print', [
    `?name=${nombre_secret}`,
  ]);
  if (secrets.length === 0) {
    throw new Error(`Cliente ${nombre_secret} no encontrado en MikroTik`);
  }
  const id = secrets[0]['.id'];
  await api.write('/ppp/secret/set', [
    `=.id=${id}`,
    `=disabled=no`,
  ]);
  return { ok: true, reactivado: nombre_secret };
}

/**
 * Verifica si un cliente tiene sesión PPPoE activa ahora mismo
 * (Útil para el bot de WhatsApp / diagnóstico de fallas)
 */
async function estadoConexion(nombre_secret) {
  const api = await conectar();

  const secrets = await api.write('/ppp/secret/print', [
    `?name=${nombre_secret}`,
  ]);
  if (secrets.length === 0) {
    return { existe: false };
  }

  const disabled = secrets[0].disabled === 'true';

  const activos = await api.write('/ppp/active/print', [
    `?name=${nombre_secret}`,
  ]);

  return {
    existe: true,
    suspendido_por_falta_pago: disabled,
    conectado_ahora: activos.length > 0,
    ip_asignada: activos.length > 0 ? activos[0].address : null,
    uptime: activos.length > 0 ? activos[0].uptime : null,
  };
}

module.exports = {
  crearCliente,
  suspenderCliente,
  reactivarCliente,
  estadoConexion,
};
