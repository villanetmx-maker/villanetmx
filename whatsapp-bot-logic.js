/**
 * VillaNet MX - Lógica del bot de WhatsApp
 * ------------------------------------------
 * Módulo autocontenido para integrar en el backend Node.js existente
 * (repo villanetmx-maker/villanetmx, servicio Render "villanet-backend").
 *
 * Supuestos (ajustar a la estructura real del proyecto):
 *   - Ya existe una ruta /webhook/whatsapp en el backend (usada para la
 *     verificación de Meta). Este módulo exporta un handler para el
 *     método POST de esa misma ruta.
 *   - Ya existe un cliente de Supabase inicializado en el proyecto
 *     (por ejemplo en `lib/supabase.js`), con la service_role key.
 *   - Existe una tabla `clientes_isp` con al menos: id, nombre, telefono,
 *     saldo, estatus (activo/suspendido/moroso), plan.
 *   - Las tablas `whatsapp_sesiones` y `reportes_falla` ya fueron creadas
 *     en Supabase (ver actualizacion-whatsapp-bot-25jul2026.md).
 *
 * Variables de entorno usadas (ya configuradas en Render):
 *   - VILLANET_WHATSAPP_TOKEN
 *   - VILLANET_WHATSAPP_PHONE_NUMBER_ID
 *   - VILLANET_WHATSAPP_VERIFY_TOKEN
 */

const VILLANET_WHATSAPP_TOKEN = process.env.VILLANET_WHATSAPP_TOKEN;
const VILLANET_WHATSAPP_PHONE_NUMBER_ID = process.env.VILLANET_WHATSAPP_PHONE_NUMBER_ID;
const GRAPH_API_VERSION = "v25.0";

// ---------------------------------------------------------------------
// Envío de mensajes de WhatsApp (texto simple)
// ---------------------------------------------------------------------
async function enviarMensajeWhatsApp(telefono, texto) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${VILLANET_WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VILLANET_WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: telefono,
      type: "text",
      text: { body: texto },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Error al enviar mensaje de WhatsApp:", err);
  }

  return res.ok;
}

// ---------------------------------------------------------------------
// Manejo de sesión (whatsapp_sesiones)
// ---------------------------------------------------------------------
async function obtenerOCrearSesion(supabase, telefono) {
  const { data: existente, error: errBusqueda } = await supabase
    .from("whatsapp_sesiones")
    .select("*")
    .eq("telefono", telefono)
    .maybeSingle();

  if (errBusqueda) throw errBusqueda;
  if (existente) return existente;

  const { data: nueva, error: errInsert } = await supabase
    .from("whatsapp_sesiones")
    .insert({ telefono, paso_actual: "menu_inicial", contexto: {} })
    .select()
    .single();

  if (errInsert) throw errInsert;
  return nueva;
}

async function actualizarSesion(supabase, telefono, cambios) {
  const { error } = await supabase
    .from("whatsapp_sesiones")
    .update({ ...cambios, ultima_interaccion: new Date().toISOString() })
    .eq("telefono", telefono);

  if (error) throw error;
}

