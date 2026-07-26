// cronCobroISP.js
// Cron diario de cobro/deposito automatico para clientes que eligieron un
// metodo de cobro en Openpay (clientes_isp.metodo_cobro):
//   - 'tarjeta': se cobra la tarjeta guardada, unos dias antes del corte.
//   - 'spei'   : se genera una ficha de deposito (CLABE) una vez al mes; el
//                cliente transfiere manualmente y el webhook de Openpay avisa
//                cuando llega el pago (ver /webhook/openpay en index.js).
//   - 'manual' (o vacio): no se toca, sigue siendo registro manual desde el panel.
//
// Requiere el mismo paquete de scheduling que ya use cronCorteISP.js. Si el
// proyecto todavia no tiene "node-cron" en package.json, agregarlo con:
//   npm install node-cron

const cron = require('node-cron');
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');
const openpay = require('./openpayService');

// Cuantos dias antes del dia_corte se empieza a intentar el cobro con tarjeta.
const DIAS_ANTES_DE_CORTE_PARA_INTENTAR_TARJETA = 3;
// Cuantos dias antes del dia_corte se genera la ficha de deposito SPEI (se le
// da mas margen que a la tarjeta porque el cliente tiene que ir al banco/app).
const DIAS_ANTES_DE_CORTE_PARA_GENERAR_FICHA_SPEI = 7;
// Dia del mes siguiente hasta el que se le da de gracia antes de suspender
// (debe coincidir con la logica de cronCorteISP.js).
const DIA_LIMITE_DE_GRACIA = 5;

function mesActualClave() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

async function mesYaPagado(clienteId, claveMes) {
  const { data, error } = await supabase
    .from('pagos_isp')
    .select('id')
    .eq('cliente_id', clienteId)
    .gte('mes_correspondiente', `${claveMes}-01`)
    .lt('mes_correspondiente', `${claveMes}-31`)
    .limit(1);
  if (error) {
    console.error('[cronCobroISP] error revisando pagos existentes:', error.message);
    return false;
  }
  return (data || []).length > 0;
}

async function yaExisteFichaSPEIDelMes(clienteId, claveMes) {
  const { data, error } = await supabase
    .from('fichas_spei_isp')
    .select('id')
    .eq('cliente_id', clienteId)
    .eq('mes_correspondiente', `${claveMes}-01`)
    .limit(1);
  if (error) {
    console.error('[cronCobroISP] error revisando fichas SPEI existentes:', error.message);
    return true; // ante la duda, no generar una ficha duplicada
  }
  return (data || []).length > 0;
}

function fechaVencimientoGracia(claveMes) {
  // Vence el DIA_LIMITE_DE_GRACIA del mes siguiente al de la mensualidad.
  const [anio, mes] = claveMes.split('-').map(Number);
  const vencimiento = new Date(anio, mes, DIA_LIMITE_DE_GRACIA, 23, 59, 59); // mes es 0-index, así mes = mes_actual+1
  return vencimiento.toISOString();
}

