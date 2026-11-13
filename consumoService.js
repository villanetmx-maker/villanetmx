// consumoService.js
// Registro de consumo de la red VillaNet. El hEX manda cada 5 minutos los
// contadores de bytes de ether1 (Starlink), ether5 (hotspot) y cada PPPoE.
// Aqui se guardan crudos y /api/consumo/resumen calcula Mbps por hora y cliente.
// Protegido con HOTSPOT_ROUTER_TOKEN.

module.exports = function registrarConsumo(app, supabase) {
  const ok = (req) => process.env.HOTSPOT_ROUTER_TOKEN && String(req.query.t || '') === process.env.HOTSPOT_ROUTER_TOKEN;

  app.get('/api/consumo', async (req, res) => {
    if (!ok(req)) return res.status(403).send('no');
    const d = String(req.query.d || '').slice(0, 4000);
    if (!/^[\w:,.-]+$/.test(d)) return res.status(400).send('formato');
    await supabase.from('consumo_muestras').insert({ datos: d });
    res.send('ok');
  });

  // Resumen: promedio de Mbps por hora (total) y top de clientes
  app.get('/api/consumo/resumen', async (req, res) => {
    if (!ok(req)) return res.status(403).json({ error: 'no' });
    const horas = Math.min(Number(req.query.horas) || 24, 168);
    const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('consumo_muestras')
      .select('creada_at, datos')
      .gte('creada_at', desde)
      .order('creada_at')
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });

    const parse = (s) => {
      const m = {};
      for (const p of s.split(',')) {
        const [n, rx, tx] = p.split(':');
        if (n) m[n] = { rx: Number(rx) || 0, tx: Number(tx) || 0 };
      }
      return m;
    };
    const porHora = {}; // hora -> { bajada, subida, n, pico }
    const porCliente = {}; // nombre -> bytes bajada/subida
    for (let i = 1; i < data.length; i++) {
      const a = parse(data[i - 1].datos), b = parse(data[i].datos);
      const seg = (new Date(data[i].creada_at) - new Date(data[i - 1].creada_at)) / 1000;
      if (seg < 60 || seg > 1200) continue;
      const hora = new Date(new Date(data[i].creada_at).getTime() - 6 * 3600 * 1000).toISOString().slice(0, 13).replace('T', ' ') + 'h';
      for (const n of Object.keys(b)) {
        if (!a[n]) continue;
        const dRx = b[n].rx - a[n].rx, dTx = b[n].tx - a[n].tx;
        if (dRx < 0 || dTx < 0) continue; // se reconecto y reinicio contadores
        if (n === 'ether1') {
          // ether1: rx = lo que baja del Starlink
          const baj = (dRx * 8) / seg / 1e6, sub = (dTx * 8) / seg / 1e6;
          const h = (porHora[hora] = porHora[hora] || { bajada: 0, subida: 0, n: 0, pico: 0 });
          h.bajada += baj; h.subida += sub; h.n++; h.pico = Math.max(h.pico, baj);
        } else {
          // PPPoE / hotspot del lado del router: tx = lo que baja al cliente
          const c = (porCliente[n] = porCliente[n] || { bajadaGB: 0, subidaGB: 0, picoMbps: 0 });
          c.bajadaGB += dTx / 1e9; c.subidaGB += dRx / 1e9;
          c.picoMbps = Math.max(c.picoMbps, (dTx * 8) / seg / 1e6);
        }
      }
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    res.json({
      muestras: data.length,
      horas: Object.entries(porHora).map(([h, v]) => ({ hora: h, bajadaMbps: r2(v.bajada / v.n), subidaMbps: r2(v.subida / v.n), picoBajadaMbps: r2(v.pico) })),
      clientes: Object.entries(porCliente)
        .map(([n, v]) => ({ cliente: n, bajadaGB: r2(v.bajadaGB), subidaGB: r2(v.subidaGB), picoMbps: r2(v.picoMbps) }))
        .sort((x, y) => y.bajadaGB - x.bajadaGB),
    });
  });
};
