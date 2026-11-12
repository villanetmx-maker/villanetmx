// hotspotService.js
// Venta automatica de fichas del hotspot VillaNet WiFi con Clip.
//
// Como funciona:
//  1. Las fichas "web" (prefijo VW) ya existen en la MikroTik (se cargan con
//     villanet-fichas-web.rsc) y tambien en la tabla hotspot_fichas de Supabase.
//  2. El cliente elige su ficha en /hotspot/comprar -> se crea una venta y un
//     link de pago de Clip.
//  3. Cuando Clip confirma el pago (webhook o consulta), se le asigna una ficha
//     disponible del tipo comprado y se le muestra el codigo.
//  No hace falta hablar con la MikroTik: la vigencia la maneja el router solo.

const clip = require('./clipService');

const PLANES = {
  'ficha-1h': { nombre: '1 hora', monto: 15 },
  'ficha-1dia': { nombre: '1 día', monto: 20 },
  'ficha-1semana': { nombre: '1 semana', monto: 150 },
};

const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://villanet-backend-xoc2.onrender.com').replace(/\/$/, '');

module.exports = function registrarHotspot(app, supabase) {
  // ---------- Paginas publicas (las abre el cliente desde el hotspot) ----------
  app.get('/hotspot/comprar', (req, res) => {
    res.type('html').send(paginaComprar());
  });

  app.get('/hotspot/resultado', (req, res) => {
    res.type('html').send(paginaResultado(String(req.query.ref || '')));
  });

  // ---------- Crear venta + link de pago ----------
  app.post('/api/hotspot/checkout', async (req, res) => {
    try {
      const tipo = String((req.body && req.body.tipo) || '');
      const plan = PLANES[tipo];
      if (!plan) return res.status(400).json({ error: 'Tipo de ficha no valido' });

      const { count } = await supabase
        .from('hotspot_fichas')
        .select('codigo', { count: 'exact', head: true })
        .eq('tipo', tipo)
        .eq('estado', 'disponible');
      if (!count) return res.status(409).json({ error: 'Por ahora no hay fichas de este tipo. Escríbenos por WhatsApp.' });

      const { data: venta, error } = await supabase
        .from('hotspot_ventas')
        .insert({ tipo, monto: plan.monto, estado: 'pendiente' })
        .select()
        .single();
      if (error) throw new Error(error.message);

      const resultado = `${BASE_URL}/hotspot/resultado?ref=${venta.id}`;
      const checkout = await clip.crearCheckout({
        monto: plan.monto,
        descripcion: `Ficha WiFi VillaNet - ${plan.nombre}`,
        referencia: venta.id,
        urlExito: resultado,
        urlError: resultado,
        urlDefault: `${BASE_URL}/hotspot/comprar`,
        webhookUrl: `${BASE_URL}/webhook/clip`,
      });

      await supabase
        .from('hotspot_ventas')
        .update({ payment_request_id: checkout.payment_request_id })
        .eq('id', venta.id);

      res.json({ ok: true, url: checkout.payment_request_url, ref: venta.id });
    } catch (err) {
      console.error('[hotspot checkout]', err.message);
      res.status(500).json({ error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
    }
  });

  // ---------- Estado de una venta (la pagina de resultado lo consulta) ----------
  app.get('/api/hotspot/venta/:id', async (req, res) => {
    try {
      let venta = await obtenerVenta(req.params.id);
      if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
      if (venta.estado === 'pendiente') venta = await procesarVenta(venta);
      res.json({
        estado: venta.estado,
        codigo: venta.codigo || null,
        tipo: venta.tipo,
        plan: PLANES[venta.tipo] ? PLANES[venta.tipo].nombre : venta.tipo,
      });
    } catch (err) {
      console.error('[hotspot venta]', err.message);
      res.status(500).json({ error: 'Error consultando la venta' });
    }
  });

  // ---------- Webhook de Clip ----------
  // No se confia en el body: se vuelve a consultar el link con la API de Clip.
  app.post('/webhook/clip', async (req, res) => {
    try {
      const b = req.body || {};
      const prId =
        b.payment_request_id ||
        b.id ||
        (b.resource && (b.resource.payment_request_id || b.resource.id)) ||
        (b.data && (b.data.payment_request_id || b.data.id));
      if (prId) {
        const { data: venta } = await supabase
          .from('hotspot_ventas')
          .select('*')
          .eq('payment_request_id', prId)
          .maybeSingle();
        if (venta && venta.estado === 'pendiente') await procesarVenta(venta);
      }
    } catch (err) {
      console.error('[webhook clip]', err.message);
    }
    res.sendStatus(200); // siempre 200 para que Clip no reintente en bucle
  });

  async function obtenerVenta(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await supabase.from('hotspot_ventas').select('*').eq('id', id).maybeSingle();
    return data;
  }

  // Confirma el pago con Clip y, si ya se pago, asigna una ficha.
  async function procesarVenta(venta) {
    if (venta.codigo || !venta.payment_request_id) return venta;
    const cr = await clip.consultarCheckout(venta.payment_request_id);

    if (cr.status === 'CHECKOUT_COMPLETED') {
      if (Number(cr.amount) !== Number(venta.monto)) {
        console.error(`[hotspot] monto no coincide venta ${venta.id}: ${cr.amount} vs ${venta.monto}`);
        await supabase.from('hotspot_ventas').update({ estado: 'revisar' }).eq('id', venta.id);
        return { ...venta, estado: 'revisar' };
      }
      const codigo = await asignarFicha(venta);
      if (!codigo) {
        await supabase.from('hotspot_ventas').update({ estado: 'sin_fichas', receipt_no: cr.receipt_no || null }).eq('id', venta.id);
        console.error(`[hotspot] PAGADA SIN FICHA DISPONIBLE venta ${venta.id} (${venta.tipo})`);
        return { ...venta, estado: 'sin_fichas' };
      }
      const cambios = { estado: 'pagada', codigo, receipt_no: cr.receipt_no || null, pagada_at: new Date().toISOString() };
      await supabase.from('hotspot_ventas').update(cambios).eq('id', venta.id);
      return { ...venta, ...cambios };
    }

    if (cr.status === 'CHECKOUT_EXPIRED' || cr.status === 'CHECKOUT_CANCELLED') {
      const estado = cr.status === 'CHECKOUT_EXPIRED' ? 'expirada' : 'cancelada';
      await supabase.from('hotspot_ventas').update({ estado }).eq('id', venta.id);
      return { ...venta, estado };
    }
    return venta; // sigue pendiente
  }

  // Toma una ficha disponible del tipo comprado sin que dos ventas agarren la misma.
  async function asignarFicha(venta) {
    for (let intento = 0; intento < 5; intento++) {
      const { data: libre } = await supabase
        .from('hotspot_fichas')
        .select('codigo')
        .eq('tipo', venta.tipo)
        .eq('estado', 'disponible')
        .order('codigo')
        .limit(1)
        .maybeSingle();
      if (!libre) return null;
      const { data: tomada } = await supabase
        .from('hotspot_fichas')
        .update({ estado: 'vendida', venta_id: venta.id, vendida_at: new Date().toISOString() })
        .eq('codigo', libre.codigo)
        .eq('estado', 'disponible')
        .select('codigo');
      if (tomada && tomada.length) {
        const { count } = await supabase
          .from('hotspot_fichas')
          .select('codigo', { count: 'exact', head: true })
          .eq('tipo', venta.tipo)
          .eq('estado', 'disponible');
        if (count !== null && count < 5) console.warn(`[hotspot] Quedan ${count} fichas de ${venta.tipo}`);
        return tomada[0].codigo;
      }
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// Paginas HTML (se sirven desde el backend; el cliente las abre con la prueba
// gratis del hotspot o con sus datos moviles)
// ---------------------------------------------------------------------------
const ESTILOS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:linear-gradient(160deg,#0b3d91 0%,#1565c0 45%,#43a047 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;color:#1a2b3c}
.card{background:#fff;border-radius:18px;max-width:400px;width:100%;padding:22px 20px 18px;box-shadow:0 10px 30px rgba(0,0,0,.25);text-align:center}
h1{font-size:20px;color:#0b3d91;margin-bottom:6px}
.sub{font-size:13px;color:#5b6b7b;margin-bottom:16px}
.plan{display:flex;justify-content:space-between;align-items:center;width:100%;border:2px solid #e3eaf2;border-radius:14px;padding:14px 16px;margin-bottom:10px;background:#fff;cursor:pointer;font-size:16px;color:#1a2b3c}
.plan b{font-size:22px;color:#43a047}
.plan.top{border-color:#43a047;background:#f3fbf3}
.plan:disabled{opacity:.5}
.codigo{font-family:monospace;font-size:38px;letter-spacing:6px;font-weight:800;color:#0b3d91;background:#eef3f8;border-radius:14px;padding:16px;margin:12px 0}
.btn{display:block;width:100%;border:0;border-radius:12px;padding:13px;font-size:16px;font-weight:700;text-decoration:none;margin-top:10px;background:#1565c0;color:#fff}
.btn-wa{background:#25d366}
.paso{font-size:14px;text-align:left;margin:8px 0;line-height:1.4}
.nota{font-size:11.5px;color:#7a8a9a;margin-top:12px;line-height:1.4}
.err{background:#fdecea;color:#b71c1c;border-radius:10px;padding:9px;font-size:13px;margin-bottom:12px;display:none}
`;
const WA = 'https://wa.me/525668574395?text=Hola%2C%20tengo%20una%20duda%20con%20mi%20ficha%20de%20WiFi%20VillaNet';

function paginaComprar() {
  const botones = Object.entries(PLANES)
    .map(([tipo, p]) => `<button class="plan${tipo === 'ficha-1semana' ? ' top' : ''}" onclick="comprar('${tipo}', this)"><span>${p.nombre}</span><b>$${p.monto}</b></button>`)
    .join('');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comprar ficha - VillaNet WiFi</title><style>${ESTILOS}</style></head><body><div class="card">
<h1>Compra tu ficha WiFi</h1><p class="sub">Paga con tarjeta de débito o crédito y recibe tu código al instante</p>
<div class="err" id="err"></div>${botones}
<p class="nota">El pago se hace en la página segura de Clip. Tu código aparece en cuanto se confirme el pago.</p>
<a class="btn btn-wa" href="${WA}">¿Dudas? Escríbenos por WhatsApp</a>
</div><script>
async function comprar(tipo, b){
  document.querySelectorAll('.plan').forEach(x=>x.disabled=true); b.querySelector('span').textContent='Abriendo pago...';
  try{
    const r=await fetch('/api/hotspot/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tipo})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Error');
    try{localStorage.setItem('vn_ref',d.ref)}catch(e){}
    location.href=d.url;
  }catch(e){const el=document.getElementById('err'); el.textContent=e.message; el.style.display='block'; setTimeout(()=>location.reload(),3000);}
}
</script></body></html>`;
}

function paginaResultado(ref) {
  const refSeguro = /^[0-9a-f-]{36}$/i.test(ref) ? ref : '';
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tu ficha - VillaNet WiFi</title><style>${ESTILOS}</style></head><body><div class="card" id="c">
<h1>Confirmando tu pago...</h1><p class="sub">Esto tarda unos segundos, no cierres esta página.</p>
</div><script>
const ref='${refSeguro}'||(function(){try{return localStorage.getItem('vn_ref')||''}catch(e){return ''}})();
const c=document.getElementById('c'); let n=0;
async function revisar(){
  if(!ref){c.innerHTML='<h1>No encontramos tu compra</h1><a class="btn btn-wa" href="${WA}">Escríbenos por WhatsApp</a>';return;}
  try{
    const r=await fetch('/api/hotspot/venta/'+ref); const d=await r.json();
    if(d.estado==='pagada'&&d.codigo){
      c.innerHTML='<h1>¡Listo! Tu ficha de '+d.plan+'</h1><div class="codigo">'+d.codigo+'</div>'+
      '<p class="paso"><b>1.</b> Toca <b>Guardar mi código en WhatsApp</b> para tenerlo siempre en tu chat (o toma captura).</p>'+
      '<p class="paso"><b>2.</b> Toca <b>Usar mi ficha</b> y escribe el código en la página de VillaNet WiFi.</p>'+
      '<a class="btn btn-wa" href="https://wa.me/525668574395?text='+encodeURIComponent('Mi ficha WiFi VillaNet ('+d.plan+'): '+d.codigo)+'">Guardar mi código en WhatsApp</a>'+
      '<a class="btn" href="http://192.168.60.1/logout">Usar mi ficha</a>'+
      '<p class="nota">Si no te sale la página de VillaNet, abre <b>http://192.168.60.1</b> en tu navegador.</p>';
      return;
    }
    if(['expirada','cancelada'].includes(d.estado)){c.innerHTML='<h1>El pago no se completó</h1><p class="sub">No se te cobró nada.</p><a class="btn" href="/hotspot/comprar">Intentar de nuevo</a>';return;}
    if(['sin_fichas','revisar'].includes(d.estado)){c.innerHTML='<h1>Tu pago entró</h1><p class="sub">Pero necesitamos revisarlo. Escríbenos y te mandamos tu ficha en seguida.</p><a class="btn btn-wa" href="${WA}">WhatsApp</a>';return;}
  }catch(e){}
  if(++n<40) setTimeout(revisar,3000);
  else c.innerHTML='<h1>Seguimos esperando la confirmación</h1><p class="sub">Si ya pagaste, escríbenos con tu comprobante.</p><a class="btn btn-wa" href="${WA}">WhatsApp</a>';
}
revisar();
</script></body></html>`;
}

// Precios compartidos con el bot de WhatsApp
module.exports.PLANES = PLANES;
module.exports.BASE_URL = BASE_URL;