async function buscarClientePorTelefono(supabase, telefono) {
  const { data, error } = await supabase
    .from("clientes_isp")
    .select("*")
    .eq("telefono", telefono)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Textos del menú
// ---------------------------------------------------------------------
const MENU_PRINCIPAL = `¡Hola! 👋 Soy el asistente de VillaNet MX.

¿En qué te puedo ayudar hoy?

1️⃣ Reportar una falla de servicio
2️⃣ Consultar mi saldo / estado de cuenta
3️⃣ Hablar con soporte técnico

Responde con el número de la opción.`;

// ---------------------------------------------------------------------
// Máquina de estados de la conversación
// ---------------------------------------------------------------------
async function procesarMensajeEntrante(supabase, telefono, textoRecibido) {
  const sesion = await obtenerOCrearSesion(supabase, telefono);
  const texto = (textoRecibido || "").trim();

  switch (sesion.paso_actual) {
    case "menu_inicial": {
      if (texto === "1") {
        await actualizarSesion(supabase, telefono, { paso_actual: "reportar_falla" });
        await enviarMensajeWhatsApp(
          telefono,
          "Entendido. Cuéntame brevemente qué problema tienes (sin internet, " +
            "internet lento, router sin luces, etc.)."
        );
      } else if (texto === "2") {
        await manejarConsultaSaldo(supabase, telefono);
      } else if (texto === "3") {
        await actualizarSesion(supabase, telefono, { paso_actual: "esperando_soporte" });
        await enviarMensajeWhatsApp(
          telefono,
          "Un técnico de VillaNet MX te contactará en breve. Mientras tanto, " +
            "¿puedes describir tu problema?"
        );
      } else {
        await enviarMensajeWhatsApp(telefono, MENU_PRINCIPAL);
      }
      break;
    }

    case "reportar_falla": {
      await actualizarSesion(supabase, telefono, {
        paso_actual: "falla_confirmada",
        contexto: { ...sesion.contexto, descripcion_falla: texto },
      });

      const clienteReportante = await buscarClientePorTelefono(supabase, telefono);
      const { error: errReporte } = await supabase.from("reportes_falla").insert({
        telefono,
        cliente_id: clienteReportante?.id ?? null,
        descripcion: texto,
        estatus: "pendiente",
      });
      if (errReporte) console.error("Error al insertar reporte de falla:", errReporte);

      await enviarMensajeWhatsApp(
        telefono,
        `Gracias, registramos tu reporte: "${texto}".\n\n` +
          "Un técnico revisará tu caso. Te avisaremos por este medio cuando " +
          "haya una actualización.\n\n" +
          "Escribe *menu* en cualquier momento para volver al menú principal."
      );
      await actualizarSesion(supabase, telefono, { paso_actual: "menu_inicial" });
      break;
    }

    case "esperando_soporte": {
      // TODO: notificar a un canal interno (correo, Slack, etc.) con el
      // teléfono y el mensaje del cliente para que soporte le llame.
      await enviarMensajeWhatsApp(
        telefono,
        "Gracias, tu mensaje fue enviado al equipo de soporte. " +
          "Escribe *menu* para volver al menú principal."
      );
      await actualizarSesion(supabase, telefono, { paso_actual: "menu_inicial" });
      break;
    }

    default: {
      await actualizarSesion(supabase, telefono, { paso_actual: "menu_inicial" });
      await enviarMensajeWhatsApp(telefono, MENU_PRINCIPAL);
    }
  }

  if (texto.toLowerCase() === "menu") {
    await actualizarSesion(supabase, telefono, { paso_actual: "menu_inicial" });
    await enviarMensajeWhatsApp(telefono, MENU_PRINCIPAL);
  }
}

async function manejarConsultaSaldo(supabase, telefono) {
  const cliente = await buscarClientePorTelefono(supabase, telefono);

  if (!cliente) {
    await enviarMensajeWhatsApp(
      telefono,
      "No encontré una cuenta asociada a este número. Si crees que esto es un " +
        "error, escribe *3* para hablar con soporte."
    );
    return;
  }

  const estatus = cliente.estatus === "activo" ? "✅ Activo" : `⚠️ ${cliente.estatus}`;

  await enviarMensajeWhatsApp(
    telefono,
    `Hola ${cliente.nombre}, este es tu estado de cuenta:\n\n` +
      `Plan: ${cliente.plan}\n` +
      `Saldo: $${cliente.saldo}\n` +
      `Estatus: ${estatus}\n\n` +
      "Escribe *menu* para volver al menú principal."
  );

  await actualizarSesion(supabase, telefono, { paso_actual: "menu_inicial" });
}

// ---------------------------------------------------------------------
// Handler de webhook (POST /webhook/whatsapp)
// ---------------------------------------------------------------------
async function manejarWebhookWhatsApp(req, res, supabase) {
  try {
    const entry = req.body?.entry?.[0];
    const cambio = entry?.changes?.[0]?.value;
    const mensaje = cambio?.messages?.[0];

    if (!mensaje) {
      return res.sendStatus(200);
    }

    const telefono = mensaje.from;
    const texto = mensaje.text?.body || "";

    await procesarMensajeEntrante(supabase, telefono, texto);

    res.sendStatus(200);
  } catch (err) {
    console.error("Error procesando webhook de WhatsApp:", err);
    res.sendStatus(200);
  }
}

module.exports = {
  manejarWebhookWhatsApp,
  procesarMensajeEntrante,
  enviarMensajeWhatsApp,
};
