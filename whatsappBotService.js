/**
 * whatsappBotService.js
 * VillaNet MX - Bot de WhatsApp para autoservicio de clientes
 *
 * Flujo: el cliente escribe, se identifica por su número de teléfono
 * (guardado en clientes_isp.telefono) o por su número de cuenta si no
 * coincide. Menú simple por número (1-4), sin IA, para máxima confiabilidad.
 */

const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');

const WHATSAPP_TOKEN = process.env.VILLANET_WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.VILLANET_WHATSAPP_PHONE_NUMBER_ID;

// ---------- Enviar mensaje de WhatsApp ----------
async function enviarWhatsApp(telefono, texto) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: texto },
    }),
  });
}

// ---------- Normalizar teléfono para comparar contra la base ----------
function normalizarTelefono(telefono) {
  return telefono.replace(/\D/g, '').slice(-10); // últimos 10 dígitos
}

// ---------- Buscar cliente por teléfono ----------
async function buscarClientePorTelefono(telefono) {
  const ultimos10 = normalizarTelefono(telefono);
  const { data } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre, precio)')
    .neq('estado', 'baja');

  if (!data) return null;
  return data.find((c) => c.telefono && normalizarTelefono(c.telefono) === ultimos10) || null;
}

// ---------- Buscar cliente por número de cuenta (VN-001, etc.) ----------
async function buscarClientePorCuenta(numeroCuenta) {
  const { data } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre, precio)')
    .eq('numero_cuenta', numeroCuenta.toUpperCase().trim())
    .neq('estado', 'baja')
    .maybeSingle();
  return data;
}

// ---------- Obtener/crear sesión de conversación ----------
async function obtenerSesion(telefono) {
  const { data } = await supabase
    .from('whatsapp_sesiones')
    .select('*')
    .eq('telefono', telefono)
    .maybeSingle();
  return data;
}

async function guardarSesion(telefono, cliente_id, estado) {
  await supabase
    .from('whatsapp_sesiones')
    .upsert({ telefono, cliente_id, estado, actualizado_en: new Date().toISOString() });
}

// ---------- Menú principal ----------
function textoMenu(nombre) {
  return `Hola ${nombre} 👋, soy el asistente de VillaNet MX. ¿En qué te ayudo?

1️⃣ Ver el estado de mi conexión
2️⃣ Reportar una falla
3️⃣ Consultar mi saldo
4️⃣ Avisar que ya pagué

Responde solo con el número.`;
}

