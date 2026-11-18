/**
 * botPlusService.js
 * VillaNet MX - Funciones "de proveedor grande" para el bot de WhatsApp:
 *   - Menu con lista interactiva (botones de WhatsApp)
 *   - Estado de cuenta en PDF (nombre, direccion, plan, desglose de pagos)
 *   - Pagar la mensualidad desde el chat: link de Clip (tarjeta) o CLABE
 *     (transferencia). Con tarjeta se registra solo, manda recibo y reactiva.
 *   - Aviso general de falla a todos los clientes (y aviso de "ya quedo")
 *   - "Reiniciar mi conexion" (autoservicio)
 *   - Encuesta de satisfaccion al resolver un reporte
 *   - "¿Cuanto he usado?" consumo del mes
 *   - Programa de referidos
 *   - Cambio de plan desde el chat (lo aprueba el administrador)
 *   - Perfil de WhatsApp Business (descripcion, horario, sitio)
 *
 * Datos sensibles (CLABE, tokens) NUNCA van aqui: vienen de variables de
 * entorno en Render (VILLANET_CLABE, VILLANET_CLABE_BANCO, VILLANET_CLABE_TITULAR).
 */
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');
const clip = require('./clipService');
const { generarEstadoCuentaPdf } = require('./estadoCuentaPdf');

const WHATSAPP_TOKEN = process.env.VILLANET_WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.VILLANET_WHATSAPP_PHONE_NUMBER_ID;
const NUMERO_SOPORTE = process.env.VILLANET_ADMIN_WHATSAPP_NUMBER || '5215546633899';
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://villanet-backend-xoc2.onrender.com').replace(/\/$/, '');
const PREMIO_REFERIDO = process.env.VILLANET_PREMIO_REFERIDO || 'un mes de internet gratis';
const GRAPH = 'https://graph.facebook.com/v20.0';
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// ============================================================
// Envios de WhatsApp (interactivos, documentos, media)
// ============================================================
async function graph(path, body) {
  try {
    const r = await fetch(`${GRAPH}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) console.error(`[whatsapp+] ERROR ${path}:`, JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('[whatsapp+] EXCEPCION', e.message);
    return { error: { message: e.message } };
  }
}
const texto = (to, body) => graph(`${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to, type: 'text', text: { body } });
const corta = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

async function lista(to, cuerpo, boton, secciones, pie) {
  return graph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: cuerpo },
      ...(pie ? { footer: { text: corta(pie, 60) } } : {}),
      action: {
        button: corta(boton, 20),
        sections: secciones.map((s) => ({
          title: corta(s.titulo, 24),
          rows: s.filas.map((f) => ({ id: f.id, title: corta(f.titulo, 24), ...(f.desc ? { description: corta(f.desc, 72) } : {}) })),
        })),
      },
    },
  });
}

async function botones(to, cuerpo, opciones, pie) {
  return graph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: cuerpo },
      ...(pie ? { footer: { text: corta(pie, 60) } } : {}),
      action: { buttons: opciones.slice(0, 3).map((o) => ({ type: 'reply', reply: { id: o.id, title: corta(o.titulo, 20) } })) },
    },
  });
}

async function subirMedia(buffer, mime, nombre) {
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  fd.append('file', new Blob([buffer], { type: mime }), nombre);
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: fd,
  });
  const data = await r.json();
  if (!r.ok || !data.id) throw new Error('No se pudo subir el archivo a WhatsApp: ' + JSON.stringify(data));
  return data.id;
}

async function documento(to, buffer, nombre, caption) {
  const id = await subirMedia(buffer, 'application/pdf', nombre);
  return graph(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { id, filename: nombre, caption },
  });
}

