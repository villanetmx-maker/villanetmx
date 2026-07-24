/**
 * mikrotikService.js
 * VillaNet MX - Servicio de Internet Residencial
 *
 * IMPORTANTE (actualizado tras incidente de seguridad, 24 jul 2026):
 * Este módulo YA NO habla directo con la API cruda del MikroTik (puerto
 * 8728), que quedó completamente cerrada a internet. En su lugar, habla
 * por HTTPS con un pequeño proxy autenticado que corre en el VPS de
 * Oracle (mikrotik-proxy-vps/index.js), el cual es el único que tiene
 * acceso real al MikroTik a través del túnel VPN.
 *
 * Variables de entorno necesarias en Render:
 *   VILLANET_PROXY_URL   (ej. http://159.54.143.38:8900)
 *   VILLANET_PROXY_TOKEN (debe coincidir con el configurado en el VPS)
 */

const PROXY_URL = process.env.VILLANET_PROXY_URL;
const PROXY_TOKEN = process.env.VILLANET_PROXY_TOKEN;

async function llamarProxy(path, options = {}) {
  const res = await fetch(`${PROXY_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-token': PROXY_TOKEN,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error del proxy (status ${res.status})`);
  }
  return data;
}

async function crearCliente({ nombre_secret, password, profile }) {
  return llamarProxy('/crear-cliente', {
    method: 'POST',
    body: JSON.stringify({ nombre_secret, password, profile }),
  });
}

async function suspenderCliente(nombre_secret) {
  return llamarProxy(`/suspender/${nombre_secret}`, { method: 'POST' });
}

async function reactivarCliente(nombre_secret) {
  return llamarProxy(`/reactivar/${nombre_secret}`, { method: 'POST' });
}

async function estadoConexion(nombre_secret) {
  return llamarProxy(`/estado/${nombre_secret}`, { method: 'GET' });
}

async function cambiarPlan(nombre_secret, nuevoProfile) {
  return llamarProxy(`/cambiar-plan/${nombre_secret}`, {
    method: 'POST',
    body: JSON.stringify({ profile: nuevoProfile }),
  });
}

async function actualizarVelocidadPerfil(nombreProfile, bajada, subida) {
  return llamarProxy(`/actualizar-velocidad/${nombreProfile}`, {
    method: 'POST',
    body: JSON.stringify({ bajada, subida }),
  });
}

async function eliminarCliente(nombre_secret) {
  return llamarProxy(`/cliente/${nombre_secret}`, { method: 'DELETE' });
}

module.exports = {
  crearCliente,
  suspenderCliente,
  reactivarCliente,
  estadoConexion,
  cambiarPlan,
  eliminarCliente,
  actualizarVelocidadPerfil,
};
