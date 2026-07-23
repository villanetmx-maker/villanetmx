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
 *   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID (reutilizar los que ya usas en La Pape)
 */

const cron = require('node-cron');
const supabase = require('./supabaseClient');
const mikrotik = require('./mikrotikService');
// const { enviarWhatsApp } = require('./whatsappService'); // reutilizar el que ya tienes en La Pape

async function revisarPagosYActualizarServicio() {
  console.log(`[${new Date().toISOString()}] Iniciando revisión de pagos ISP...`);

  // Trae todos los clientes activos o suspendidos (no de baja)
  const { data: clientes, error } = await supabase
    .from('clientes_isp')
    .select('*, planes_isp(nombre)')
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