// Reenvia al administrador una foto/archivo que mando un cliente (comprobante).
async function reenviarMediaAlAdmin(telefono, mediaId, tipo, etiqueta) {
  try {
    const info = await (await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } })).json();
    if (!info.url) throw new Error('sin url');
    const bin = Buffer.from(await (await fetch(info.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } })).arrayBuffer());
    const mime = info.mime_type || (tipo === 'image' ? 'image/jpeg' : 'application/pdf');
    const ext = (mime.split('/')[1] || 'bin').split(';')[0];
    const nuevoId = await subirMedia(bin, mime, `comprobante.${ext}`);
    const caption = `📎 ${etiqueta} (${telefono}) envió esto`;
    const cuerpo = tipo === 'image'
      ? { type: 'image', image: { id: nuevoId, caption } }
      : { type: 'document', document: { id: nuevoId, filename: `comprobante.${ext}`, caption } };
    await graph(`${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: NUMERO_SOPORTE, ...cuerpo });
  } catch (e) {
    await texto(NUMERO_SOPORTE, `📎 ${etiqueta} (${telefono}) envió una foto/archivo, pero no pude reenviártelo (${e.message}). Revísalo en el chat.`);
  }
}

// ============================================================
// Utilidades de clientes / pagos
// ============================================================
const tel10 = (t) => String(t || '').replace(/\D/g, '').slice(-10);
const primerNombre = (n) => String(n || '').trim().split(/\s+/)[0] || 'cliente';
const nombreMes = (clave) => { const [a, m] = clave.split('-').map(Number); return `${MESES[m - 1]} ${a}`; };
const dinero = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function hoyMx() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })); }
function claveMes(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

async function cargarCliente(id) {
  const { data } = await supabase.from('clientes_isp').select('*, planes_isp(*)').eq('id', id).maybeSingle();
  return data;
}

async function pagosDe(cliente) {
  const { data } = await supabase
    .from('pagos_isp')
    .select('*')
    .eq('cliente_id', cliente.id)
    .order('mes_correspondiente', { ascending: true });
  return data || [];
}

// Misma logica que el panel: desde el mes de alta hasta el mes actual.
async function adeudo(cliente) {
  const pagos = await pagosDe(cliente);
  const pagados = new Set(pagos.map((p) => String(p.mes_correspondiente).slice(0, 7)));
  const precio = cliente.planes_isp ? Number(cliente.planes_isp.precio) : 0;
  const alta = new Date(cliente.fecha_alta || new Date());
  const cursor = new Date(alta.getFullYear(), alta.getMonth(), 1);
  const fin = new Date(hoyMx().getFullYear(), hoyMx().getMonth(), 1);
  const pendientes = [];
  while (cursor <= fin) {
    const k = claveMes(cursor);
    if (!pagados.has(k)) pendientes.push(k);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return { pagos, pagados, precio, pendientes, total: pendientes.length * precio };
}

function siguienteMesNoPagado(pagados) {
  const d = hoyMx();
  const c = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  while (pagados.has(claveMes(c))) c.setMonth(c.getMonth() + 1);
  return claveMes(c);
}

function datosBanco() {
  if (!process.env.VILLANET_CLABE) return null;
  return {
    clabe: process.env.VILLANET_CLABE,
    banco: process.env.VILLANET_CLABE_BANCO || '',
    titular: process.env.VILLANET_CLABE_TITULAR || '',
  };
}

// Registra meses pagados, reactiva si estaba suspendido y manda recibo + PDF.
async function aplicarPago(cliente, meses, montoTotal, metodo, telefonoDestino, folio) {
  const porMes = Math.round((Number(montoTotal) / meses.length) * 100) / 100;
  for (const m of meses) {
    await supabase.from('pagos_isp').insert({ cliente_id: cliente.id, monto: porMes, mes_correspondiente: `${m}-01`, metodo });
  }
  let reactivado = false;
  if (cliente.estado === 'suspendido') {
    try {
      await mikrotik.reactivarCliente(cliente.mikrotik_secret_name);
      await supabase.from('clientes_isp').update({ estado: 'activo' }).eq('id', cliente.id);
      reactivado = true;
    } catch (e) {
      await texto(NUMERO_SOPORTE, `⚠️ ${cliente.numero_cuenta} pagó pero NO pude reactivarlo en el router (${e.message}). Reactívalo desde el panel.`);
    }
  }
  const to = telefonoDestino || '52' + tel10(cliente.telefono);
  await texto(
    to,
    `✅ *Pago recibido* — ¡Gracias, ${primerNombre(cliente.nombre)}!\n\n` +
      `Cuenta: ${cliente.numero_cuenta}\n` +
      `Concepto: Mensualidad ${meses.map(nombreMes).join(', ')}\n` +
      `Monto: ${dinero(montoTotal)} MXN\n` +
      `Método: ${metodo === 'clip_tarjeta' ? 'Tarjeta' : 'Transferencia'}` +
      (folio ? `\nFolio: ${folio}` : '') +
      (reactivado ? '\n\n🟢 Tu servicio ya fue reactivado. Si no navegas en 2 minutos, apaga y prende tu módem.' : '') +
      '\n\nTe mando tu estado de cuenta actualizado 👇'
  );
  await enviarEstadoCuenta(to, await cargarCliente(cliente.id), true);
  await texto(
    NUMERO_SOPORTE,
    `💰 Pago registrado: ${cliente.nombre} (${cliente.numero_cuenta}) ${dinero(montoTotal)} por ${meses.map(nombreMes).join(', ')} — ${metodo}` +
      (folio ? ` · folio ${folio}` : '') + (reactivado ? ' · REACTIVADO' : '')
  );
}

// ============================================================
// 1) Menu interactivo
// ============================================================
const ACCIONES_NUM = {
  1: 'estado', 2: 'falla', 3: 'reportes', 4: 'cuenta', 5: 'pagar',
  6: 'avise', 7: 'consumo', 8: 'reiniciar', 9: 'asesor', 10: 'mas',
};

function resolverAccion(msg) {
  const m = String(msg || '').trim();
  if (/^m_\w+$/.test(m)) return m.slice(2);
  const n = m.replace(/\D/g, '');
  if (n && n === m.replace(/[\s️⃣]/g, '') && ACCIONES_NUM[Number(n)]) return ACCIONES_NUM[Number(n)];
  const s = m.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/^(menu|hola|buen[oa]s|inicio|opciones)\b/.test(s)) return 'menu';
  if (/estado de cuenta|mi saldo|cuanto debo|adeudo/.test(s)) return 'cuenta';
  if (/^pagar\b|quiero pagar|pagar (mi )?(mensualidad|internet|servicio)|link de pago/.test(s)) return 'pagar';
  if (/cuanto (he )?(usado|consumido|gastado)|mi consumo|consumo/.test(s)) return 'consumo';
  if (/reinici|resetear|reconectar/.test(s)) return 'reiniciar';
  if (/recomend|referid|invitar/.test(s)) return 'referir';
  if (/cambi\w* (de |mi )?plan|mas velocidad|subir (de )?plan/.test(s)) return 'plan';
  if (/^(faq|preguntas)/.test(s)) return 'faq';
  if (/recarga|tiempo aire|saldo para|paquete/.test(s)) return 'recargas';
  if (/cita|visita/.test(s)) return 'cita';
  if (/asesor|humano|persona|agente/.test(s)) return 'asesor';
  return null;
}

async function enviarMenu(to, cliente) {
  const aviso = await avisoActivo();
  const cuerpo =
    `Hola ${primerNombre(cliente.nombre)} 👋, bienvenido a *VillaNet MX*.\n` +
    `Cuenta ${cliente.numero_cuenta} · Plan ${(cliente.planes_isp && cliente.planes_isp.nombre) || ''}` +
    (aviso ? `\n\n⚠️ *Aviso:* ${aviso.texto}` : '') +
    `\n\n¿En qué te ayudo hoy?`;
  const r = await lista(to, cuerpo, 'Ver opciones', [
    {
      titulo: 'Mi servicio',
      filas: [
        { id: 'm_estado', titulo: '📶 Estado de conexión', desc: 'Revisa si tu internet está en línea' },
        { id: 'm_falla', titulo: '🛠️ Reportar una falla', desc: 'Levanta un reporte con folio' },
        { id: 'm_reiniciar', titulo: '🔄 Reiniciar conexión', desc: 'Reconectamos tu servicio en 1 minuto' },
        { id: 'm_consumo', titulo: '📊 ¿Cuánto he usado?', desc: 'Tu consumo de datos de este mes' },
        { id: 'm_recargas', titulo: '📱 Recargas y servicios', desc: 'Tiempo aire, paquetes, CFE, Telmex y más' },
      ],
    },
    {
      titulo: 'Pagos',
      filas: [
        { id: 'm_cuenta', titulo: '🧾 Estado de cuenta', desc: 'Tu saldo y PDF con desglose de pagos' },
        { id: 'm_pagar', titulo: '💳 Pagar mensualidad', desc: 'Tarjeta al instante o transferencia' },
        { id: 'm_avise', titulo: '✅ Ya pagué', desc: 'Avísanos de tu transferencia o depósito' },
      ],
    },
    {
      titulo: 'Más',
      filas: [
        { id: 'm_asesor', titulo: '🙋 Hablar con asesor', desc: 'Te atiende una persona por aquí' },
        { id: 'm_mas', titulo: '➕ Más opciones', desc: 'Citas, cambio de plan, recomienda y gana' },
      ],
    },
  ], 'Escribe "menu" en cualquier momento');
  // Si el telefono no soporta listas, se manda el menu en texto.
  if (r && r.error) await texto(to, textoMenuPlano(cliente));
}

function textoMenuPlano(cliente) {
  return `Hola ${primerNombre(cliente.nombre)} 👋, soy el asistente de VillaNet MX. ¿En qué te ayudo?
1️⃣ Estado de mi conexión
2️⃣ Reportar una falla
3️⃣ Mis reportes
4️⃣ Estado de cuenta (PDF)
5️⃣ Pagar mi mensualidad
6️⃣ Ya pagué (avisar transferencia)
7️⃣ ¿Cuánto he usado?
8️⃣ Reiniciar mi conexión
9️⃣ Hablar con un asesor
🔟 Más opciones
📱 Para recargas de tiempo aire escribe *recarga*.
Responde con el número.`;
}

async function enviarMasOpciones(to) {
  await lista(to, 'Más opciones de VillaNet MX:', 'Ver más', [
    {
      titulo: 'Más opciones',
      filas: [
        { id: 'm_plan', titulo: '🚀 Cambiar de plan', desc: 'Más velocidad o un plan a tu medida' },
        { id: 'm_referir', titulo: '🎁 Recomienda y gana', desc: `Gana ${PREMIO_REFERIDO} por cada amigo` },
        { id: 'm_reportes', titulo: '📋 Mis reportes', desc: 'Seguimiento de tus folios' },
        { id: 'm_cita', titulo: '📅 Mi próxima cita', desc: 'Visitas técnicas programadas' },
        { id: 'm_faq', titulo: '❓ Preguntas frecuentes', desc: 'Pagos, cortes, soporte' },
        { id: 'm_menu', titulo: '⬅️ Menú principal' },
      ],
    },
  ]);
}

// ============================================================
// 7) Estado de cuenta (texto + PDF)
// ============================================================
async function enviarEstadoCuenta(to, cliente, soloPdf = false) {
  const a = await adeudo(cliente);
  if (!soloPdf) {
    const resumen = a.total > 0
      ? `🧾 *Saldo pendiente: ${dinero(a.total)} MXN*\n` + a.pendientes.map((m) => `• ${nombreMes(m)} — ${dinero(a.precio)}`).join('\n')
      : '🧾 ✅ Estás al corriente, sin saldo pendiente.';
    await texto(to, resumen + '\n\nTe mando tu estado de cuenta en PDF 👇');
  }
  // Ultimos 12 meses (o desde el alta)
  const pagosPorMes = {};
  for (const p of a.pagos) {
    const k = String(p.mes_correspondiente).slice(0, 7);
    if (!pagosPorMes[k]) pagosPorMes[k] = { ...p, monto: 0 };
    pagosPorMes[k].monto += Number(p.monto);
  }
  const hoy = hoyMx();
  const alta = new Date(cliente.fecha_alta || hoy);
  const desde = new Date(Math.max(new Date(alta.getFullYear(), alta.getMonth(), 1), new Date(hoy.getFullYear(), hoy.getMonth() - 11, 1)));
  const filas = [];
  const c = new Date(desde);
  const finTabla = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  // incluir meses adelantados ya pagados
  for (const k of Object.keys(pagosPorMes)) {
    const [y, m] = k.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    if (d > finTabla) finTabla.setTime(d.getTime());
  }
  while (c <= finTabla) {
    const k = claveMes(c);
    const p = pagosPorMes[k];
    filas.push({ mes: k, pagado: !!p, fecha: p && (p.fecha_pago || p.created_at), metodo: p && p.metodo, monto: p && p.monto });
    c.setMonth(c.getMonth() + 1);
  }
  filas.reverse();
  const pdf = await generarEstadoCuentaPdf({
    cliente,
    filas,
    mesesPendientes: a.pendientes,
    precio: a.precio,
    banco: datosBanco(),
  });
  const nombre = `EstadoCuenta_${cliente.numero_cuenta}_${claveMes(hoy)}.pdf`;
  try {
    await documento(to, pdf, nombre, `Estado de cuenta ${cliente.numero_cuenta}`);
  } catch (e) {
    console.error('[estado de cuenta]', e.message);
    await texto(to, 'No pude adjuntar el PDF en este momento 😕, inténtalo más tarde.');
  }
  if (!soloPdf && a.total > 0) {
    await botones(to, `¿Quieres pagar tus ${dinero(a.total)} ahora?`, [
      { id: 'm_pagar', titulo: '💳 Pagar ahora' },
      { id: 'm_menu', titulo: 'Menú' },
    ]);
  }
}

// ============================================================
// 2) Pagar la mensualidad desde el chat
// ============================================================
async function iniciarPago(to, cliente, adelantar = false) {
  const a = await adeudo(cliente);
  let meses = a.pendientes;
  if (!meses.length) {
    if (!adelantar) {
      await botones(to, '✅ Estás al corriente, no tienes saldo pendiente.\n¿Quieres adelantar el pago del próximo mes?', [
        { id: 'pago_adelantar', titulo: 'Adelantar 1 mes' },
        { id: 'm_menu', titulo: 'Menú' },
      ]);
      return;
    }
    meses = [siguienteMesNoPagado(a.pagados)];
  }
  const monto = meses.length * a.precio;
  if (!monto) { await texto(to, 'No encontré el precio de tu plan. Un asesor te ayudará en breve 🙌'); return; }

  let link = null;
  try {
    const { data: pago } = await supabase
      .from('pagos_clip_isp')
      .insert({ cliente_id: String(cliente.id), telefono: to, monto, meses })
      .select()
      .single();
    const datosCo = {
      monto,
      descripcion: `VillaNet ${cliente.numero_cuenta} mensualidad ${meses.map(nombreMes).join(', ')}`,
      referencia: `isp-${pago.id}`,
      urlExito: `${BASE_URL}/pago-mensualidad/${pago.id}`,
      urlError: `${BASE_URL}/pago-mensualidad/${pago.id}`,
      urlDefault: `${BASE_URL}/pago-mensualidad/${pago.id}`,
      webhookUrl: `${BASE_URL}/webhook/clip-mensualidad`,
      minutosVigencia: 24 * 60,
    };
    // Si Clip no acepta 24 h de vigencia, se reintenta con 1 hora.
    const co = await clip.crearCheckout(datosCo).catch(() => clip.crearCheckout({ ...datosCo, minutosVigencia: 60 }));
    link = co.payment_request_url;
    await supabase.from('pagos_clip_isp').update({ payment_request_id: co.payment_request_id, payment_url: link }).eq('id', pago.id);
  } catch (e) {
    console.error('[pagar mensualidad]', e.message);
  }

  const b = datosBanco();
  await texto(
    to,
    `💳 *Pago de mensualidad* — ${cliente.numero_cuenta}\n` +
      `Concepto: ${meses.map(nombreMes).join(', ')}\n` +
      `Total: *${dinero(monto)} MXN*\n\n` +
      (link
        ? `*Opción 1 · Tarjeta de débito o crédito* (se aplica al instante y recibes tu recibo aquí):\n${link}\n\n`
        : '') +
      (b
        ? `*Opción ${link ? 2 : 1} · Transferencia SPEI*\nBanco: ${b.banco}\nCLABE: ${b.clabe}\nA nombre de: ${b.titular}\nConcepto: ${cliente.numero_cuenta}\n` +
          'Después mándanos aquí la foto de tu comprobante 📸.'
        : link ? '' : 'Un asesor te enviará los datos de pago en un momento 🙌')
  );
  if (!link && !b) await texto(NUMERO_SOPORTE, `💳 ${cliente.numero_cuenta} quiere pagar ${dinero(monto)} pero no se pudo crear el link de Clip ni hay CLABE configurada.`);
}

async function confirmarPagoClip(pago) {
  if (!pago || pago.estado !== 'pendiente' || !pago.payment_request_id) return pago;
  const cr = await clip.consultarCheckout(pago.payment_request_id);
  if (cr.status === 'CHECKOUT_COMPLETED') {
    // Se marca primero (solo si sigue pendiente) para no registrar dos veces.
    const { data: tomado } = await supabase
      .from('pagos_clip_isp')
      .update({ estado: 'pagado', receipt_no: cr.receipt_no || null, pagado_at: new Date().toISOString() })
      .eq('id', pago.id)
      .eq('estado', 'pendiente')
      .select();
    if (!tomado || !tomado.length) return { ...pago, estado: 'pagado' };
    if (Number(cr.amount) !== Number(pago.monto)) {
      await supabase.from('pagos_clip_isp').update({ estado: 'revisar' }).eq('id', pago.id);
      await texto(NUMERO_SOPORTE, `⚠️ Pago Clip con monto distinto: esperado ${pago.monto}, cobrado ${cr.amount} (pago ${pago.id}). Revísalo.`);
      return { ...pago, estado: 'revisar' };
    }
    const cliente = await cargarCliente(pago.cliente_id);
    if (cliente) await aplicarPago(cliente, pago.meses, pago.monto, 'clip_tarjeta', pago.telefono, cr.receipt_no);
    return { ...pago, estado: 'pagado' };
  }
  if (cr.status === 'CHECKOUT_EXPIRED' || cr.status === 'CHECKOUT_CANCELLED') {
    await supabase.from('pagos_clip_isp').update({ estado: cr.status === 'CHECKOUT_EXPIRED' ? 'expirado' : 'cancelado' }).eq('id', pago.id);
  }
  return pago;
}

// PAGO <VN-005> [monto] [mes] -> el admin registra una transferencia/efectivo
async function registrarPagoManual(cuenta, monto, metodo = 'transferencia') {
  const { data: cliente } = await supabase.from('clientes_isp').select('*, planes_isp(*)').eq('numero_cuenta', cuenta.toUpperCase()).maybeSingle();
  if (!cliente) return `No encontré la cuenta ${cuenta}.`;
  const a = await adeudo(cliente);
  let meses = a.pendientes;
  const total = Number(monto) || 0;
  if (total && a.precio) {
    const n = Math.max(1, Math.round(total / a.precio));
    meses = a.pendientes.slice(0, n);
    while (meses.length < n) {
      const usados = new Set([...a.pagados, ...meses]);
      meses.push(siguienteMesNoPagado(usados));
    }
  }
  if (!meses.length) meses = [siguienteMesNoPagado(a.pagados)];
  const montoFinal = total || meses.length * a.precio;
  await aplicarPago(cliente, meses, montoFinal, metodo, null, null);
  return null;
}

// ============================================================
// 3) Aviso general de falla
// ============================================================
async function avisoActivo() {
  const { data } = await supabase.from('avisos_red').select('*').eq('activo', true).order('creado_at', { ascending: false }).limit(1).maybeSingle();
  return data;
}

async function difundir(textoMsg, plantilla) {
  const { data: clientes } = await supabase.from('clientes_isp').select('nombre, telefono, numero_cuenta').in('estado', ['activo', 'suspendido']);
  let ok = 0, plantillaOk = 0;
  const mal = [];
  const { enviarWhatsAppTemplate } = require('./whatsappBotService');
  for (const c of clientes || []) {
    const t = tel10(c.telefono);
    if (t.length !== 10) continue;
    const r = await texto('52' + t, `Hola ${primerNombre(c.nombre)} 👋\n${textoMsg}`);
    if (r && r.messages) { ok++; continue; }
    // Fuera de la ventana de 24h: se usa la plantilla aprobada
    const r2 = await enviarWhatsAppTemplate('52' + t, plantilla, [primerNombre(c.nombre), textoMsg.replace(/\n+/g, ' ')]);
    if (r2 && r2.messages) plantillaOk++;
    else mal.push(c.numero_cuenta);
  }
  return { ok, plantillaOk, mal, total: (clientes || []).length };
}

async function comandoAvisoFalla(textoAviso) {
  await supabase.from('avisos_red').update({ activo: false, cerrado_at: new Date().toISOString() }).eq('activo', true);
  await supabase.from('avisos_red').insert({ texto: textoAviso, activo: true });
  const r = await difundir(`⚠️ *Aviso de VillaNet:* ${textoAviso}\nYa estamos trabajando en ello, te avisamos en cuanto quede. Disculpa las molestias 🙏`,
    process.env.WHATSAPP_TEMPLATE_AVISO || 'aviso_servicio_villanet');
  return `📢 Aviso enviado: ${r.ok} directo + ${r.plantillaOk} por plantilla, de ${r.total}.` + (r.mal.length ? `\n⚠️ No llegó a: ${r.mal.join(', ')}` : '');
}

async function comandoAvisoListo(textoExtra) {
  await supabase.from('avisos_red').update({ activo: false, cerrado_at: new Date().toISOString() }).eq('activo', true);
  const r = await difundir(`✅ *VillaNet:* ${textoExtra || 'el servicio ya quedó restablecido.'} Si aún no navegas, apaga y prende tu módem. ¡Gracias por tu paciencia! 🙌`,
    process.env.WHATSAPP_TEMPLATE_AVISO || 'aviso_servicio_villanet');
  return `✅ Aviso de restablecido enviado: ${r.ok} directo + ${r.plantillaOk} por plantilla, de ${r.total}.` + (r.mal.length ? `\n⚠️ No llegó a: ${r.mal.join(', ')}` : '');
}

// ============================================================
// 4) Reiniciar mi conexion
// ============================================================
const ultimosReinicios = new Map();
async function reiniciarConexion(to, cliente) {
  if (cliente.estado !== 'activo') {
    await texto(to, '⚠️ Tu servicio está suspendido, por eso no puedo reiniciarlo. Elige "Pagar mensualidad" en el menú y se reactiva solo al pagar.');
    return;
  }
  const ult = ultimosReinicios.get(cliente.id) || 0;
  if (Date.now() - ult < 10 * 60 * 1000) {
    await texto(to, 'Ya reiniciamos tu conexión hace unos minutos. Si sigue fallando, elige "Reportar una falla" y un técnico lo revisa 🛠️');
    return;
  }
  ultimosReinicios.set(cliente.id, Date.now());
  await texto(to, '🔄 Reiniciando tu conexión… espera 1 minuto.');
  try {
    const url = process.env.VILLANET_PROXY_URL;
    const h = { 'Content-Type': 'application/json', 'x-proxy-token': process.env.VILLANET_PROXY_TOKEN };
    await fetch(`${url}/suspender/${cliente.mikrotik_secret_name}`, { method: 'POST', headers: h });
    await new Promise((r) => setTimeout(r, 3000));
    const r2 = await fetch(`${url}/reactivar/${cliente.mikrotik_secret_name}`, { method: 'POST', headers: h });
    if (!r2.ok) throw new Error('reactivar ' + r2.status);
    await new Promise((r) => setTimeout(r, 25000));
    const est = await mikrotik.estadoConexion(cliente.mikrotik_secret_name).catch(() => null);
    if (est && est.conectado_ahora) {
      await texto(to, '✅ Listo, tu conexión se reinició y ya está en línea. Si aún no navegas, apaga y prende tu módem.');
    } else {
      await botones(to, '🔴 Reiniciamos tu conexión pero tu módem todavía no se reconecta. Revisa que tenga luz y esté encendido. Si sigue igual, levanta un reporte:', [
        { id: 'm_falla', titulo: '🛠️ Reportar falla' },
        { id: 'm_menu', titulo: 'Menú' },
      ]);
    }
  } catch (e) {
    await texto(to, 'No pude reiniciar tu conexión en este momento 😕. Elige "Reportar una falla" y lo revisamos.');
    await texto(NUMERO_SOPORTE, `⚠️ Falló el reinicio de ${cliente.numero_cuenta}: ${e.message}. Revisa que el secret quedó ACTIVO.`);
  }
}

// ============================================================
// 5) Encuesta de satisfaccion al cerrar un reporte
// ============================================================
async function avisarReporteResuelto(ticket) {
  const cliente = await cargarCliente(ticket.cliente_id);
  if (!cliente || !cliente.telefono) return;
  const to = '52' + tel10(cliente.telefono);
  const r = await botones(
    to,
    `✅ Tu reporte *folio #${ticket.id}* quedó resuelto.\n\n¿Cómo calificas la atención que recibiste?`,
    [
      { id: `enc_${ticket.id}_5`, titulo: '😀 Excelente' },
      { id: `enc_${ticket.id}_3`, titulo: '🙂 Regular' },
      { id: `enc_${ticket.id}_1`, titulo: '😞 Mala' },
    ],
    'Tu opinión nos ayuda a mejorar'
  );
  return r && r.messages;
}

