const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');

require('./cronCorteISP');

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

    // Si cambió la velocidad, sincronizar el rate-limit real en MikroTik
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
  const { nombre, telefono, direccion, plan_id, dia_corte, password } = req.body;
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

// ---------- Tickets de soporte técnico ----------

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

    // Diagnóstico automático contra el MikroTik real
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VillaNet MX backend corriendo en puerto ${PORT}`);
});