async function intentarCobroTarjeta(cliente, claveMes) {
  const monto = cliente.planes_isp ? parseFloat(cliente.planes_isp.precio) : null;
  if (!monto) {
    console.warn(`[cronCobroISP] cliente ${cliente.numero_cuenta} sin precio de plan, se omite`);
    return;
  }

  const orderId = `${cliente.numero_cuenta || cliente.id}-${claveMes}`;

  try {
    const cargo = await openpay.cobrarTarjetaGuardada({
      openpayCustomerId: cliente.openpay_customer_id,
      openpayCardId: cliente.openpay_card_id,
      monto,
      descripcion: `VillaNet MX - mensualidad ${claveMes} - ${cliente.numero_cuenta}`,
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

      await supabase
        .from('clientes_isp')
        .update({ ultimo_intento_cobro: new Date().toISOString(), ultimo_error_cobro: null })
        .eq('id', cliente.id);

      console.log(`[cronCobroISP] cobro con tarjeta exitoso: ${cliente.numero_cuenta} ($${monto})`);
    } else {
      await supabase
        .from('clientes_isp')
        .update({
          ultimo_intento_cobro: new Date().toISOString(),
          ultimo_error_cobro: `Estado de Openpay: ${cargo.status}`,
        })
        .eq('id', cliente.id);
      console.warn(`[cronCobroISP] cobro con tarjeta no completado para ${cliente.numero_cuenta}: ${cargo.status}`);
    }
  } catch (err) {
    const mensaje = err.message;

    await supabase
      .from('clientes_isp')
      .update({ ultimo_intento_cobro: new Date().toISOString(), ultimo_error_cobro: mensaje })
      .eq('id', cliente.id);

    await supabase.from('cobros_openpay_log').insert({
      cliente_id: cliente.id,
      monto,
      mes_correspondiente: `${claveMes}-01`,
      estado: 'error',
      detalle: mensaje,
    });

    console.error(`[cronCobroISP] error cobrando tarjeta a ${cliente.numero_cuenta}:`, mensaje);
  }
}

async function generarFichaSPEISiHaceFalta(cliente, claveMes) {
  const monto = cliente.planes_isp ? parseFloat(cliente.planes_isp.precio) : null;
  if (!monto) {
    console.warn(`[cronCobroISP] cliente ${cliente.numero_cuenta} sin precio de plan, se omite (SPEI)`);
    return;
  }

  const yaExiste = await yaExisteFichaSPEIDelMes(cliente.id, claveMes);
  if (yaExiste) return;

  const orderId = `${cliente.numero_cuenta || cliente.id}-${claveMes}-spei`;

  try {
    const cargo = await openpay.crearCargoSPEI({
      openpayCustomerId: cliente.openpay_customer_id,
      monto,
      descripcion: `VillaNet MX - mensualidad ${claveMes} - ${cliente.numero_cuenta}`,
      ordenId: orderId,
      fechaVencimiento: fechaVencimientoGracia(claveMes),
    });

    const metodoPago = cargo.payment_method || {};

    await supabase.from('fichas_spei_isp').insert({
      cliente_id: cliente.id,
      openpay_charge_id: cargo.id,
      clabe: metodoPago.clabe || null,
      referencia: metodoPago.reference || null,
      banco: metodoPago.bank || null,
      monto,
      mes_correspondiente: `${claveMes}-01`,
      estado: 'pendiente',
      fecha_vencimiento: fechaVencimientoGracia(claveMes),
    });

    console.log(`[cronCobroISP] ficha SPEI generada para ${cliente.numero_cuenta}: CLABE ${metodoPago.clabe}`);
  } catch (err) {
    console.error(`[cronCobroISP] error generando ficha SPEI para ${cliente.numero_cuenta}:`, err.message);
  }
}

async function correrCobroAutomatico() {
  console.log('[cronCobroISP] iniciando revision de cobros/depositos automaticos', new Date().toISOString());

  const { data: clientes, error } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(precio)')
    .in('metodo_cobro', ['tarjeta', 'spei'])
    .neq('estado', 'baja');

  if (error) {
    console.error('[cronCobroISP] error leyendo clientes:', error.message);
    return;
  }

  const hoy = new Date();
  const diaHoy = hoy.getDate();
  const claveMes = mesActualClave();

  for (const cliente of clientes || []) {
    if (!cliente.openpay_customer_id) continue;

    const diaCorte = cliente.dia_corte || 30;
    const yaPagado = await mesYaPagado(cliente.id, claveMes);
    if (yaPagado) continue;

    if (cliente.metodo_cobro === 'tarjeta') {
      if (!cliente.openpay_card_id) continue;
      const diaInicioIntentos = Math.max(1, diaCorte - DIAS_ANTES_DE_CORTE_PARA_INTENTAR_TARJETA);
      if (diaHoy < diaInicioIntentos) continue;
      await intentarCobroTarjeta(cliente, claveMes);
    } else if (cliente.metodo_cobro === 'spei') {
      const diaInicioFicha = Math.max(1, diaCorte - DIAS_ANTES_DE_CORTE_PARA_GENERAR_FICHA_SPEI);
      if (diaHoy < diaInicioFicha) continue;
      await generarFichaSPEISiHaceFalta(cliente, claveMes);
    }
  }

  console.log('[cronCobroISP] revision terminada');
}

// Corre todos los dias a las 9:00 AM (zona horaria del servidor de Render;
// revisar TZ si hace falta ajustarla con la variable de entorno TZ).
cron.schedule('0 9 * * *', correrCobroAutomatico);

module.exports = { correrCobroAutomatico };
