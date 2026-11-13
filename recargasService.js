// recargasService.js
// Recargas de tiempo aire, paquetes, gift cards y pago de servicios (Taecel)
// para VillaNet, cobradas con tarjeta por Clip.
//
// Flujo: el cliente elige en /recargas -> se crea la venta y el link de Clip
// -> cuando Clip confirma el pago (webhook o consulta) se manda la recarga a
// Taecel. Nunca se recarga sin pago confirmado y nunca dos veces la misma venta.
//
// Variables de entorno (Render):
//   TAECEL_KEY, TAECEL_NIP           credenciales de Taecel
//   RECARGA_CARGO        (def 3)     cargo fijo por recarga / paquete
//   SERVICIO_CARGO_FIJO  (def 10)    cargo fijo por pago de servicio / gift card
//   SERVICIO_CARGO_PCT   (def 4.5)   % extra para pagar la comision de Clip
//   HOTSPOT_ROUTER_TOKEN             protege /api/recargas/diag

const taecel = require('./taecelService');
const clip = require('./clipService');

const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://villanet-backend-xoc2.onrender.com').replace(/\/$/, '');
const CARGO_RECARGA = Number(process.env.RECARGA_CARGO || 3);
const CARGO_SERV_FIJO = Number(process.env.SERVICIO_CARGO_FIJO || 10);
const CARGO_SERV_PCT = Number(process.env.SERVICIO_CARGO_PCT || 4.5);
const MAX_SERVICIO = 3000;
const SALDO_MINIMO = 200;
const ADMIN = process.env.VILLANET_ADMIN_WHATSAPP_NUMBER || '5215546633899';

// ---------- Catalogo (se guarda 6 horas en memoria) ----------
let cache = { t: 0, data: null };

async function catalogo() {
  if (cache.data && Date.now() - cache.t < 6 * 3600 * 1000) return cache.data;
  const r = await taecel.getProducts();
  if (!r || !r.success || !r.data) throw new Error('Taecel no regreso el catalogo');
  const d = r.data;
  const carriers = (d.carriers || [])
    .filter((c) => !c.Comision || c.Comision.Status === '1')
    .filter((c) => (c.Campos || []).some((f) => f.Campo === 'referencia'))
    .map((c) => {
      const ref = c.Campos.find((f) => f.Campo === 'referencia');
      return {
        id: c.ID,
        nombre: c.Nombre,
        logo: /^https:\/\/cdn\.taecel\.com\//.test(c.Logotipo || '') ? c.Logotipo : '',
        categoria: c.Categoria,
        libre: c.Tipo === '1',
        campo: {
          nombre: ref.Nombre,
          min: Number(ref.Min) || 1,
          max: Number(ref.Max) || 40,
          numerico: ref.Formato === '1',
          confirmar: ref.Confirmar === '1',
        },
      };
    });
  const ids = new Set(carriers.map((c) => c.id));
  const productos = (d.productos || [])
    .filter((p) => ids.has(p.CarrierID))
    .map((p) => ({
      codigo: p.Codigo,
      carrier: p.CarrierID,
      monto: Number(p.Monto) || 0,
      nombre: p.Nombre || '',
      vigencia: p.Vigencia || '',
      descripcion: (p.Descripcion || '').slice(0, 600),
    }));
  const orden = ['Tiempo Aire', 'Paquetes', 'Servicios', 'GiftCards'];
  const categorias = [...new Set(carriers.map((c) => c.categoria))].sort(
    (a, b) => (orden.indexOf(a) + 99) % 99 - (orden.indexOf(b) + 99) % 99
  );
  cache = { t: Date.now(), data: { categorias, carriers, productos } };
  return cache.data;
}

function esServicio(carrier) {
  return carrier.categoria === 'Servicios' || carrier.categoria === 'GiftCards' || carrier.libre;
}

function calcularCargo(carrier, monto) {
  if (!esServicio(carrier)) return CARGO_RECARGA;
  return Math.ceil(CARGO_SERV_FIJO + (monto * CARGO_SERV_PCT) / 100);
}

