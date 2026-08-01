const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');
const openpay = require('./openpayService');
require('./cronCorteISP');
require('./cronCobroISP');
app.get('/', (req, res) => {
  res.send('VillaNet MX backend activo');
});
app.get('/estado/:secretName', async (req, res) => {
  try {
    const estado = await mikrotik.estadoConexion(req.params.secretName);
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/planes', async (req, res) => {
  const { data, error } = await supabase
    .from('planes_isp')
    .select('*')
    .eq('activo', true)
    .order('precio', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.put('/api/planes/:id', async (req, res) => {
  const { precio, velocidad_bajada, velocidad_subida } = req.body;
  try {
    const { data: planActual, error: fetchError } = await supabase
      .from('planes_isp')
      .select('mikrotik_profile_name, velocidad_bajada, velocidad_subida')
      .eq('id', req.params.id)
      .single();
    if (fetchError) throw new Error('Plan no encontrado');
    // Si cambio la velocidad, sincronizar el rate-limit real en MikroTik
    // (esto afecta a todos los clientes que usan este profile)
    if (
      velocidad_bajada !== planActual.velocidad_bajada ||
      velocidad_subida !== planActual.velocidad_subida
    ) {
      await mikrotik.actualizarVelocidadPerfil(
        planActual.mikrotik_profile_name,
        velocidad_bajada,
        velocidad_subida
      );
    }
    const { data, error } = await supabase
      .from('planes_isp')
      .update({ precio, velocidad_bajada, velocidad_subida })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, plan: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/clientes', async (req, res) => {
  const { data, error } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre, precio, velocidad_bajada, velocidad_subida)')
    .order('numero_cuenta', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.get('/api/clientes/:id', async (req, res) => {
  const { data: cliente, error } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre, precio, velocidad_bajada, velocidad_subida)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { data: pagos } = await supabase
    .from('pagos_isp')
    .select('*')
    .eq('cliente_id', req.params.id)
    .order('fecha_pago', { ascending: false });
  // ---- Calcular adeudos: meses desde el alta hasta hoy sin pago registrado ----
  const mesesPagados = new Set(
    (pagos || []).map((p) => p.mes_correspondiente.slice(0, 7)) // 'YYYY-MM'
  );
  const adeudos = [];
  const fechaAlta = new Date(cliente.fecha_alta);
  const cursor = new Date(fechaAlta.getFullYear(), fechaAlta.getMonth(), 1);
  const hoy = new Date();
  const finMesActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  while (cursor <= finMesActual) {
    const clave = cursor.toISOString().slice(0, 7);
    if (!mesesPagados.has(clave)) {
      adeudos.push({
        mes: clave,
        monto: cliente.planes_isp ? cliente.planes_isp.precio : 0,
      });
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  const totalAdeudo = adeudos.reduce((sum, a) => sum + parseFloat(a.monto || 0), 0);
  res.json({ cliente, pagos: pagos || [], adeudos, total_adeudo: totalAdeudo });
});
app.post('/api/clientes', async (req, res) => {
  const { nombre, telefono, direccion, plan_id, dia_corte, password, metodo_cobro } = req.body;
  if (!nombre || !plan_id || !password) {
    return res.status(400).json({ error: 'nombre, plan_id y password son requeridos' });
  }
  try {
    const { data: plan, error: planError } = await supabase
      .from('planes_isp')
      .select('*')
      .eq('id', plan_id)
      .single();
    if (planError) throw new Error('Plan no encontrado');
    const { data: existentes } = await supabase
      .from('clientes_isp')
      .select('mikrotik_secret_name, numero_cuenta')
      .order('id', { ascending: false })
      .limit(1);
    let siguienteNum = 1;
    if (existentes && existentes.length > 0) {
      const ultimo = existentes[0].mikrotik_secret_name.replace('cliente', '');
      siguienteNum = parseInt(ultimo, 10) + 1;
    }
    const secretName = 'cliente' + String(siguienteNum).padStart(3, '0');
    const numeroCuenta = 'VN-' + String(siguienteNum).padStart(3, '0');
    await mikrotik.crearCliente({
      nombre_secret: secretName,
      password,
      profile: plan.mikrotik_profile_name,
    });
    const { data: nuevo, error: insertError } = await supabase
      .from('clientes_isp')
      .insert({
        nombre,
        telefono,
        direccion,
        plan_id,
        mikrotik_secret_name: secretName,
        mikrotik_password: password,
        numero_cuenta: numeroCuenta,
        dia_corte: dia_corte || 30,
        estado: 'activo',
        metodo_cobro: metodo_cobro || 'manual',
      })
      .select()
      .single();
    if (insertError) throw new Error(insertError.message);
    res.json({ ok: true, cliente: nuevo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/clientes/:id', async (req, res) => {
  const { nombre, telefono, direccion, plan_id, dia_corte } = req.body;
  try {
    const { data: clienteActual, error: fetchError } = await supabase
      .from('clientes_isp')
      .select('*, planes_isp(mikrotik_profile_name)')
      .eq('id', req.params.id)
      .single();
    if (fetchError) throw new Error('Cliente no encontrado');
    if (plan_id && plan_id !== clienteActual.plan_id) {
      const { data: nuevoPlan, error: planError } = await supabase
        .from('planes_isp')
        .select('mikrotik_profile_name')
        .eq('id', plan_id)
        .single();
      if (planError) throw new Error('Plan nuevo no encontrado');
      await mikrotik.cambiarPlan(clienteActual.mikrotik_secret_name, nuevoPlan.mikrotik_profile_name);
    }
    const { data: actualizado, error: updateError } = await supabase
      .from('clientes_isp')
      .update({ nombre, telefono, direccion, plan_id, dia_corte })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw new Error(updateError.message);
    res.json({ ok: true, cliente: actualizado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/clientes/:id/suspender', async (req, res) => {
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('mikrotik_secret_name')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    await mikrotik.suspenderCliente(cliente.mikrotik_secret_name);
    await supabase.from('clientes_isp').update({ estado: 'suspendido' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/clientes/:id/reactivar', async (req, res) => {
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('mikrotik_secret_name')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    await mikrotik.reactivarCliente(cliente.mikrotik_secret_name);
    await supabase.from('clientes_isp').update({ estado: 'activo' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/clientes/:id/baja', async (req, res) => {
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('mikrotik_secret_name')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    await mikrotik.suspenderCliente(cliente.mikrotik_secret_name);
    await supabase.from('clientes_isp').update({ estado: 'baja' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/pagos', async (req, res) => {
  const { cliente_id, monto, mes_correspondiente, metodo } = req.body;
  if (!cliente_id || !monto || !mes_correspondiente) {
    return res.status(400).json({ error: 'cliente_id, monto y mes_correspondiente son requeridos' });
  }
  try {
    const { data: pago, error: insertError } = await supabase
      .from('pagos_isp')
      .insert({ cliente_id, monto, mes_correspondiente, metodo })
      .select()
      .single();
    if (insertError) throw new Error(insertError.message);
    const { data: cliente } = await supabase
      .from('clientes_isp')
      .select('mikrotik_secret_name, estado')
      .eq('id', cliente_id)
      .single();
    if (cliente && cliente.estado === 'suspendido') {
      await mikrotik.reactivarCliente(cliente.mikrotik_secret_name);
      await supabase.from('clientes_isp').update({ estado: 'activo' }).eq('id', cliente_id);
    }
    res.json({ ok: true, pago });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ---------- Cobro automatico con Openpay: tarjeta guardada y SPEI ----------
// Cambia el metodo de cobro de un cliente. Para 'spei' es suficiente con esto
// (se crea el customer de Openpay si hace falta y el cron empieza a generar
// fichas de deposito). Para 'tarjeta' este endpoint solo prepara el terreno;
// la activacion real ocurre cuando el cliente tokeniza su tarjeta en
// tarjeta-villanet.html y llega a POST /api/clientes/:id/tarjeta.
app.post('/api/clientes/:id/metodo-cobro', async (req, res) => {
  const { metodo } = req.body; // 'tarjeta' | 'spei' | 'manual'
  if (!['tarjeta', 'spei', 'manual'].includes(metodo)) {
    return res.status(400).json({ error: "metodo debe ser 'tarjeta', 'spei' o 'manual'" });
  }
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    let openpayCustomerId = cliente.openpay_customer_id;
    if (metodo !== 'manual' && !openpayCustomerId) {
      const partesNombre = (cliente.nombre || 'Cliente VillaNet').trim().split(' ');
      const openpayCliente = await openpay.crearCliente({
        nombre: partesNombre[0],
        apellido: partesNombre.slice(1).join(' ') || 'VillaNet',
        telefono: cliente.telefono,
      });
      openpayCustomerId = openpayCliente.id;
    }
    const actualizacion = {
      metodo_cobro: metodo,
      cobro_automatico: metodo !== 'manual',
    };
    if (openpayCustomerId) actualizacion.openpay_customer_id = openpayCustomerId;
    if (metodo === 'manual') actualizacion.ultimo_error_cobro = null;
    const { data: actualizado, error: updateError } = await supabase
      .from('clientes_isp')
      .update(actualizacion)
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw new Error(updateError.message);
    res.json({ ok: true, cliente: actualizado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Guarda o reemplaza la tarjeta de un cliente para activar el cobro automatico.
// El body trae token_id y device_session_id generados en el navegador con
// Openpay.js (ver tarjeta-villanet.html) -- el numero de tarjeta NUNCA llega
// a este backend.
app.post('/api/clientes/:id/tarjeta', async (req, res) => {
  const { token_id, device_session_id, email } = req.body;
  if (!token_id || !device_session_id) {
    return res.status(400).json({ error: 'token_id y device_session_id son requeridos' });
  }
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    let openpayCustomerId = cliente.openpay_customer_id;
    if (!openpayCustomerId) {
      const partesNombre = (cliente.nombre || 'Cliente VillaNet').trim().split(' ');
      const openpayCliente = await openpay.crearCliente({
        nombre: partesNombre[0],
        apellido: partesNombre.slice(1).join(' ') || 'VillaNet',
        email,
        telefono: cliente.telefono,
      });
      openpayCustomerId = openpayCliente.id;
    }
    const tarjeta = await openpay.guardarTarjeta({
      openpayCustomerId,
      tokenId: token_id,
      deviceSessionId: device_session_id,
    });
    await supabase
      .from('clientes_isp')
      .update({
        openpay_customer_id: openpayCustomerId,
        openpay_card_id: tarjeta.id,
        metodo_cobro: 'tarjeta',
        cobro_automatico: true,
        ultimo_error_cobro: null,
      })
      .eq('id', req.params.id);
    res.json({
      ok: true,
      tarjeta: {
        id: tarjeta.id,
        marca: tarjeta.brand,
        terminacion: tarjeta.card_number ? tarjeta.card_number.slice(-4) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Quita la tarjeta guardada y desactiva el cobro automatico de ese cliente.
app.delete('/api/clientes/:id/tarjeta', async (req, res) => {
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('openpay_customer_id, openpay_card_id')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    if (cliente.openpay_customer_id && cliente.openpay_card_id) {
      await openpay.eliminarTarjeta({
        openpayCustomerId: cliente.openpay_customer_id,
        openpayCardId: cliente.openpay_card_id,
      });
    }
    await supabase
      .from('clientes_isp')
      .update({ openpay_card_id: null, metodo_cobro: 'manual', cobro_automatico: false })
      .eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Boton de admin "Cobrar ahora": fuerza un cargo inmediato a la tarjeta
// guardada del cliente, sin esperar al cron diario.
app.post('/api/clientes/:id/cobrar-ahora', async (req, res) => {
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('*, planes_isp(precio)')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    if (!cliente.openpay_customer_id || !cliente.openpay_card_id) {
      throw new Error('Este cliente no tiene tarjeta guardada en Openpay');
    }
    if (!cliente.planes_isp || !cliente.planes_isp.precio) {
      throw new Error('El cliente no tiene un plan con precio asignado');
    }
    const claveMes = new Date().toISOString().slice(0, 7);
    const monto = cliente.planes_isp.precio;
    const orderId = `${cliente.numero_cuenta || cliente.id}-${claveMes}-manual-${Date.now()}`;
    const cargo = await openpay.cobrarTarjetaGuardada({
      openpayCustomerId: cliente.openpay_customer_id,
      openpayCardId: cliente.openpay_card_id,
      monto,
      descripcion: `VillaNet MX - cobro manual - ${cliente.numero_cuenta}`,
      ordenId: orderId,
    });
    await supabase.from('cobros_openpay_log').insert({
      cliente_id: cliente.id,
      openpay_charge_id: cargo.id,
      monto,
      mes_correspondiente: `${claveMes}-01`,
      estado: cargo.status,
      detalle: JSON.stringify(cargo).slice(0, 4000),
    });
    if (cargo.status === 'completed') {
      await supabase.from('pagos_isp').insert({
        cliente_id: cliente.id,
        monto,
        mes_correspondiente: `${claveMes}-01`,
        metodo: 'openpay_tarjeta',
      });
      if (cliente.estado === 'suspendido') {
        await mikrotik.reactivarCliente(cliente.mikrotik_secret_name);
        await supabase.from('clientes_isp').update({ estado: 'activo' }).eq('id', cliente.id);
      }
    }
    res.json({ ok: true, cargo: { id: cargo.id, status: cargo.status } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Devuelve la ficha SPEI mas reciente del cliente (para mostrarla en el panel
// o mandarla por WhatsApp: CLABE, banco, referencia, monto y vencimiento).
app.get('/api/clientes/:id/ficha-spei', async (req, res) => {
  const { data, error } = await supabase
    .from('fichas_spei_isp')
    .select('*')
    .eq('cliente_id', req.params.id)
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { estado: 'sin_ficha' });
});
// Boton de admin "Generar ficha SPEI ahora": crea una ficha de deposito fuera
// del calendario normal del cron (util para probar o para un cliente nuevo).
app.post('/api/clientes/:id/generar-ficha-spei', async (req, res) => {
  try {
    const { data: cliente, error } = await supabase
      .from('clientes_isp')
      .select('*, planes_isp(precio)')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Cliente no encontrado');
    if (!cliente.planes_isp || !cliente.planes_isp.precio) {
      throw new Error('El cliente no tiene un plan con precio asignado');
    }
    let openpayCustomerId = cliente.openpay_customer_id;
    if (!openpayCustomerId) {
      const partesNombre = (cliente.nombre || 'Cliente VillaNet').trim().split(' ');
      const openpayCliente = await openpay.crearCliente({
        nombre: partesNombre[0],
        apellido: partesNombre.slice(1).join(' ') || 'VillaNet',
        telefono: cliente.telefono,
      });
      openpayCustomerId = openpayCliente.id;
      await supabase.from('clientes_isp').update({ openpay_customer_id: openpayCustomerId }).eq('id', cliente.id);
    }
    const claveMes = new Date().toISOString().slice(0, 7);
    const monto = cliente.planes_isp.precio;
    const orderId = `${cliente.numero_cuenta || cliente.id}-${claveMes}-manual-${Date.now()}`;
    const cargo = await openpay.crearCargoSPEI({
      openpayCustomerId,
      monto,
      descripcion: `VillaNet MX - mensualidad ${claveMes} - ${cliente.numero_cuenta}`,
      ordenId: orderId,
    });
    const metodoPago = cargo.payment_method || {};
    const { data: ficha, error: insertError } = await supabase
      .from('fichas_spei_isp')
      .insert({
        cliente_id: cliente.id,
        openpay_charge_id: cargo.id,
        clabe: metodoPago.clabe || null,
        referencia: metodoPago.reference || null,
        banco: metodoPago.bank || null,
        monto,
        mes_correspondiente: `${claveMes}-01`,
        estado: 'pendiente',
      })
      .select()
      .single();
    if (insertError) throw new Error(insertError.message);
    res.json({ ok: true, ficha });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ---------- Tickets de soporte tecnico ----------
app.get('/api/tickets', async (req, res) => {
  const { data, error } = await supabase
    .from('reportes_falla_isp')
    .select('*, clientes_isp(nombre, numero_cuenta, mikrotik_secret_name, telefono)')
    .order('fecha_reporte', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post('/api/tickets', async (req, res) => {
  const { cliente_id, descripcion } = req.body;
  if (!cliente_id || !descripcion) {
    return res.status(400).json({ error: 'cliente_id y descripcion son requeridos' });
  }
  try {
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes_isp')
      .select('mikrotik_secret_name')
      .eq('id', cliente_id)
      .single();
    if (clienteError) throw new Error('Cliente no encontrado');
    // Diagnostico automatico contra el MikroTik real
    let diagnostico = 'no_verificable';
    try {
      const estado = await mikrotik.estadoConexion(cliente.mikrotik_secret_name);
      if (estado.suspendido_por_falta_pago) {
        diagnostico = 'suspendido_por_falta_de_pago';
      } else if (estado.conectado_ahora) {
        diagnostico = 'conectado_revisar_equipo_cliente';
      } else {
        diagnostico = 'sin_sesion_activa_posible_falla_fisica';
      }
    } catch (e) {
      diagnostico = 'error_al_verificar: ' + e.message;
    }
    const { data: ticket, error: insertError } = await supabase
      .from('reportes_falla_isp')
      .insert({
        cliente_id,
        descripcion,
        diagnostico_automatico: diagnostico,
        estado: 'abierto',
      })
      .select()
      .single();
    if (insertError) throw new Error(insertError.message);
    res.json({ ok: true, ticket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/tickets/:id', async (req, res) => {
  const { estado } = req.body;
  try {
    const payload = { estado };
    if (estado === 'resuelto') {
      payload.fecha_resuelto = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from('reportes_falla_isp')
      .update(payload)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, ticket: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ---------- Monitor del tunel VPN (reportado directo desde el MikroTik) ----------
const MONITOR_TOKEN = process.env.VILLANET_MONITOR_TOKEN;
app.post('/api/monitor-tunel', async (req, res) => {
  const token = req.headers['x-monitor-token'];
  if (token !== MONITOR_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const { estado, detalle } = req.body;
  try {
    await supabase.from('monitor_tunel_log').insert({ estado, detalle });
    // Si el tunel tuvo que repararse, aqui es donde en el futuro se
    // dispara el aviso de WhatsApp a Alfredo (whatsappBot.enviarWhatsApp),
    // en cuanto el numero de VillaNet este activo.
    // if (estado === 'reparado') {
    //   await whatsappBot.enviarWhatsApp('<telefono_admin>', `Alerta VillaNet: el tunel se cayo y se reparo solo. Detalle: ${detalle}`);
    // }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/monitor-tunel/ultimo', async (req, res) => {
  const { data, error } = await supabase
    .from('monitor_tunel_log')
    .select('*')
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { estado: 'sin_datos' });
});
// ---------- Ordenes de servicio (visitas tecnicas) ----------
const { generarPdfOrdenServicio } = require('./ordenServicioPdf');
app.get('/api/ordenes', async (req, res) => {
  const { data, error } = await supabase
    .from('ordenes_servicio')
    .select('*, clientes_isp(nombre, numero_cuenta, telefono, direccion)')
    .order('fecha_cita', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post('/api/ordenes', async (req, res) => {
  const { cliente_id, tipo_servicio, descripcion, fecha_cita, hora_cita, tecnico } = req.body;
  if (!cliente_id || !tipo_servicio || !fecha_cita || !hora_cita) {
    return res.status(400).json({ error: 'cliente_id, tipo_servicio, fecha_cita y hora_cita son requeridos' });
  }
  try {
    // Generar folio consecutivo
    const { data: ultima } = await supabase
      .from('ordenes_servicio')
      .select('folio')
      .order('id', { ascending: false })
      .limit(1);
    let siguienteNum = 1;
    if (ultima && ultima.length > 0) {
      const num = parseInt(ultima[0].folio.replace('OS-', ''), 10);
      siguienteNum = num + 1;
    }
    const folio = 'OS-' + String(siguienteNum).padStart(4, '0');
    const { data: orden, error } = await supabase
      .from('ordenes_servicio')
      .insert({ folio, cliente_id, tipo_servicio, descripcion, fecha_cita, hora_cita, tecnico })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, orden });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/ordenes/:id', async (req, res) => {
  const { estado } = req.body;
  try {
    const { data, error } = await supabase
      .from('ordenes_servicio')
      .update({ estado })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, orden: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Genera y descarga el PDF de una orden (bajo demanda, no se guarda en disco)
app.get('/api/ordenes/:id/pdf', async (req, res) => {
  try {
    const { data: orden, error } = await supabase
      .from('ordenes_servicio')
      .select('*, clientes_isp(nombre, numero_cuenta, telefono, direccion)')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Orden no encontrada');
    const datosPdf = {
      folio: orden.folio,
      cliente_nombre: orden.clientes_isp ? orden.clientes_isp.nombre : '',
      numero_cuenta: orden.clientes_isp ? orden.clientes_isp.numero_cuenta : '',
      direccion: orden.clientes_isp ? orden.clientes_isp.direccion : '',
      telefono: orden.clientes_isp ? orden.clientes_isp.telefono : '',
      tipo_servicio: orden.tipo_servicio,
      descripcion: orden.descripcion,
      fecha_cita: orden.fecha_cita,
      hora_cita: orden.hora_cita,
      tecnico: orden.tecnico,
    };
    const pdfBuffer = await generarPdfOrdenServicio(datosPdf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="orden-${orden.folio}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Envia (o reenvia) el recordatorio de WhatsApp de una orden
app.post('/api/ordenes/:id/recordatorio', async (req, res) => {
  try {
    const { data: orden, error } = await supabase
      .from('ordenes_servicio')
      .select('*, clientes_isp(nombre, telefono)')
      .eq('id', req.params.id)
      .single();
    if (error) throw new Error('Orden no encontrada');
    if (!orden.clientes_isp || !orden.clientes_isp.telefono) {
      throw new Error('El cliente no tiene telefono registrado');
    }
    const fechaTexto = new Date(orden.fecha_cita + 'T00:00:00').toLocaleDateString('es-MX', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
    const mensaje =
      `Hola ${orden.clientes_isp.nombre} , te escribimos de VillaNet MX para recordarte tu cita de ${orden.tipo_servicio} ` +
      `programada para el ${fechaTexto} a las ${orden.hora_cita}. Folio: ${orden.folio}. ` +
      `Si necesitas reprogramar, contactanos.`;
    await whatsappBot.enviarWhatsApp(orden.clientes_isp.telefono, mensaje);
    await supabase.from('ordenes_servicio').update({ recordatorio_enviado: true }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ---------- Webhook de WhatsApp (bot de autoservicio para clientes) ----------
const whatsappBot = require('./whatsappBotService');
const VERIFY_TOKEN = process.env.VILLANET_WHATSAPP_VERIFY_TOKEN;
// Verificacion inicial que pide Meta al configurar el webhook
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
// Recepcion de mensajes reales
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const mensaje = value && value.messages && value.messages[0];
    if (mensaje && mensaje.type === 'text') {
      const telefono = mensaje.from;
      const texto = mensaje.text.body;
      await whatsappBot.manejarMensajeEntrante(telefono, texto);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook de WhatsApp:', err.message);
    res.sendStatus(200); // siempre 200 para que Meta no reintente en bucle
  }
});
// ---------- WhatsApp: Embedded Signup (coexistencia app + API, gratis) ----------
// El frontend (panel-villanet.html) abre FB.login() con el App ID de Meta y,
// si el usuario acepta, nos manda aqui el "code" para intercambiarlo por un
// token de acceso. Esto vincula el numero de VillaNet en modo coexistencia
// (sigue funcionando la app de WhatsApp Business Y la Cloud API al mismo
// tiempo), sin pagar ningun proveedor intermedio.
const META_APP_ID = process.env.META_APP_ID; // '1402639808465062'
const META_APP_SECRET = process.env.META_APP_SECRET;

app.post('/api/whatsapp/vincular-coexistencia', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code es requerido' });
  }
  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(500).json({ error: 'Faltan META_APP_ID / META_APP_SECRET en las variables de entorno' });
  }

  try {
    const params = new URLSearchParams({
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      code,
    });

    const resp = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?${params.toString()}`);
    const data = await resp.json();

    if (data.error) {
      throw new Error(data.error.message || 'Meta rechazo el intercambio del codigo');
    }

    // TODO: convertir este token en un token de usuario del sistema de larga
    // duracion y guardarlo cifrado en Supabase (nunca en texto plano ni
    // expuesto al frontend). Por ahora solo se confirma que el intercambio
    // funciono.
    console.log('[coexistencia] token recibido de Meta, longitud:', (data.access_token || '').length);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Webhook de Openpay (notificaciones de cargos: tarjeta y SPEI) ----------
// Openpay no firma el body del webhook, asi que nunca hay que confiar en el
// directamente: en cuanto llega un evento se vuelve a consultar el cargo
// real con la API para confirmarlo antes de reaccionar a el.
app.post('/webhook/openpay', async (req, res) => {
  try {
    const evento = req.body || {};
    const transactionId =
      (evento.transaction && evento.transaction.id) ||
      (evento.data && evento.data.transaction && evento.data.transaction.id) ||
      evento.transaction_id;
    if (!transactionId) return res.sendStatus(200);
    const cargoReal = await openpay.consultarCargo(transactionId);
    console.log('[webhook openpay] verificado directo con Openpay:', cargoReal.id, cargoReal.status);
    await supabase.from('cobros_openpay_log').insert({
      openpay_charge_id: cargoReal.id,
      monto: cargoReal.amount,
      estado: 'webhook_' + cargoReal.status,
      detalle: JSON.stringify(cargoReal).slice(0, 4000),
    });
    // Reconciliacion de depositos SPEI: si el cargo confirmado corresponde a
    // una ficha generada por VillaNet, registrar el pago y reactivar solo.
    if (cargoReal.method === 'bank_account' && cargoReal.status === 'completed') {
      const { data: ficha } = await supabase
        .from('fichas_spei_isp')
        .select('*')
        .eq('openpay_charge_id', cargoReal.id)
        .maybeSingle();
      if (ficha && ficha.estado !== 'pagada') {
        await supabase.from('pagos_isp').insert({
          cliente_id: ficha.cliente_id,
          monto: ficha.monto,
          mes_correspondiente: ficha.mes_correspondiente,
          metodo: 'openpay_spei',
        });
        await supabase.from('fichas_spei_isp').update({ estado: 'pagada' }).eq('id', ficha.id);
        const { data: cliente } = await supabase
          .from('clientes_isp')
          .select('mikrotik_secret_name, estado')
          .eq('id', ficha.cliente_id)
          .single();
        if (cliente && cliente.estado === 'suspendido') {
          await mikrotik.reactivarCliente(cliente.mikrotik_secret_name);
          await supabase.from('clientes_isp').update({ estado: 'activo' }).eq('id', ficha.cliente_id);
        }
        console.log(`[webhook openpay] deposito SPEI confirmado y reconciliado: cliente ${ficha.cliente_id}`);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook openpay] error:', err.message);
    res.sendStatus(200); // responder 200 para que Openpay no reintente en bucle
  }
});
app.get('/api/resumen', async (req, res) => {
  try {
    const { data: clientes } = await supabase
      .from('clientes_isp')
      .select('*, planes_isp(precio)');
    const activos = clientes.filter((c) => c.estado === 'activo').length;
    const suspendidos = clientes.filter((c) => c.estado === 'suspendido').length;
    const bajas = clientes.filter((c) => c.estado === 'baja').length;
    const primerDiaMes = new Date();
    primerDiaMes.setDate(1);
    primerDiaMes.setHours(0, 0, 0, 0);
    const { data: pagosMes } = await supabase
      .from('pagos_isp')
      .select('monto')
      .gte('fecha_pago', primerDiaMes.toISOString().slice(0, 10));
    const ingresosMes = (pagosMes || []).reduce((sum, p) => sum + parseFloat(p.monto), 0);
    // Calcular cuantos clientes (no dados de baja) tienen algun mes pendiente
    const { data: todosPagos } = await supabase.from('pagos_isp').select('cliente_id, mes_correspondiente');
    let clientesConAdeudo = 0;
    const hoy = new Date();
    for (const c of clientes.filter((c) => c.estado !== 'baja')) {
      const mesesPagados = new Set(
        (todosPagos || []).filter((p) => p.cliente_id === c.id).map((p) => p.mes_correspondiente.slice(0, 7))
      );
      const fechaAlta = new Date(c.fecha_alta);
      const cursor = new Date(fechaAlta.getFullYear(), fechaAlta.getMonth(), 1);
      const finMesActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      let debe = false;
      while (cursor <= finMesActual) {
        const clave = cursor.toISOString().slice(0, 7);
        if (!mesesPagados.has(clave)) {
          debe = true;
          break;
        }
        cursor.setMonth(cursor.getMonth() + 1);
      }
      if (debe) clientesConAdeudo++;
    }
    const { data: ticketsAbiertos } = await supabase
      .from('reportes_falla_isp')
      .select('id')
      .neq('estado', 'resuelto');
    res.json({
      clientes_activos: activos,
      clientes_suspendidos: suspendidos,
      clientes_baja: bajas,
      ingresos_mes: ingresosMes,
      clientes_con_adeudo: clientesConAdeudo,
      tickets_abiertos: (ticketsAbiertos || []).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VillaNet MX backend corriendo en puerto ${PORT}`);
});
