/**
 * cronCorteISP.js
 * VillaNet MX - Servicio de Internet Residencial
 * Revisa diariamente qué clientes no han pagado el mes en curso
 * y suspende/reactiva su servicio en el MikroTik automáticamente.
 *
 * Requiere: npm install node-cron @supabase/supabase-js --save
 * Variables de entorno necesarias:
 *   VILLANET_SUPABASE_URL, VILLANET_SUPABASE_SERVICE_KEY
 *   VILLANET_MIKROTIK_HOST, VILLANET_MIKROTIK_USER, VILLANET_MIKROTIK_PASSWORD (usados en mikrotikService.js)
 *   VILLANET_WHATSAPP_TOKEN, VILLANET_WHATSAPP_PHONE_NUMBER_ID (usados en whatsappBotService.js)
 *
 * Recordatorio automatico de pago (antes del corte):
 *   WHATSAPP_TEMPLATE_RECORDATORIO_PAGO -> nombre del message template de Meta
 *     (aun no aprobado; mientras no este configurada esta variable, el
 *     recordatorio se omite en silencio sin afectar la suspension/reactivacion).
 *   VILLANET_DIAS_AVISO_PAGO -> dias antes del dia_corte del cliente en que se
 *     manda el recordatorio (default: 5).
 */

const cron = require('node-cron');
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');
const whatsappBot = require('./whatsappBotService');

const WHATSAPP_TEMPLATE_RECORDATORIO_PAGO = process.env.WHATSAPP_TEMPLATE_RECORDATORIO_PAGO;
const DIAS_AVISO_PAGO = parseInt(process.env.VILLANET_DIAS_AVISO_PAGO || '5', 10);

// Manda el recordatorio de pago (message template) si el cliente esta a
// exactamente DIAS_AVISO_PAGO dias de su dia_corte y aun no paga el mes.
async function enviarRecordatorioPagoSiAplica(cliente, yaPago) {
  if (yaPago || cliente.estado !== 'activo' || !cliente.telefono) return;
  if (!WHATSAPP_TEMPLATE_RECORDATORIO_PAGO) return; // template aun no aprobado en Meta

  const diasParaCorte = cliente.dia_corte - new Date().getDate();
  if (diasParaCorte !== DIAS_AVISO_PAGO) return;

  const monto = cliente.planes_isp ? parseFloat(cliente.planes_isp.precio) : 0;
  try {
    await whatsappBot.enviarWhatsAppTemplate(cliente.telefono, WHATSAPP_TEMPLATE_RECORDATORIO_PAGO, [
      cliente.nombre,
      `$${monto.toFixed(2)} MXN`,
    ]);
    console.log(`Recordatorio de pago enviado a ${cliente.nombre} (corte en ${DIAS_AVISO_PAGO} dias)`);
  } catch (err) {
    console.error(`Error enviando recordatorio de pago a ${cliente.nombre}:`, err.message);
  }
}

async function revisarPagosYActualizarServicio() {
  console.log(`[${new Date().toISOString()}] Iniciando revisión de pagos ISP...`);

  // Trae todos los clientes activos o suspendidos (no de baja)
  const { data: clientes, error } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre, precio)')
    .neq('estado', 'baja');

  if (error) {
    console.error('Error consultando clientes:', error);
    return;
  }

  const primerDiaMes = new Date();
  primerDiaMes.setDate(1);
  const mesActual = primerDiaMes.toISOString().slice(0, 10);

  for (const cliente of clientes) {
    // ¿Ya pagó el mes en curso?
    const { data: pago } = await supabase
      .from('pagos_isp')
      .select('id')
      .eq('cliente_id', cliente.id)
      .eq('mes_correspondiente', mesActual)
      .maybeSingle();

    const yaPago = !!pago;
    const hoyEsDiaDeCorte = new Date().getDate() >= cliente.dia_corte;

    await enviarRecordatorioPagoSiAplica(cliente, yaPago);

    try {
      if (!yaPago && hoyEsDiaDeCorte && cliente.estado === 'activo') {
        // Suspender
        await mikrotik.suspenderCliente(cliente.mikrotik_secret_name);
        await supabase
          .from('clientes_isp')
          .update({ estado: 'suspendido' })
          .eq('id', cliente.id);

        console.log(`Suspendido: ${cliente.nombre} (${cliente.mikrotik_secret_name})`);

        // if (cliente.telefono) {
        //   await enviarWhatsApp(cliente.telefono,
        //     `Hola ${cliente.nombre}, tu servicio de internet fue suspendido por falta de pago. ` +
        //     `Realiza tu pago para reactivarlo.`);
        // }
      }

      if (yaPago && cliente.estado === 'suspendido') {
        // Reactivar
        await mikrotik.reactivarCliente(cliente.mikrotik_secret_name);
        await supabase
          .from('clientes_isp')
          .update({ estado: 'activo' })
          .eq('id', cliente.id);

        console.log(`Reactivado: ${cliente.nombre} (${cliente.mikrotik_secret_name})`);

        // if (cliente.telefono) {
        //   await enviarWhatsApp(cliente.telefono,
        //     `Hola ${cliente.nombre}, tu pago fue confirmado y tu servicio de internet ` +
        //     `ha sido reactivado. ¡Gracias!`);
        // }
      }
    } catch (err) {
      console.error(`Error procesando cliente ${cliente.nombre}:`, err.message);
    }
  }

  console.log('Revisión de pagos ISP completada.');
}

// Corre todos los días a las 6:00 AM (hora del servidor)
cron.schedule('0 6 * * *', revisarPagosYActualizarServicio);

module.exports = { revisarPagosYActualizarServicio };