module.exports = function registrarRecargas(app, supabase) {
  async function avisarAdmin(texto) {
    try {
      await require('./whatsappBotService').enviarWhatsApp(ADMIN, texto);
    } catch (e) {
      console.error('[recargas] aviso admin:', e.message);
    }
  }

  // ---------- Diagnostico privado ----------
  app.get('/api/recargas/diag', async (req, res) => {
    const token = process.env.HOTSPOT_ROUTER_TOKEN;
    if (!token || String(req.query.t || '') !== token) return res.status(403).json({ error: 'sin permiso' });
    try {
      const saldo = await taecel.getBalance();
      const c = await catalogo();
      res.json({ saldo, categorias: c.categorias, carriers: c.carriers.length, productos: c.productos.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- Pagina publica ----------
  app.get('/recargas', (req, res) => res.type('html').send(paginaRecargas()));
  app.get('/recargas/resultado', (req, res) => res.type('html').send(paginaResultado(String(req.query.ref || ''))));

  app.get('/api/recargas/catalogo', async (req, res) => {
    try {
      const c = await catalogo();
      res.set('Cache-Control', 'public, max-age=900');
      res.json({ ...c, cargos: { recarga: CARGO_RECARGA, servFijo: CARGO_SERV_FIJO, servPct: CARGO_SERV_PCT } });
    } catch (e) {
      console.error('[recargas catalogo]', e.message);
      res.status(503).json({ error: 'Las recargas no están disponibles por el momento.' });
    }
  });

  // ---------- Crear venta + link de pago ----------
  app.post('/api/recargas/checkout', async (req, res) => {
    try {
      const b = req.body || {};
      const c = await catalogo();
      const prod = c.productos.find((p) => p.codigo === String(b.codigo || ''));
      if (!prod) return res.status(400).json({ error: 'Producto no válido' });
      const carrier = c.carriers.find((x) => x.id === prod.carrier);

      const referencia = String(b.referencia || '').trim();
      const f = carrier.campo;
      if (referencia.length < f.min || referencia.length > f.max || (f.numerico && !/^\d+$/.test(referencia))) {
        return res.status(400).json({ error: `Revisa el dato: ${f.nombre} (${f.min === f.max ? f.min : f.min + '-' + f.max} ${f.numerico ? 'dígitos' : 'caracteres'})` });
      }

      let monto = prod.monto;
      if (!monto) {
        monto = Math.round(Number(b.monto) * 100) / 100;
        if (!(monto >= 1 && monto <= MAX_SERVICIO)) return res.status(400).json({ error: `El monto debe ser entre $1 y $${MAX_SERVICIO}` });
      }
      const cargo = calcularCargo(carrier, monto);
      const total = Math.round((monto + cargo) * 100) / 100;

      const { data: venta, error } = await supabase
        .from('recargas_ventas')
        .insert({
          codigo: prod.codigo,
          carrier: carrier.nombre,
          categoria: carrier.categoria,
          referencia,
          monto,
          cargo,
          total,
          libre: !prod.monto,
          estado: 'pendiente',
        })
        .select()
        .single();
      if (error) throw new Error(error.message);

      const resultado = `${BASE_URL}/recargas/resultado?ref=${venta.id}`;
      const checkout = await clip.crearCheckout({
        monto: total,
        descripcion: `${carrier.nombre} $${monto} a ${referencia} (VillaNet)`.slice(0, 120),
        referencia: venta.id,
        urlExito: resultado,
        urlError: resultado,
        urlDefault: `${BASE_URL}/recargas`,
        webhookUrl: `${BASE_URL}/webhook/clip-recargas`,
      });
      await supabase.from('recargas_ventas').update({ payment_request_id: checkout.payment_request_id }).eq('id', venta.id);
      res.json({ ok: true, url: checkout.payment_request_url, ref: venta.id });
    } catch (err) {
      console.error('[recargas checkout]', err.message);
      res.status(500).json({ error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
    }
  });

  // ---------- Estado (lo consulta la pagina de resultado) ----------
  app.get('/api/recargas/venta/:id', async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'No encontrada' });
      const { data: v } = await supabase.from('recargas_ventas').select('*').eq('id', req.params.id).maybeSingle();
      if (!v) return res.status(404).json({ error: 'No encontrada' });
      if (v.estado === 'pendiente') revisarPago(v).catch((e) => console.error('[recargas revisar]', e.message));
      res.json({
        estado: v.estado,
        carrier: v.carrier,
        referencia: v.referencia,
        monto: v.monto,
        total: v.total,
        folio: v.folio,
      });
    } catch (e) {
      res.status(500).json({ error: 'Error' });
    }
  });

  app.post('/webhook/clip-recargas', async (req, res) => {
    res.sendStatus(200); // contestar rapido; se verifica con Clip
    try {
      const b = req.body || {};
      const prId = b.payment_request_id || b.id || (b.resource && (b.resource.payment_request_id || b.resource.id)) || (b.data && (b.data.payment_request_id || b.data.id));
      if (!prId) return;
      const { data: v } = await supabase.from('recargas_ventas').select('*').eq('payment_request_id', prId).maybeSingle();
      if (v && v.estado === 'pendiente') await revisarPago(v);
    } catch (e) {
      console.error('[webhook clip recargas]', e.message);
    }
  });

  // Confirma con Clip; si ya se pago, toma la venta (una sola vez) y recarga.
  async function revisarPago(v) {
    if (!v.payment_request_id) return;
    const cr = await clip.consultarCheckout(v.payment_request_id);
    if (cr.status === 'CHECKOUT_EXPIRED' || cr.status === 'CHECKOUT_CANCELLED') {
      await supabase.from('recargas_ventas').update({ estado: cr.status === 'CHECKOUT_EXPIRED' ? 'expirada' : 'cancelada' }).eq('id', v.id).eq('estado', 'pendiente');
      return;
    }
    if (cr.status !== 'CHECKOUT_COMPLETED') return;

    // Candado: solo un proceso pasa de 'pendiente' a 'recargando'
    const { data: tomada } = await supabase
      .from('recargas_ventas')
      .update({ estado: 'recargando', receipt_no: cr.receipt_no || null, pagada_at: new Date().toISOString() })
      .eq('id', v.id)
      .eq('estado', 'pendiente')
      .select('id');
    if (!tomada || !tomada.length) return;

    if (Number(cr.amount) !== Number(v.total)) {
      await supabase.from('recargas_ventas').update({ estado: 'revisar', detalle: `monto Clip ${cr.amount}` }).eq('id', v.id);
      await avisarAdmin(`🚨 Recarga con monto distinto en Clip (${cr.amount} vs ${v.total}). Revisa la venta ${v.id}.`);
      return;
    }

    let r;
    try {
      r = await taecel.realizarTransaccionCompleta(v.codigo, v.referencia, v.libre ? v.monto : null, { maxEsperaSegundos: 90 });
    } catch (e) {
      r = { exito: false, etapa: 'error', respuesta: { message: e.message } };
    }
    const d = (r.respuesta && r.respuesta.data) || {};
    const msg = (r.respuesta && r.respuesta.message) || '';
    const folio = d.Folio || d.folio || null;

    if (r.exito) {
      await supabase.from('recargas_ventas').update({ estado: 'exitosa', trans_id: r.transID, folio, detalle: msg.slice(0, 500) }).eq('id', v.id);
      await avisarAdmin(`📱 Recarga vendida: ${v.carrier} $${v.monto} a ${v.referencia}. Cobrado $${v.total} (cargo $${v.cargo}). Folio ${folio || '-'}`);
      revisarSaldo().catch(() => {});
    } else {
      const estado = r.etapa === 'timeout' ? 'revisar' : 'fallida';
      await supabase.from('recargas_ventas').update({ estado, trans_id: r.transID || null, detalle: (msg || r.etapa).slice(0, 500) }).eq('id', v.id);
      await avisarAdmin(
        `🚨 RECARGA ${estado === 'revisar' ? 'SIN CONFIRMAR' : 'FALLIDA'} ya cobrada por Clip: ${v.carrier} $${v.monto} a ${v.referencia}. ` +
          `Cobrado $${v.total} (recibo Clip ${cr.receipt_no || '-'}). Motivo: ${msg || r.etapa}. ` +
          (estado === 'revisar' ? 'Revisa en el panel de Taecel si sí se aplicó.' : 'Haz la devolución en Clip o la recarga a mano.')
      );
    }
  }

  async function revisarSaldo() {
    const b = await taecel.getBalance();
    const bolsas = (b && b.data) || [];
    for (const x of bolsas) {
      const s = Number(String(x.Saldo || '0').replace(/,/g, ''));
      if ((x.ID === '1' || x.ID === '2') && s < SALDO_MINIMO) {
        await avisarAdmin(`⚠️ Saldo bajo en Taecel (${x.Bolsa}): $${s.toFixed(2)}. Recarga tu bolsa para no detener las ventas (también afecta a La Pape).`);
      }
    }
  }
};

// ======================= PAGINAS =======================
const ESTILOS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:linear-gradient(160deg,#0b3d91 0%,#1565c0 45%,#43a047 100%);min-height:100vh;padding:16px;color:#1a2b3c}
.card{background:#fff;border-radius:18px;max-width:520px;margin:0 auto;padding:20px 16px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
h1{font-size:20px;color:#0b3d91;margin-bottom:4px;text-align:center}
h2{font-size:16px;color:#0b3d91;margin:14px 0 8px}
.sub{font-size:13px;color:#5b6b7b;margin-bottom:12px;text-align:center}
.tabs{display:flex;gap:6px;overflow-x:auto;margin-bottom:10px;padding-bottom:4px}
.tab{flex:none;border:2px solid #e3eaf2;background:#fff;border-radius:999px;padding:7px 13px;font-size:13.5px;font-weight:600;color:#0b3d91;cursor:pointer}
.tab.on{background:#0b3d91;border-color:#0b3d91;color:#fff}
input.buscar,input.dato{width:100%;font-size:16px;padding:11px 12px;border:2px solid #cfd8e3;border-radius:12px;outline:none;margin-bottom:10px}
input:focus{border-color:#1565c0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.car{border:2px solid #e3eaf2;border-radius:12px;background:#fff;padding:8px 4px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;min-height:84px;justify-content:center}
.car img{max-width:90%;max-height:44px;object-fit:contain}
.car span{font-size:11.5px;color:#3d4d5d;text-align:center;line-height:1.2}
.car.on{border-color:#43a047;background:#f3fbf3}
.prod{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;border:2px solid #e3eaf2;border-radius:12px;padding:10px 12px;margin-bottom:8px;background:#fff;cursor:pointer;text-align:left}
.prod b{font-size:18px;color:#43a047;flex:none}
.prod small{display:block;font-size:11.5px;color:#7a8a9a;margin-top:2px}
.prod.on{border-color:#43a047;background:#f3fbf3}
.btn{display:block;width:100%;border:0;border-radius:12px;padding:13px;font-size:16px;font-weight:700;text-decoration:none;margin-top:10px;background:#1565c0;color:#fff;cursor:pointer;text-align:center}
.btn:disabled{opacity:.5}
.btn-wa{background:#25d366}
.resumen{background:#eef3f8;border-radius:12px;padding:12px;font-size:14px;line-height:1.7;margin-top:8px}
.resumen b{float:right}
.err{background:#fdecea;color:#b71c1c;border-radius:10px;padding:9px;font-size:13px;margin:8px 0;display:none}
.nota{font-size:11.5px;color:#7a8a9a;margin-top:12px;line-height:1.4;text-align:center}
.oculto{display:none}
.estado{text-align:center;font-size:15px;line-height:1.5}
.grande{font-size:40px;text-align:center;margin:8px 0}
`;

function paginaRecargas() {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recargas y pagos - VillaNet</title><style>${ESTILOS}</style></head><body><div class="card">
<h1>Recargas y pago de servicios</h1><p class="sub">Paga con tarjeta y se aplica al momento</p>
<div class="tabs" id="tabs"></div>
<input class="buscar" id="buscar" placeholder="Buscar compañía (Telcel, CFE, Netflix...)">
<div class="grid" id="grid"><p class="sub" style="grid-column:1/-1">Cargando catálogo…</p></div>

<div id="paso2" class="oculto">
  <h2 id="tCarrier"></h2>
  <div id="prods"></div>
  <div id="libre" class="oculto"><input class="dato" id="monto" type="number" inputmode="decimal" min="1" placeholder="Monto a pagar ($)"></div>
  <input class="dato" id="ref" autocomplete="off">
  <input class="dato oculto" id="ref2" autocomplete="off">
  <div class="resumen oculto" id="resumen"></div>
  <div class="err" id="err"></div>
  <button class="btn" id="pagar" disabled onclick="pagar()">Pagar con tarjeta</button>
  <p class="nota" id="desc"></p>
</div>
<p class="nota">El pago se hace en la página segura de Clip. Las recargas no tienen devolución: revisa bien el número.<br>Logotipos: catálogo de Taecel.</p>
</div>
<script>
let C=null, cat=null, car=null, prod=null;
const $=id=>document.getElementById(id);
fetch('/api/recargas/catalogo').then(r=>r.json()).then(d=>{
  if(d.error){$('grid').innerHTML='<p class="sub" style="grid-column:1/-1">'+d.error+'</p>';return;}
  C=d; cat=d.categorias[0]; tabs(); grid();
}).catch(()=>{$('grid').innerHTML='<p class="sub" style="grid-column:1/-1">No se pudo cargar. Intenta de nuevo.</p>';});
const NOMBRE={'Tiempo Aire':'📱 Recargas','Paquetes':'🌐 Paquetes','Servicios':'🧾 Servicios','GiftCards':'🎁 Gift Cards'};
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function tabs(){ $('tabs').innerHTML=C.categorias.map(c=>'<button class="tab'+(c===cat?' on':'')+'" onclick="setCat(\\''+c+'\\')">'+(NOMBRE[c]||esc(c))+'</button>').join(''); }
function setCat(c){cat=c;$('buscar').value='';tabs();grid();$('paso2').classList.add('oculto');}
$('buscar').oninput=grid;
function grid(){
  const q=$('buscar').value.trim().toLowerCase();
  const lista=C.carriers.filter(x=>q?x.nombre.toLowerCase().includes(q):x.categoria===cat);
  $('grid').innerHTML=lista.length?lista.map(x=>'<div class="car'+(car&&car.id===x.id?' on':'')+'" onclick="elegir(\\''+x.id+'\\')">'+(x.logo?'<img loading="lazy" src="'+esc(x.logo)+'" alt="" onerror="this.remove()">':'')+'<span>'+esc(x.nombre)+'</span></div>').join(''):'<p class="sub" style="grid-column:1/-1">Sin resultados</p>';
}
function elegir(id){
  car=C.carriers.find(x=>x.id===id); prod=null; grid();
  $('tCarrier').textContent=car.nombre;
  const ps=C.productos.filter(p=>p.carrier===id);
  const fijos=ps.filter(p=>p.monto>0);
  if(fijos.length){
    $('libre').classList.add('oculto');
    $('prods').innerHTML=fijos.map(p=>'<button class="prod" data-c="'+esc(p.codigo)+'" onclick="elegirProd(\\''+esc(p.codigo)+'\\')"><div>'+esc(p.nombre||('$'+p.monto))+(p.vigencia?'<small>Vigencia: '+esc(p.vigencia)+'</small>':'')+'</div><b>$'+p.monto+'</b></button>').join('');
  }else{
    $('prods').innerHTML=''; $('libre').classList.remove('oculto'); prod=ps[0]||null; $('desc').textContent=prod?prod.descripcion:'';
  }
  const f=car.campo;
  $('ref').placeholder=f.nombre; $('ref').inputMode=f.numerico?'numeric':'text'; $('ref').maxLength=f.max; $('ref').value='';
  $('ref2').placeholder='Confirma: '+f.nombre; $('ref2').maxLength=f.max; $('ref2').value=''; $('ref2').inputMode=$('ref').inputMode;
  $('ref2').classList.toggle('oculto',!f.confirmar);
  $('paso2').classList.remove('oculto'); calc(); $('paso2').scrollIntoView({behavior:'smooth'});
}
function elegirProd(c){prod=C.productos.find(p=>p.codigo===c);document.querySelectorAll('.prod').forEach(b=>b.classList.toggle('on',b.dataset.c===c));$('desc').textContent=prod.descripcion||'';calc();}
['ref','ref2','monto'].forEach(i=>$(i).addEventListener('input',calc));
function cargo(m){const s=car.categoria==='Servicios'||car.categoria==='GiftCards'||car.libre;return s?Math.ceil(C.cargos.servFijo+m*C.cargos.servPct/100):C.cargos.recarga;}
function calc(){
  $('err').style.display='none';
  if(!car||!prod){$('pagar').disabled=true;$('resumen').classList.add('oculto');return;}
  const m=prod.monto||Number($('monto').value)||0;
  const f=car.campo, r=$('ref').value.trim();
  let ok=m>0&&r.length>=f.min&&r.length<=f.max&&(!f.numerico||/^\\d+$/.test(r));
  if(f.confirmar&&$('ref2').value.trim()!==r) ok=false;
  if(m>0){const cg=cargo(m);$('resumen').innerHTML=car.nombre+' <b>$'+m.toFixed(2)+'</b><br>Cargo por servicio <b>$'+cg.toFixed(2)+'</b><br><strong>Total a pagar</strong> <b>$'+(m+cg).toFixed(2)+'</b>';$('resumen').classList.remove('oculto');}
  $('pagar').disabled=!ok;
}
async function pagar(){
  const b=$('pagar'); b.disabled=true; b.textContent='Abriendo pago...';
  try{
    const r=await fetch('/api/recargas/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({codigo:prod.codigo,referencia:$('ref').value.trim(),monto:Number($('monto').value)||undefined})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Error');
    try{localStorage.setItem('vn_rec',d.ref)}catch(e){}
    location.href=d.url;
  }catch(e){$('err').textContent=e.message;$('err').style.display='block';b.disabled=false;b.textContent='Pagar con tarjeta';}
}
</script></body></html>`;
}

function paginaResultado(ref) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tu recarga - VillaNet</title><style>${ESTILOS}</style></head><body><div class="card" id="c">
<div class="grande">⏳</div><p class="estado">Confirmando tu pago…</p></div>
<script>
let ref=${JSON.stringify(ref)}; if(!/^[0-9a-f-]{36}$/i.test(ref)){try{ref=localStorage.getItem('vn_rec')||''}catch(e){}}
const WA='https://wa.me/525668574395?text='+encodeURIComponent('Hola, tengo un problema con mi recarga VillaNet '+ref);
let n=0;
function pintar(icono,txt,extra){document.getElementById('c').innerHTML='<div class="grande">'+icono+'</div><p class="estado">'+txt+'</p>'+(extra||'');}
async function ver(){
  n++;
  try{
    const r=await fetch('/api/recargas/venta/'+ref); const d=await r.json();
    if(d.estado==='exitosa'){pintar('✅','<b>¡Listo!</b> '+d.carrier+' $'+d.monto+' aplicada a '+d.referencia+(d.folio?'<br>Folio: <b>'+d.folio+'</b>':''),'<a class="btn" href="/recargas">Hacer otra recarga</a>');return;}
    if(d.estado==='fallida'||d.estado==='revisar'){pintar('⚠️','Tu pago entró pero la recarga no se pudo confirmar. Ya nos llegó el aviso y lo resolvemos en seguida.','<a class="btn btn-wa" href="'+WA+'">Escríbenos por WhatsApp</a>');return;}
    if(d.estado==='expirada'||d.estado==='cancelada'){pintar('❌','El pago no se completó. No se te cobró nada.','<a class="btn" href="/recargas">Intentar de nuevo</a>');return;}
    if(d.estado==='recargando') pintar('📲','Pago confirmado. Aplicando tu recarga… (puede tardar hasta un minuto)');
  }catch(e){}
  if(n<60) setTimeout(ver,4000); else pintar('⏳','Seguimos confirmando. Si en unos minutos no te llega, escríbenos.','<a class="btn btn-wa" href="'+WA+'">WhatsApp</a>');
}
ver();
</script></body></html>`;
}
