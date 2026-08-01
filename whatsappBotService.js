/**
 * whatsappBotService.js
 * VillaNet MX - Centro de atencion a clientes por WhatsApp
 *
 * Flujo cliente: se identifica por telefono (clientes_isp.telefono) o por
 * numero de cuenta si no coincide. Menu por numero (1-7), sin IA, para
 * maxima confiabilidad.
 *
 * Canal de administrador: si el mensaje entrante viene del numero definido
 * en NUMERO_SOPORTE, se interpreta como un comando de control en vez de
 * pasar por el flujo de cliente. Comandos disponibles:
 *   RESUELTO <id_ticket>        -> marca un reporte de falla como resuelto
 *   RESP <numero_cuenta> texto  -> responde a un cliente en modo "con_asesor"
 *   FIN <numero_cuenta>         -> termina la atencion personalizada
 *   AYUDA                       -> muestra esta lista de comandos
 */
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');

const WHATSAPP_TOKEN = process.env.VILLANET_WHATSAPP_TOKEN;
const NUMERO_SOPORTE = process.env.VILLANET_ADMIN_WHATSAPP_NUMBER || '5215546633899';
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

// ---------- Normalizar telefono para comparar contra la base ----------
function normalizarTelefono(telefono) {
  return (telefono || '').replace(/\D/g, '').slice(-10); // ultimos 10 digitos
}

// ---------- Saber si quien escribe es el administrador (VillaNet) ----------
function esAdmin(telefono) {
  return normalizarTelefono(telefono) === normalizarTelefono(NUMERO_SOPORTE);
}

// ---------- Buscar cliente por telefono ----------
async function buscarClientePorTelefono(telefono) {
  const ultimos10 = normalizarTelefono(telefono);
  const { data } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre, precio)')
    .neq('estado', 'baja');
  if (!data) return null;
  return data.find((c) => c.telefono && normalizarTelefono(c.telefono) === ultimos10) || null;
}

// ---------- Buscar cliente por numero de cuenta (VN-001, etc.) ----------
async function buscarClientePorCuenta(numeroCuenta) {
  const { data } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre, precio)')
    .eq('numero_cuenta', (numeroCuenta || '').toUpperCase().trim())
    .neq('estado', 'baja')
    .maybeSingle();
  return data;
}

// ---------- Obtener/crear sesion de conversacion ----------
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

// ---------- Menu principal ----------
function textoMenu(nombre) {
  return `Hola ${nombre} 👋, soy el asistente de VillaNet MX. ¿En qué te ayudo?
1️⃣ Estado de mi conexión
2️⃣ Reportar una falla
3️⃣ Estado de mis reportes pendientes
4️⃣ Mi saldo y estado de cuenta
5️⃣ Avisar que ya pagué
6️⃣ Mi próxima cita de servicio
7️⃣ Hablar con un asesor
Responde solo con el número (o escribe "menu" en cualquier momento para volver aquí).`;
}

