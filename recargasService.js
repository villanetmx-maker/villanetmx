// recargasService.js
// Recargas de tiempo aire y pago de servicios (Taecel) para VillaNet.
// Paso 1: diagnostico para ver el catalogo real de la cuenta Taecel.
// Protegido con HOTSPOT_ROUTER_TOKEN para que no lo use cualquiera.

const taecel = require('./taecelService');

module.exports = function registrarRecargas(app, supabase) {
  app.get('/api/recargas/diag', async (req, res) => {
    const token = process.env.HOTSPOT_ROUTER_TOKEN;
    if (!token || String(req.query.t || '') !== token) return res.status(403).json({ error: 'sin permiso' });
    const out = {};
    try {
      const b = await taecel.getBalance();
      out.saldo = b;
    } catch (e) {
      out.saldo_error = e.message;
    }
    try {
      const p = await taecel.getProducts();
      out.success = p.success;
      out.message = p.message;
      const d = p.data;
      out.tipo = Array.isArray(d) ? 'array' : typeof d;
      if (Array.isArray(d)) {
        out.total = d.length;
        out.campos = d[0] ? Object.keys(d[0]) : [];
        out.muestra = d.slice(0, 8);
        out.todos = d;
      } else if (d && typeof d === 'object') {
        out.llaves = Object.keys(d);
        out.data = d;
      }
    } catch (e) {
      out.productos_error = e.message;
    }
    res.json(out);
  });
};