// ---------- Calcular adeudo (misma lógica que el panel) ----------
async function calcularAdeudo(cliente) {
  const { data: pagos } = await supabase
    .from('pagos_isp')
    .select('mes_correspondiente')
    .eq('cliente_id', cliente.id);

  const mesesPagados = new Set((pagos || []).map((p) => p.mes_correspondiente.slice(0, 7)));
  const fechaAlta = new Date(cliente.fecha_alta);
  const cursor = new Date(fechaAlta.getFullYear(), fechaAlta.getMonth(), 1);
  const hoy = new Date();
  const finMesActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

  let total = 0;
  let mesesPendientes = 0;
  while (cursor <= finMesActual) {
    const clave = cursor.toISOString().slice(0, 7);
    if (!mesesPagados.has(clave)) {
      total += cliente.planes_isp ? parseFloat(cliente.planes_isp.precio) : 0;
      mesesPendientes++;
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return { total, mesesPendientes };
}

// ---------- Manejador principal de mensajes entrantes ----------
async function manejarMensajeEntrante(telefonoOrigen, texto) {
  const mensaje = (texto || '').trim();
  let sesion = await obtenerSesion(telefonoOrigen);
  let cliente = null;

  if (sesion && sesion.cliente_id) {
    const { data } = await supabase
      .from('clientes_isp')
      .select('*, planes_isp(nombre, precio)')
      .eq('id', sesion.cliente_id)
      .single();
    cliente = data;
  }

  // Si no tenemos cliente identificado todavía, intentar por teléfono
  if (!cliente) {
    cliente = await buscarClientePorTelefono(telefonoOrigen);
  }

  // Si seguimos sin cliente, pedir número de cuenta
  if (!cliente) {
    if (sesion && sesion.estado === 'esperando_cuenta') {
      const encontrado = await buscarClientePorCuenta(mensaje);
      if (encontrado) {
        await guardarSesion(telefonoOrigen, encontrado.id, 'menu');
        await enviarWhatsApp(telefonoOrigen, textoMenu(encontrado.nombre));
      } else {
        await enviarWhatsApp(
          telefonoOrigen,
          'No encontré ese número de cuenta. Verifica que sea correcto (ej. VN-001) e inténtalo de nuevo.'
        );
      }
      return;
    }
    await guardarSesion(telefonoOrigen, null, 'esperando_cuenta');
    await enviarWhatsApp(
      telefonoOrigen,
      'Hola 👋, soy el asistente de VillaNet MX. Para ayudarte, dime tu número de cuenta (ej. VN-001).'
    );
    return;
  }

  // Ya tenemos cliente identificado — manejar el flujo según el estado de la sesión
  const estadoActual = sesion ? sesion.estado : 'menu';

  if (estadoActual === 'esperando_descripcion_falla') {
    // El mensaje actual es la descripción del problema
    let diagnostico = 'no_verificable';
    try {
      const estadoConn = await mikrotik.estadoConexion(cliente.mikrotik_secret_name);
      if (estadoConn.suspendido_por_falta_pago) diagnostico = 'suspendido_por_falta_de_pago';
      else if (estadoConn.conectado_ahora) diagnostico = 'conectado_revisar_equipo_cliente';
      else diagnostico = 'sin_sesion_activa_posible_falla_fisica';
    } catch (e) {
      diagnostico = 'error_al_verificar';
    }

    await supabase.from('reportes_falla_isp').insert({
      cliente_id: cliente.id,
      descripcion: mensaje,
      diagnostico_automatico: diagnostico,
      estado: 'abierto',
    });

    let respuesta = '✅ Recibimos tu reporte, en breve un técnico lo revisará.';
    if (diagnostico === 'suspendido_por_falta_de_pago') {
      respuesta = '⚠️ Tu servicio está suspendido por falta de pago. Escribe "4" si ya realizaste tu pago para que lo verifiquemos.';
    }
    await enviarWhatsApp(telefonoOrigen, respuesta);
    await guardarSesion(telefonoOrigen, cliente.id, 'menu');
    return;
  }

  if (estadoActual === 'esperando_comprobante_pago') {
    // El cliente describió su pago (fecha/monto/referencia) - se registra como ticket para verificación manual
    await supabase.from('reportes_falla_isp').insert({
      cliente_id: cliente.id,
      descripcion: `[AVISO DE PAGO] ${mensaje}`,
      diagnostico_automatico: 'pago_reportado_por_cliente_pendiente_de_verificar',
      estado: 'abierto',
    });
    await enviarWhatsApp(
      telefonoOrigen,
      '✅ Gracias, registramos tu aviso de pago. Un administrador lo verificará y reactivará tu servicio si corresponde.'
    );
    await guardarSesion(telefonoOrigen, cliente.id, 'menu');
    return;
  }

  // Estado 'menu' - interpretar la opción elegida
  switch (mensaje) {
    case '1': {
      const estadoConn = await mikrotik.estadoConexion(cliente.mikrotik_secret_name).catch(() => null);
      let texto1;
      if (!estadoConn) {
        texto1 = 'No pude verificar tu conexión en este momento, intenta más tarde.';
      } else if (estadoConn.suspendido_por_falta_pago) {
        texto1 = '⚠️ Tu servicio está suspendido por falta de pago.';
      } else if (estadoConn.conectado_ahora) {
        texto1 = '✅ Tu servicio está activo y tu router está conectado ahora mismo.';
      } else {
        texto1 = '🔴 Tu cuenta está activa, pero no detectamos tu router conectado en este momento. Revisa que tenga corriente y esté encendido.';
      }
      await enviarWhatsApp(telefonoOrigen, texto1 + '\n\nEscribe "menu" para volver a las opciones.');
      break;
    }
    case '2':
      await enviarWhatsApp(telefonoOrigen, 'Cuéntame brevemente qué problema tienes (ej. "sin internet desde ayer").');
      await guardarSesion(telefonoOrigen, cliente.id, 'esperando_descripcion_falla');
      return;
    case '3': {
      const { total, mesesPendientes } = await calcularAdeudo(cliente);
      const texto3 = total > 0
        ? `Tienes ${mesesPendientes} mes(es) pendiente(s) por un total de $${total.toFixed(2)} MXN.`
        : '✅ Estás al corriente, sin saldo pendiente.';
      await enviarWhatsApp(telefonoOrigen, texto3 + '\n\nEscribe "menu" para volver a las opciones.');
      break;
    }
    case '4':
      await enviarWhatsApp(telefonoOrigen, 'Cuéntame la fecha, monto y método con el que pagaste, para verificarlo.');
      await guardarSesion(telefonoOrigen, cliente.id, 'esperando_comprobante_pago');
      return;
    default:
      await enviarWhatsApp(telefonoOrigen, textoMenu(cliente.nombre));
  }

  await guardarSesion(telefonoOrigen, cliente.id, 'menu');
}

module.exports = { manejarMensajeEntrante, enviarWhatsApp };