// ---------- Calcular adeudo detallado (misma logica que el panel) ----------
async function calcularAdeudoDetallado(cliente) {
  const { data: pagos } = await supabase
    .from('pagos_isp')
    .select('mes_correspondiente')
    .eq('cliente_id', cliente.id);
  const mesesPagados = new Set((pagos || []).map((p) => p.mes_correspondiente.slice(0, 7)));
  const fechaAlta = new Date(cliente.fecha_alta);
  const cursor = new Date(fechaAlta.getFullYear(), fechaAlta.getMonth(), 1);
  const hoy = new Date();
  const finMesActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const precio = cliente.planes_isp ? parseFloat(cliente.planes_isp.precio) : 0;
  const mesesPendientes = [];
  while (cursor <= finMesActual) {
    const clave = cursor.toISOString().slice(0, 7);
    if (!mesesPagados.has(clave)) {
      mesesPendientes.push(clave);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  const total = mesesPendientes.length * precio;
  return { total, mesesPendientes, precio };
}

// ---------- Tickets de soporte abiertos de un cliente ----------
async function buscarTicketsAbiertos(clienteId) {
  const { data } = await supabase
    .from('reportes_falla_isp')
    .select('*')
    .eq('cliente_id', clienteId)
    .neq('estado', 'resuelto')
    .order('fecha_reporte', { ascending: false });
  return data || [];
}

// ---------- Proxima cita de servicio de un cliente ----------
async function buscarProximaOrden(clienteId) {
  const hoy = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('ordenes_servicio')
    .select('*')
    .eq('cliente_id', clienteId)
    .neq('estado', 'cancelada')
    .gte('fecha_cita', hoy)
    .order('fecha_cita', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

function formatearFecha(fechaISO) {
  return new Date(fechaISO + 'T00:00:00').toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

// ============================================================
// CANAL DE ADMINISTRADOR (comandos de control por WhatsApp)
// ============================================================
async function manejarComandoAdmin(texto) {
  const mensaje = (texto || '').trim();
  const partes = mensaje.split(/\s+/);
  const comando = (partes[0] || '').toUpperCase();

  if (comando === 'RESUELTO') {
    const idTicket = partes[1];
    if (!idTicket) {
      await enviarWhatsApp(NUMERO_SOPORTE, 'Uso: RESUELTO <id_ticket>');
      return;
    }
    const { data, error } = await supabase
      .from('reportes_falla_isp')
      .update({ estado: 'resuelto', fecha_resuelto: new Date().toISOString() })
      .eq('id', idTicket)
      .select()
      .maybeSingle();
    if (error || !data) {
      await enviarWhatsApp(NUMERO_SOPORTE, `No encontré el ticket #${idTicket}.`);
      return;
    }
    await enviarWhatsApp(NUMERO_SOPORTE, `✅ Ticket #${idTicket} marcado como resuelto.`);
    return;
  }

  if (comando === 'RESP') {
    const cuenta = partes[1];
    const textoRespuesta = partes.slice(2).join(' ');
    if (!cuenta || !textoRespuesta) {
      await enviarWhatsApp(NUMERO_SOPORTE, 'Uso: RESP <numero_cuenta> <mensaje>\nEj. RESP VN-001 Ya vamos en camino');
      return;
    }
    const cliente = await buscarClientePorCuenta(cuenta);
    if (!cliente || !cliente.telefono) {
      await enviarWhatsApp(NUMERO_SOPORTE, `No encontré un cliente con cuenta ${cuenta} y teléfono registrado.`);
      return;
    }
    await enviarWhatsApp(cliente.telefono, textoRespuesta);
    await guardarSesion(cliente.telefono, cliente.id, 'con_asesor');
    await enviarWhatsApp(NUMERO_SOPORTE, `↪️ Enviado a ${cliente.nombre} (${cliente.numero_cuenta}).`);
    return;
  }

  if (comando === 'FIN') {
    const cuenta = partes[1];
    if (!cuenta) {
      await enviarWhatsApp(NUMERO_SOPORTE, 'Uso: FIN <numero_cuenta>');
      return;
    }
    const cliente = await buscarClientePorCuenta(cuenta);
    if (!cliente || !cliente.telefono) {
      await enviarWhatsApp(NUMERO_SOPORTE, `No encontré un cliente con cuenta ${cuenta}.`);
      return;
    }
    await guardarSesion(cliente.telefono, cliente.id, 'menu');
    await enviarWhatsApp(cliente.telefono, 'Gracias por contactarnos 🙌. Si necesitas algo más, escribe "menu".');
    await enviarWhatsApp(NUMERO_SOPORTE, `🔚 Atención con ${cliente.nombre} (${cliente.numero_cuenta}) finalizada.`);
    return;
  }

  // AYUDA o cualquier otro texto sin reconocer
  await enviarWhatsApp(
    NUMERO_SOPORTE,
    `Comandos disponibles:\n` +
      `RESUELTO <id_ticket> — marca un reporte como resuelto\n` +
      `RESP <cuenta> <mensaje> — responde a un cliente (ej. RESP VN-001 Ya vamos)\n` +
      `FIN <cuenta> — termina la atención personalizada con ese cliente`
  );
}

// ============================================================
// MANEJADOR PRINCIPAL DE MENSAJES ENTRANTES
// ============================================================
async function manejarMensajeEntrante(telefonoOrigen, texto) {
  const mensaje = (texto || '').trim();

  // El administrador de VillaNet tiene su propio canal de comandos,
  // separado por completo del flujo de autoservicio de clientes.
  if (esAdmin(telefonoOrigen)) {
    await manejarComandoAdmin(mensaje);
    return;
  }

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

  // Si no tenemos cliente identificado todavia, intentar por telefono
  if (!cliente) {
    cliente = await buscarClientePorTelefono(telefonoOrigen);
  }

  // Si seguimos sin cliente, pedir numero de cuenta
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

  // Atajo global: escribir "menu" siempre regresa al menu principal,
  // sin importar en que paso de la conversacion estaba el cliente.
  if (mensaje.toLowerCase() === 'menu') {
    await guardarSesion(telefonoOrigen, cliente.id, 'menu');
    await enviarWhatsApp(telefonoOrigen, textoMenu(cliente.nombre));
    return;
  }

  const estadoActual = sesion ? sesion.estado : 'menu';

  // ---- Modo "con_asesor": el cliente esta siendo atendido en vivo por un
  // humano (via el canal RESP/FIN del administrador). El bot no interviene,
  // solo reenvia el mensaje al administrador para que lo lea y responda.
  if (estadoActual === 'con_asesor') {
    await enviarWhatsApp(
      NUMERO_SOPORTE,
      `💬 ${cliente.nombre} (${cliente.numero_cuenta}) escribió:\n"${mensaje}"\n\nPara responder: RESP ${cliente.numero_cuenta} tu mensaje`
    );
    return;
  }

  if (estadoActual === 'esperando_descripcion_falla') {
    // El mensaje actual es la descripcion del problema
    let diagnostico = 'no_verificable';
    try {
      const estadoConn = await mikrotik.estadoConexion(cliente.mikrotik_secret_name);
      if (estadoConn.suspendido_por_falta_pago) diagnostico = 'suspendido_por_falta_de_pago';
      else if (estadoConn.conectado_ahora) diagnostico = 'conectado_revisar_equipo_cliente';
      else diagnostico = 'sin_sesion_activa_posible_falla_fisica';
    } catch (e) {
      diagnostico = 'error_al_verificar';
    }

    const { data: ticket } = await supabase
      .from('reportes_falla_isp')
      .insert({
        cliente_id: cliente.id,
        descripcion: mensaje,
        diagnostico_automatico: diagnostico,
        estado: 'abierto',
      })
      .select()
      .single();

    await enviarWhatsApp(
      NUMERO_SOPORTE,
      `🔧 Nuevo reporte de falla — Ticket #${ticket ? ticket.id : '?'}\n` +
        `Cliente: ${cliente.nombre} (${cliente.numero_cuenta})\n` +
        `Tel: ${telefonoOrigen}\n` +
        `Descripción: ${mensaje}\n` +
        `Diagnóstico: ${diagnostico}\n\n` +
        `Cuando lo resuelvas: RESUELTO ${ticket ? ticket.id : ''}`
    );

    let respuesta = `✅ Recibimos tu reporte (folio #${ticket ? ticket.id : '?'}), en breve un técnico lo revisará.`;
    if (diagnostico === 'suspendido_por_falta_de_pago') {
      respuesta = '⚠️ Tu servicio está suspendido por falta de pago. Escribe "5" si ya realizaste tu pago para que lo verifiquemos.';
    }
    await enviarWhatsApp(telefonoOrigen, respuesta);
    await guardarSesion(telefonoOrigen, cliente.id, 'menu');
    return;
  }

  if (estadoActual === 'esperando_comprobante_pago') {
    // El cliente describio su pago (fecha/monto/referencia) - se registra
    // como ticket para verificacion manual
    await supabase.from('reportes_falla_isp').insert({
      cliente_id: cliente.id,
      descripcion: `[AVISO DE PAGO] ${mensaje}`,
      diagnostico_automatico: 'pago_reportado_por_cliente_pendiente_de_verificar',
      estado: 'abierto',
    });
    await enviarWhatsApp(
      NUMERO_SOPORTE,
      `💰 Aviso de pago recibido\nCliente: ${cliente.nombre} (${cliente.numero_cuenta})\nTel: ${telefonoOrigen}\nDetalle: ${mensaje}`
    );
    await enviarWhatsApp(
      telefonoOrigen,
      '✅ Gracias, registramos tu aviso de pago. Un administrador lo verificará y reactivará tu servicio si corresponde.'
    );
    await guardarSesion(telefonoOrigen, cliente.id, 'menu');
    return;
  }

  // ---- Estado 'menu' - interpretar la opcion elegida ----
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
      const tickets = await buscarTicketsAbiertos(cliente.id);
      let texto3;
      if (tickets.length === 0) {
        texto3 = '✅ No tienes reportes pendientes en este momento.';
      } else {
        texto3 = tickets
          .map((t) => {
            const fecha = new Date(t.fecha_reporte).toLocaleDateString('es-MX');
            const estadoTexto = t.estado === 'en_revision' ? 'en revisión' : t.estado;
            return `📋 Ticket #${t.id} (${fecha})\nEstado: ${estadoTexto}\n"${t.descripcion}"`;
          })
          .join('\n\n');
      }
      await enviarWhatsApp(telefonoOrigen, texto3 + '\n\nEscribe "menu" para volver a las opciones.');
      break;
    }

    case '4': {
      const { total, mesesPendientes, precio } = await calcularAdeudoDetallado(cliente);
      let texto4;
      if (total > 0) {
        const detalle = mesesPendientes
          .map((m) => `• ${m} — $${precio.toFixed(2)}`)
          .join('\n');
        texto4 = `Tienes ${mesesPendientes.length} mes(es) pendiente(s):\n${detalle}\n\nTotal a pagar: $${total.toFixed(2)} MXN`;
      } else {
        texto4 = '✅ Estás al corriente, sin saldo pendiente.';
      }
      await enviarWhatsApp(telefonoOrigen, texto4 + '\n\nEscribe "menu" para volver a las opciones.');
      break;
    }

    case '5':
      await enviarWhatsApp(telefonoOrigen, 'Cuéntame la fecha, monto y método con el que pagaste, para verificarlo.');
      await guardarSesion(telefonoOrigen, cliente.id, 'esperando_comprobante_pago');
      return;

    case '6': {
      const orden = await buscarProximaOrden(cliente.id);
      let texto6;
      if (!orden) {
        texto6 = 'No tienes ninguna cita de servicio programada.';
      } else {
        texto6 =
          `📅 Tu próxima cita:\n` +
          `Tipo: ${orden.tipo_servicio}\n` +
          `Fecha: ${formatearFecha(orden.fecha_cita)} a las ${orden.hora_cita}\n` +
          `Folio: ${orden.folio}` +
          (orden.tecnico ? `\nTécnico: ${orden.tecnico}` : '');
      }
      await enviarWhatsApp(telefonoOrigen, texto6 + '\n\nEscribe "menu" para volver a las opciones.');
      break;
    }

    case '7':
      await guardarSesion(telefonoOrigen, cliente.id, 'con_asesor');
      await enviarWhatsApp(
        telefonoOrigen,
        'Un asesor de VillaNet va a atenderte por aquí mismo en breve. Cuéntame en qué te podemos ayudar mientras tanto 🙌'
      );
      await enviarWhatsApp(
        NUMERO_SOPORTE,
        `🙋 ${cliente.nombre} (${cliente.numero_cuenta}) pidió hablar con un asesor.\n` +
          `Para responderle: RESP ${cliente.numero_cuenta} tu mensaje\n` +
          `Para terminar la atención: FIN ${cliente.numero_cuenta}`
      );
      return;

    default:
      await enviarWhatsApp(telefonoOrigen, textoMenu(cliente.nombre));
  }

  await guardarSesion(telefonoOrigen, cliente.id, 'menu');
}

module.exports = { manejarMensajeEntrante, enviarWhatsApp };
