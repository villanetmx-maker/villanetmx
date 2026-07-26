// cronCobroISP.js
// Cron diario de cobro automatico via Openpay para clientes con tarjeta
// guardada (cobro_automatico = true). Corre unos dias antes del "dia_corte"
// de cada cliente y reintenta cada dia hasta que se pague o llegue el corte
// (ese dia, cronCorteISP.js sigue siendo quien suspende si de plano no hay pago).
//
// Requiere el mismo paquete de scheduling que ya use cronCorteISP.js. Si el
// proyecto todavia no tiene "node-cron" en package.json, agregarlo con:
//   npm install node-cron

const cron = require('node-cron');
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');
const openpay = require('./openpayService');

// Cuantos dias antes del dia_corte se empieza a intentar el cobro automatico.
const DIAS_ANTES_DE_CORTE_PARA_INTENTAR = 3;

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

async function correrCobroAutomatico() {
  console.log('[cronCobroISP] iniciando revision de cobros automaticos', new Date().toISOString());

  const { data: clientes, error } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(precio)')
    .eq('cobro_automatico', true)
    .neq('estado', 'baja');

  if (error) {
    console.error('[cronCobroISP] error leyendo clientes:', error.message);
    return;
  }

  const hoy = new Date();
  const diaHoy = hoy.getDate();
  const claveMes = mesActualClave();

  for (const cliente of clientes || []) {
    if (!cliente.openpay_customer_id || !cliente.openpay_card_id) continue;

    const diaCorte = cliente.dia_corte || 30;
    const diaInicioIntentos = Math.max(1, diaCorte - DIAS_ANTES_DE_CORTE_PARA_INTENTAR);

    // Solo intentar dentro de la ventana [diaInicioIntentos, fin de mes].
    if (diaHoy < diaInicioIntentos) continue;

    const yaPagado = await mesYaPagado(cliente.id, claveMes);
    if (yaPagado) continue;

    const monto = cliente.planes_isp ? parseFloat(cliente.planes_isp.precio) : null;
    if (!monto) {
      console.warn(`[cronCobroISP] cliente ${cliente.numero_cuenta} sin precio de plan, se omite`);
      continue;
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
          metodo: 'openpay',
        });

        if (cliente.estado === 'suspendido') {
          await mikrotik.reactivarCliente(cliente.mikrotik_secret_name);
          await supabase.from('clientes_isp').update({ estado: 'activo' }).eq('id', cliente.id);
        }

        await supabase
          .from('clientes_isp')
          .update({ ultimo_intento_cobro: new Date().toISOString(), ultimo_error_cobro: null })
          .eq('id', cliente.id);

        console.log(`[cronCobroISP] cobro exitoso: ${cliente.numero_cuenta} ($${monto})`);
      } else {
        await supabase
          .from('clientes_isp')
          .update({
            ultimo_intento_cobro: new Date().toISOString(),
            ultimo_error_cobro: `Estado de Openpay: ${cargo.status}`,
          })
          .eq('id', cliente.id);
        console.warn(`[cronCobroISP] cobro no completado para ${cliente.numero_cuenta}: ${cargo.status}`);
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

      console.error(`[cronCobroISP] error cobrando a ${cliente.numero_cuenta}:`, mensaje);
    }
  }

  console.log('[cronCobroISP] revision terminada');
}

// Corre todos los dias a las 9:00 AM (zona horaria del servidor de Render;
// revisar TZ si hace falta ajustarla con la variable de entorno TZ).
cron.schedule('0 9 * * *', correrCobroAutomatico);

module.exports = { correrCobroAutomatico };
