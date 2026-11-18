/**
 * panelService.js
 * VillaNet MX - Rutas extra para el panel de operacion (todas bajo /api/panel/
 * y protegidas con la clave del panel por el middleware de index.js).
 */
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');

const HOY_MX = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
const inicioMesIso = () => {
  const h = HOY_MX();
  return new Date(Date.UTC(h.getFullYear(), h.getMonth(), 1, 6)).toISOString(); // 00:00 hora MX
};
const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;
const plus = () => require('./botPlusService');

module.exports = function registrarPanel(app) {
  const ruta = (metodo, path, fn) =>
    app[metodo](path, async (req, res) => {
      try {
        await fn(req, res);
      } catch (e) {
        console.error('[panel]', path, e.message);
        res.status(500).json({ error: e.message });
      }
    });

  // ---------- Inicio: ingresos del mes por fuente y alertas ----------
  ruta('get', '/api/panel/inicio', async (req, res) => {
    const desde = inicioMesIso();
    const mesClave = desde.slice(0, 7);
    const [pagos, fichas, recargas, disp, aviso, prospectos, clipPend] = await Promise.all([
      supabase.from('pagos_isp').select('monto, metodo, fecha_pago, created_at').gte('fecha_pago', `${mesClave}-01`),
      supabase.from('hotspot_ventas').select('monto').eq('estado', 'pagada').gte('pagada_at', desde),
      supabase.from('recargas_ventas').select('monto, cargo, categoria').eq('estado', 'exitosa').gte('pagada_at', desde),
      supabase.from('hotspot_fichas').select('tipo').eq('estado', 'disponible'),
      supabase.from('avisos_red').select('*').eq('activo', true).order('creado_at', { ascending: false }).limit(1),
      supabase.from('prospectos_isp').select('id').gte('creado_at', new Date(Date.now() - 7 * 864e5).toISOString()),
      supabase.from('pagos_clip_isp').select('id').eq('estado', 'pendiente').gte('creado_at', new Date(Date.now() - 864e5).toISOString()),
    ]);
    const suma = (arr, k) => (arr || []).reduce((s, x) => s + Number(x[k] || 0), 0);
    const porTipo = {};
    for (const f of disp.data || []) porTipo[f.tipo] = (porTipo[f.tipo] || 0) + 1;
    const rec = recargas.data || [];
    const ventasTA = rec.filter((x) => /tiempo aire|paquete/i.test(x.categoria || '')).reduce((s, x) => s + Number(x.monto || 0), 0);
    res.json({
      mes: mesClave,
      mensualidades: r2(suma(pagos.data, 'monto')),
      mensualidades_tarjeta: r2(suma((pagos.data || []).filter((p) => /clip|tarjeta/.test(p.metodo || '')), 'monto')),
      fichas: r2(suma(fichas.data, 'monto')),
      fichas_vendidas: (fichas.data || []).length,
      recargas_vendidas: rec.length,
      recargas_monto: r2(suma(rec, 'monto')),
      recargas_cargos: r2(suma(rec, 'cargo')),
      recargas_comision_aprox: r2(ventasTA * 0.05),
      fichas_disponibles: porTipo,
      aviso_activo: (aviso.data || [])[0] || null,
      prospectos_7dias: (prospectos.data || []).length,
      links_pago_pendientes: (clipPend.data || []).length,
    });
  });

  // ---------- Consumo de la red (del registro que manda el hEX cada 5 min) ----------
  ruta('get', '/api/panel/consumo', async (req, res) => {
    const horas = Math.min(Math.max(Number(req.query.horas) || 24, 1), 24 * 31);
    const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
    let data = [];
    for (let i = 0; i < 12000; i += 1000) {
      const { data: d, error } = await supabase
        .from('consumo_muestras').select('creada_at, datos').gte('creada_at', desde).order('creada_at').range(i, i + 999);
      if (error) throw new Error(error.message);
      data = data.concat(d || []);
      if (!d || d.length < 1000) break;
    }
    const parse = (s) => {
      const m = {};
      for (const p of s.split(',')) {
        const [n, rx, tx] = p.split(':');
        if (n) m[n] = { rx: Number(rx) || 0, tx: Number(tx) || 0 };
      }
      return m;
    };
    // Agrupa por hora (<= 3 dias) o por dia (mas tiempo)
    const porDia = horas > 72;
    const grupos = {}, porCliente = {};
    for (let i = 1; i < data.length; i++) {
      const a = parse(data[i - 1].datos), b = parse(data[i].datos);
      const seg = (new Date(data[i].creada_at) - new Date(data[i - 1].creada_at)) / 1000;
      if (seg < 60 || seg > 1200) continue;
      const local = new Date(new Date(data[i].creada_at).getTime() - 6 * 3600 * 1000).toISOString();
      const clave = porDia ? local.slice(0, 10) : local.slice(0, 13).replace('T', ' ') + 'h';
      for (const n of Object.keys(b)) {
        if (!a[n]) continue;
        const dRx = b[n].rx - a[n].rx, dTx = b[n].tx - a[n].tx;
        if (dRx < 0 || dTx < 0) continue;
        if (n === 'ether1') {
          const baj = (dRx * 8) / seg / 1e6, sub = (dTx * 8) / seg / 1e6;
          const g = (grupos[clave] = grupos[clave] || { bajada: 0, subida: 0, n: 0, pico: 0, gb: 0 });
          g.bajada += baj; g.subida += sub; g.n++; g.pico = Math.max(g.pico, baj); g.gb += dRx / 1e9;
        } else {
          const c = (porCliente[n] = porCliente[n] || { bajadaGB: 0, subidaGB: 0, picoMbps: 0 });
          c.bajadaGB += dTx / 1e9; c.subidaGB += dRx / 1e9;
          c.picoMbps = Math.max(c.picoMbps, (dTx * 8) / seg / 1e6);
        }
      }
    }
    // Nombre del cliente para cada secret de PPPoE
    const { data: clientes } = await supabase.from('clientes_isp').select('nombre, numero_cuenta, mikrotik_secret_name');
    const nombres = {};
    for (const c of clientes || []) nombres[c.mikrotik_secret_name] = `${c.numero_cuenta} · ${c.nombre}`;
    const totalGB = Object.values(porCliente).reduce((s, c) => s + c.bajadaGB, 0) || 1;
    res.json({
      horas,
      agrupado: porDia ? 'dia' : 'hora',
      muestras: data.length,
      serie: Object.entries(grupos).map(([k, v]) => ({
        etiqueta: k, bajadaMbps: r2(v.bajada / v.n), subidaMbps: r2(v.subida / v.n), picoMbps: r2(v.pico), gb: r2(v.gb),
      })),
      clientes: Object.entries(porCliente)
        .map(([n, v]) => ({
          secret: n, nombre: nombres[n] || (n.startsWith('hs-') || n.includes('hotspot') ? 'Hotspot (fichas)' : n),
          bajadaGB: r2(v.bajadaGB), subidaGB: r2(v.subidaGB), picoMbps: r2(v.picoMbps), pct: Math.round((v.bajadaGB / totalGB) * 100),
        }))
        .sort((x, y) => y.bajadaGB - x.bajadaGB),
    });
  });

  // ---------- Fichas WiFi ----------
  ruta('get', '/api/panel/fichas', async (req, res) => {
    const [disp, ventas, registros] = await Promise.all([
      supabase.from('hotspot_fichas').select('tipo, estado'),
      supabase.from('hotspot_ventas').select('id, tipo, monto, estado, codigo, creada_at, pagada_at').order('creada_at', { ascending: false }).limit(60),
      supabase.from('hotspot_registros').select('telefono, visitas, primera_at, ultima_at, baja').order('ultima_at', { ascending: false }).limit(60),
    ]);
    const inventario = {};
    for (const f of disp.data || []) {
      const t = (inventario[f.tipo] = inventario[f.tipo] || { disponible: 0, vendida: 0 });
      t[f.estado === 'disponible' ? 'disponible' : 'vendida']++;
    }
    res.json({ inventario, ventas: ventas.data || [], registros: registros.data || [] });
  });

  // ---------- Recargas (Taecel) ----------
  ruta('get', '/api/panel/recargas', async (req, res) => {
    const { data: ventas } = await supabase
      .from('recargas_ventas')
      .select('id, carrier, categoria, referencia, monto, cargo, total, estado, folio, detalle, creada_at, pagada_at')
      .order('creada_at', { ascending: false })
      .limit(60);
    let bolsas = [], errorSaldo = null;
    try {
      const b = await require('./taecelService').getBalance();
      bolsas = ((b && b.data) || []).map((x) => ({ bolsa: x.Bolsa || `Bolsa ${x.ID}`, saldo: Number(String(x.Saldo || '0').replace(/,/g, '')) }));
      if (!bolsas.length) errorSaldo = (b && (b.message || b.error)) || 'Taecel no devolvió saldo';
    } catch (e) {
      errorSaldo = e.message;
    }
    res.json({ ventas: ventas || [], bolsas, errorSaldo });
  });

  // ---------- Pagos en linea de mensualidades (Clip) ----------
  ruta('get', '/api/panel/pagos-clip', async (req, res) => {
    const { data: pagos } = await supabase.from('pagos_clip_isp').select('*').order('creado_at', { ascending: false }).limit(60);
    const { data: clientes } = await supabase.from('clientes_isp').select('id, nombre, numero_cuenta');
    const mapa = {};
    for (const c of clientes || []) mapa[String(c.id)] = c;
    res.json((pagos || []).map((p) => ({ ...p, cliente: mapa[String(p.cliente_id)] || null, payment_url: undefined })));
  });

  // ---------- Avisos generales de falla ----------
  ruta('get', '/api/panel/avisos', async (req, res) => {
    const { data } = await supabase.from('avisos_red').select('*').order('creado_at', { ascending: false }).limit(30);
    res.json(data || []);
  });
  ruta('post', '/api/panel/avisos', async (req, res) => {
    const { tipo, texto } = req.body || {};
    if (tipo === 'falla') {
      if (!texto || String(texto).trim().length < 5) return res.status(400).json({ error: 'Escribe el texto del aviso' });
      return res.json({ ok: true, resultado: await plus().comandoAvisoFalla(String(texto).trim()) });
    }
    if (tipo === 'listo') return res.json({ ok: true, resultado: await plus().comandoAvisoListo(String(texto || '').trim()) });
    res.status(400).json({ error: 'tipo debe ser falla o listo' });
  });

  // ---------- Prospectos / referidos ----------
  ruta('get', '/api/panel/prospectos', async (req, res) => {
    const { data } = await supabase.from('prospectos_isp').select('*').order('creado_at', { ascending: false }).limit(100);
    res.json(data || []);
  });

  // ---------- Acciones sobre un cliente ----------
  ruta('post', '/api/panel/clientes/:id/enviar-estado-cuenta', async (req, res) => {
    res.json(await plus().enviarEstadoCuentaPanel(req.params.id));
  });

  ruta('get', '/api/panel/clientes/:id/estado-cuenta.pdf', async (req, res) => {
    const { buffer, nombre } = await plus().pdfEstadoCuenta(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
    res.send(buffer);
  });

  ruta('post', '/api/panel/clientes/:id/reiniciar', async (req, res) => {
    const { data: c } = await supabase.from('clientes_isp').select('estado, mikrotik_secret_name').eq('id', req.params.id).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (c.estado !== 'activo') return res.status(400).json({ error: 'Solo se puede reiniciar un cliente activo' });
    const url = process.env.VILLANET_PROXY_URL;
    const h = { 'Content-Type': 'application/json', 'x-proxy-token': process.env.VILLANET_PROXY_TOKEN };
    await fetch(`${url}/suspender/${c.mikrotik_secret_name}`, { method: 'POST', headers: h });
    await new Promise((r) => setTimeout(r, 3000));
    const r2x = await fetch(`${url}/reactivar/${c.mikrotik_secret_name}`, { method: 'POST', headers: h });
    if (!r2x.ok) throw new Error('El router no confirmó la reconexión; revisa que el cliente quedó ACTIVO');
    await new Promise((r) => setTimeout(r, 20000));
    const est = await mikrotik.estadoConexion(c.mikrotik_secret_name).catch(() => null);
    res.json({ ok: true, conectado: !!(est && est.conectado_ahora) });
  });

  ruta('post', '/api/panel/clientes/:id/cambiar-plan', async (req, res) => {
    const { data: c } = await supabase.from('clientes_isp').select('numero_cuenta').eq('id', req.params.id).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
    const r = await plus().aplicarCambioPlan(c.numero_cuenta, (req.body || {}).plan_id);
    if (!/^✅/.test(r)) return res.status(400).json({ error: r });
    res.json({ ok: true, mensaje: r });
  });
};