async function registrarCalificacion(to, cliente, id) {
  const [, ticketId, cal] = id.split('_');
  await supabase.from('reportes_falla_isp').update({ calificacion: Number(cal) }).eq('id', ticketId);
  await texto(to, Number(cal) >= 5 ? '¡Gracias! 🙌 Nos da gusto ayudarte.' : 'Gracias por decirnos 🙏. Un asesor revisará tu caso para mejorar.');
  if (Number(cal) < 5) await texto(NUMERO_SOPORTE, `📉 ${cliente.nombre} (${cliente.numero_cuenta}) calificó el folio #${ticketId} con ${cal}/5.`);
}

// ============================================================
// 6) ¿Cuanto he usado? (consumo del mes, del registro del hEX)
// ============================================================
async function consumoMes(to, cliente) {
  const secret = cliente.mikrotik_secret_name;
  const h = hoyMx();
  const inicio = new Date(Date.UTC(h.getFullYear(), h.getMonth(), 1, 6)).toISOString(); // 00:00 hora MX
  let bajada = 0, subida = 0, anterior = null;
  const porDia = {};
  for (let desde = 0; desde < 20000; desde += 1000) {
    const { data } = await supabase
      .from('consumo_muestras')
      .select('creada_at, datos')
      .gte('creada_at', inicio)
      .order('creada_at')
      .range(desde, desde + 999);
    if (!data || !data.length) break;
    for (const fila of data) {
      const m = new RegExp(`(?:^|,)${secret}:(\\d+):(\\d+)`).exec(fila.datos);
      const actual = m ? { rx: Number(m[1]), tx: Number(m[2]), t: new Date(fila.creada_at) } : null;
      if (actual && anterior && actual.t - anterior.t < 1200 * 1000) {
        const dTx = actual.tx - anterior.tx, dRx = actual.rx - anterior.rx;
        if (dTx >= 0 && dRx >= 0) {
          bajada += dTx; subida += dRx;
          const dia = new Date(actual.t.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
          porDia[dia] = (porDia[dia] || 0) + dTx;
        }
      }
      anterior = actual;
    }
    if (data.length < 1000) break;
  }
  const gb = (b) => (b / 1e9).toFixed(1);
  const dias = Object.keys(porDia).length;
  const topDia = Object.entries(porDia).sort((a, b) => b[1] - a[1])[0];
  await texto(
    to,
    `📊 *Tu consumo de ${MESES[h.getMonth()]}* (cuenta ${cliente.numero_cuenta})\n\n` +
      `⬇️ Descargado: *${gb(bajada)} GB*\n⬆️ Subido: ${gb(subida)} GB\n` +
      (dias ? `📅 Promedio diario: ${gb(bajada / dias)} GB\n` : '') +
      (topDia ? `🔝 Día de más uso: ${topDia[0].slice(8, 10)} de ${MESES[h.getMonth()]} (${gb(topDia[1])} GB)\n` : '') +
      `\nTu plan es *sin límite de datos* ♾️. Medición aproximada desde nuestro equipo.`
  );
}

// ============================================================
// Recargas de tiempo aire, paquetes y pago de servicios (Taecel)
// ============================================================
async function enviarRecargas(to) {
  const tel = tel10(to);
  await texto(
    to,
    `📱 *Recargas y pago de servicios VillaNet*\n` +
      `Tiempo aire y paquetes: Telcel, AT&T, Movistar, Bait, Unefon, Virgin y más.\n` +
      `Servicios: CFE, Telmex, Izzi, Totalplay, Sky, Netflix y más.\n\n` +
      `Paga con tarjeta y se aplica al momento 👇\n${BASE_URL}/recargas${tel.length === 10 ? `?tel=${tel}` : ''}\n\n` +
      `Tu número ya va puesto para la recarga; si es para otro número, solo cámbialo.`
  );
}

// ============================================================
// 8) Referidos
// ============================================================
async function referidos(to, cliente) {
  const numeroBot = (process.env.VILLANET_WHATSAPP_PUBLICO || '525668574395').replace(/\D/g, '');
  const enlace = `https://wa.me/${numeroBot}?text=${encodeURIComponent(`Hola, quiero contratar internet VillaNet. Me recomendó ${cliente.numero_cuenta}`)}`;
  await texto(
    to,
    `🎁 *Recomienda VillaNet y gana ${PREMIO_REFERIDO}*\n\n` +
      `Por cada vecino que contrate con tu código *${cliente.numero_cuenta}*, te damos ${PREMIO_REFERIDO} al instalarle.\n\n` +
      `Reenvíale el siguiente mensaje 👇`
  );
  await texto(to, `¡Hola! Yo tengo internet con VillaNet y funciona muy bien 📶. Si quieres contratar, escríbeles aquí con mi código ${cliente.numero_cuenta}:\n${enlace}`);
}

async function registrarProspecto(telefono, mensaje) {
  const m = /VN-\d{3,}/i.exec(mensaje);
  const referido = m ? m[0].toUpperCase() : null;
  await supabase.from('prospectos_isp').insert({ telefono, mensaje, referido_por: referido });
  await texto(
    telefono,
    '¡Hola! 👋 Gracias por tu interés en *VillaNet MX*, internet residencial sin límite de datos.\n\n' +
      'Un asesor te escribirá en breve para darte precios y revisar si tenemos cobertura en tu domicilio. ' +
      'Mientras tanto, ¿nos compartes tu nombre y tu dirección o ubicación? 📍'
  );
  await texto(NUMERO_SOPORTE, `🆕 Prospecto nuevo: ${telefono}${referido ? ` (recomendado por ${referido} 🎁)` : ''}\n"${mensaje}"`);
}

// ============================================================
// 9) Cambio de plan
// ============================================================
async function mostrarPlanes(to, cliente) {
  const { data: planes } = await supabase.from('planes_isp').select('*').order('precio');
  const otros = (planes || []).filter((p) => p.id !== cliente.plan_id && p.mikrotik_profile_name !== 'suspendido' && Number(p.precio) > 0);
  if (!otros.length) {
    await texto(to, `Tu plan actual es *${(cliente.planes_isp && cliente.planes_isp.nombre) || ''}*. Por ahora no hay otros planes disponibles; si necesitas algo a tu medida elige "Hablar con asesor" 🙌`);
    return;
  }
  await lista(
    to,
    `Tu plan actual: *${(cliente.planes_isp && cliente.planes_isp.nombre) || ''}* (${dinero(cliente.planes_isp && cliente.planes_isp.precio)}/mes).\nElige el plan que te interesa:`,
    'Ver planes',
    [{
      titulo: 'Planes VillaNet',
      filas: otros.slice(0, 9).map((p) => ({
        id: `plan_${p.id}`,
        titulo: p.nombre,
        desc: `${dinero(p.precio)}/mes` + (p.velocidad_bajada ? ` · ${p.velocidad_bajada} de bajada` : ''),
      })),
    }]
  );
}

async function solicitarPlan(to, cliente, planId) {
  const { data: plan } = await supabase.from('planes_isp').select('*').eq('id', planId).maybeSingle();
  if (!plan) { await texto(to, 'No encontré ese plan.'); return; }
  await texto(to, `✅ Recibimos tu solicitud de cambio al plan *${plan.nombre}* (${dinero(plan.precio)}/mes). Un asesor te confirma por aquí y se aplica en minutos 🚀`);
  await texto(NUMERO_SOPORTE, `🚀 ${cliente.nombre} (${cliente.numero_cuenta}) quiere cambiar al plan ${plan.nombre} (${dinero(plan.precio)}).\nPara aplicarlo responde:\nCAMBIOPLAN ${cliente.numero_cuenta} ${plan.id}`);
}

async function aplicarCambioPlan(cuenta, planId) {
  const { data: cliente } = await supabase.from('clientes_isp').select('*').eq('numero_cuenta', String(cuenta).toUpperCase()).maybeSingle();
  const { data: plan } = await supabase.from('planes_isp').select('*').eq('id', planId).maybeSingle();
  if (!cliente || !plan) return 'Uso: CAMBIOPLAN <cuenta> <id_plan> (no encontré la cuenta o el plan)';
  if (cliente.estado === 'activo' && plan.mikrotik_profile_name) {
    await mikrotik.cambiarPlan(cliente.mikrotik_secret_name, plan.mikrotik_profile_name);
  }
  await supabase.from('clientes_isp').update({ plan_id: plan.id }).eq('id', cliente.id);
  if (cliente.telefono) {
    await texto('52' + tel10(cliente.telefono), `🚀 ¡Listo! Tu plan cambió a *${plan.nombre}* (${dinero(plan.precio)}/mes). Si no notas el cambio, apaga y prende tu módem.`);
  }
  return `✅ ${cliente.numero_cuenta} ahora tiene el plan ${plan.nombre}.`;
}

// ============================================================
// 10) Perfil de WhatsApp Business
// ============================================================
async function configurarPerfil() {
  const r = await graph(`${PHONE_NUMBER_ID}/whatsapp_business_profile`, {
    messaging_product: 'whatsapp',
    about: 'Internet residencial en Morelos · Soporte 24/7 aquí',
    description:
      'VillaNet MX — Internet residencial sin límite de datos. Desde este WhatsApp puedes revisar tu conexión, reportar fallas, ' +
      'pagar tu mensualidad con tarjeta o transferencia, descargar tu estado de cuenta y comprar fichas WiFi. Escribe "menu" para empezar.',
    vertical: 'PROF_SERVICES',
    ...(process.env.VILLANET_DIRECCION ? { address: process.env.VILLANET_DIRECCION } : {}),
    websites: [`${BASE_URL}/hotspot/comprar`],
  });
  return r && r.success ? '✅ Perfil de WhatsApp Business actualizado (descripción, info y sitio). La foto de perfil se cambia desde WhatsApp Manager.' : `⚠️ No se pudo actualizar el perfil: ${(r && r.error && r.error.message) || 'error'}`;
}

// ============================================================
// Rutas HTTP (webhook de Clip y pagina de regreso)
// ============================================================
function registrarRutas(app) {
  app.post('/webhook/clip-mensualidad', async (req, res) => {
    try {
      const b = req.body || {};
      const prId = b.payment_request_id || b.id || (b.resource && (b.resource.payment_request_id || b.resource.id)) || (b.data && (b.data.payment_request_id || b.data.id));
      if (prId) {
        const { data: pago } = await supabase.from('pagos_clip_isp').select('*').eq('payment_request_id', prId).maybeSingle();
        if (pago) await confirmarPagoClip(pago);
      }
    } catch (e) {
      console.error('[webhook clip-mensualidad]', e.message);
    }
    res.sendStatus(200);
  });

  app.get('/pago-mensualidad/:id', async (req, res) => {
    let pago = null;
    if (/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      const { data } = await supabase.from('pagos_clip_isp').select('*').eq('id', req.params.id).maybeSingle();
      pago = data;
      try { pago = await confirmarPagoClip(pago); } catch (e) { console.error('[pago-mensualidad]', e.message); }
    }
    const ok = pago && pago.estado === 'pagado';
    res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VillaNet MX · Pago</title><style>body{font-family:system-ui,sans-serif;background:#0B3D91;margin:0;display:grid;place-items:center;min-height:100vh}
.c{background:#fff;border-radius:16px;padding:28px;max-width:360px;text-align:center}h1{font-size:22px;color:#0B3D91}p{color:#444}
a{display:inline-block;margin-top:12px;background:#25D366;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600}</style></head>
<body><div class="c"><h1>${ok ? '✅ ¡Pago recibido!' : pago ? '⏳ Estamos confirmando tu pago' : 'Pago no encontrado'}</h1>
<p>${ok ? 'Gracias. Te enviamos tu recibo y tu estado de cuenta por WhatsApp.' : pago ? 'En cuanto Clip lo confirme te llega el recibo por WhatsApp. Si ya pagaste no necesitas hacer nada más.' : ''}</p>
<a href="https://wa.me/${(process.env.VILLANET_WHATSAPP_PUBLICO || '525668574395').replace(/\D/g, '')}">Volver a WhatsApp</a></div></body></html>`);
  });

  // Respaldo: cada 5 min revisa links de pago pendientes de las ultimas 24 h.
  setInterval(async () => {
    try {
      const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data } = await supabase.from('pagos_clip_isp').select('*').eq('estado', 'pendiente').not('payment_request_id', 'is', null).gte('creado_at', desde).limit(20);
      for (const p of data || []) await confirmarPagoClip(p).catch((e) => console.error('[revisar pagos]', e.message));
    } catch (e) {
      console.error('[revisar pagos]', e.message);
    }
  }, 5 * 60 * 1000);
}

// ============================================================
// Usado por el PANEL
// ============================================================
// Numero de WhatsApp con el que el cliente realmente escribe (ultima sesion), o su telefono con 52.
async function telefonoChat(cliente) {
  const { data } = await supabase
    .from('whatsapp_sesiones')
    .select('telefono')
    .eq('cliente_id', cliente.id)
    .order('actualizado_en', { ascending: false })
    .limit(5);
  const real = (data || []).map((r) => String(r.telefono || '').replace(/\D/g, '')).find((t) => t.length >= 12);
  return real || '52' + tel10(cliente.telefono);
}

// Despues de registrar un pago desde el panel: recibo + estado de cuenta al cliente y aviso al admin.
async function notificarPagoPanel(clienteId, mes, monto, metodo, reactivado) {
  const cliente = await cargarCliente(clienteId);
  if (!cliente || !cliente.telefono) return { ok: false, motivo: 'sin teléfono' };
  const to = await telefonoChat(cliente);
  const metodos = { efectivo: 'Efectivo', transferencia: 'Transferencia', spei: 'Transferencia SPEI', tarjeta: 'Tarjeta', clip_tarjeta: 'Tarjeta' };
  const r = await texto(
    to,
    `✅ *Pago recibido* — ¡Gracias, ${primerNombre(cliente.nombre)}!\n\n` +
      `Cuenta: ${cliente.numero_cuenta}\nConcepto: Mensualidad ${nombreMes(String(mes).slice(0, 7))}\n` +
      `Monto: ${dinero(monto)} MXN\nMétodo: ${metodos[metodo] || metodo || '—'}` +
      (reactivado ? '\n\n🟢 Tu servicio ya fue reactivado. Si no navegas en 2 minutos, apaga y prende tu módem.' : '') +
      '\n\nTe mando tu estado de cuenta actualizado 👇'
  );
  if (!r || !r.messages) return { ok: false, motivo: 'WhatsApp no lo entregó (el cliente no ha escrito en 24 h)' };
  await enviarEstadoCuenta(to, cliente, true);
  return { ok: true };
}

async function enviarEstadoCuentaPanel(clienteId) {
  const cliente = await cargarCliente(clienteId);
  if (!cliente || !cliente.telefono) return { ok: false, motivo: 'sin teléfono' };
  const to = await telefonoChat(cliente);
  const r = await texto(to, `Hola ${primerNombre(cliente.nombre)} 👋, te compartimos tu estado de cuenta de VillaNet MX 👇`);
  if (!r || !r.messages) return { ok: false, motivo: 'WhatsApp no lo entregó (el cliente no ha escrito en 24 h)' };
  await enviarEstadoCuenta(to, cliente, true);
  return { ok: true };
}

async function pdfEstadoCuenta(clienteId) {
  const cliente = await cargarCliente(clienteId);
  if (!cliente) throw new Error('Cliente no encontrado');
  const a = await adeudo(cliente);
  const pagosPorMes = {};
  for (const p of a.pagos) {
    const k = String(p.mes_correspondiente).slice(0, 7);
    if (!pagosPorMes[k]) pagosPorMes[k] = { ...p, monto: 0 };
    pagosPorMes[k].monto += Number(p.monto);
  }
  const hoy = hoyMx();
  const alta = new Date(cliente.fecha_alta || hoy);
  const c = new Date(Math.max(new Date(alta.getFullYear(), alta.getMonth(), 1), new Date(hoy.getFullYear(), hoy.getMonth() - 11, 1)));
  const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  for (const k of Object.keys(pagosPorMes)) { const [y, m] = k.split('-').map(Number); const d = new Date(y, m - 1, 1); if (d > fin) fin.setTime(d.getTime()); }
  const filas = [];
  while (c <= fin) {
    const k = claveMes(c), p = pagosPorMes[k];
    filas.push({ mes: k, pagado: !!p, fecha: p && (p.fecha_pago || p.created_at), metodo: p && p.metodo, monto: p && p.monto });
    c.setMonth(c.getMonth() + 1);
  }
  filas.reverse();
  const buffer = await generarEstadoCuentaPdf({ cliente, filas, mesesPendientes: a.pendientes, precio: a.precio, banco: datosBanco() });
  return { buffer, nombre: `EstadoCuenta_${cliente.numero_cuenta}_${claveMes(hoy)}.pdf` };
}

module.exports = {
  telefonoChat,
  notificarPagoPanel,
  enviarEstadoCuentaPanel,
  pdfEstadoCuenta,
  registrarRutas,
  resolverAccion,
  enviarMenu,
  enviarMasOpciones,
  textoMenuPlano,
  enviarEstadoCuenta,
  iniciarPago,
  registrarPagoManual,
  avisoActivo,
  comandoAvisoFalla,
  comandoAvisoListo,
  reiniciarConexion,
  avisarReporteResuelto,
  registrarCalificacion,
  consumoMes,
  referidos,
  enviarRecargas,
  registrarProspecto,
  mostrarPlanes,
  solicitarPlan,
  aplicarCambioPlan,
  configurarPerfil,
  reenviarMediaAlAdmin,
  botones,
  datosBanco,
};
