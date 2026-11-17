/**
 * estadoCuentaPdf.js
 * VillaNet MX - Estado de cuenta del cliente en PDF (PDFKit).
 * Nombre, direccion, servicio contratado, desglose de pagos de los ultimos
 * meses, adeudo y formas de pago (tarjeta y transferencia).
 */
const PDFDocument = require('pdfkit');

const AZUL = '#0B3D91';
const VERDE = '#1E8A3A';
const ROJO = '#B3261E';
const GRIS = '#5B6B7C';
const NEGRO = '#101C2C';
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function nombreMes(clave) {
  const [a, m] = clave.split('-').map(Number);
  return `${MESES[m - 1]} ${a}`;
}
function dinero(n) {
  return '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length <= 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Mexico_City' });
}
const METODO = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', spei: 'Transferencia SPEI',
  openpay_spei: 'Transferencia SPEI', openpay_tarjeta: 'Tarjeta', clip_tarjeta: 'Tarjeta (Clip)', tarjeta: 'Tarjeta',
};

/**
 * @param {object} d { cliente, pagos, mesesPendientes, precio, linkPago, banco }
 */
function generarEstadoCuentaPdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 96;
    const c = d.cliente;
    const plan = c.planes_isp || {};

    // Encabezado
    doc.rect(0, 0, doc.page.width, 86).fill(AZUL);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text('VillaNet MX', 48, 26);
    doc.font('Helvetica').fontSize(9).text('Internet residencial · Conectando tu mundo', 48, 54);
    doc.font('Helvetica-Bold').fontSize(14).text('ESTADO DE CUENTA', 48, 28, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(9).text(`Emitido: ${fechaCorta(new Date().toISOString())}`, 48, 50, { width: W, align: 'right' });

    // Datos del cliente y servicio
    let y = 110;
    doc.fillColor(GRIS).font('Helvetica-Bold').fontSize(8).text('CLIENTE', 48, y);
    doc.text('SERVICIO CONTRATADO', 48 + W / 2, y);
    y += 14;
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(13).text(c.nombre || '—', 48, y, { width: W / 2 - 12 });
    doc.text(`Plan ${plan.nombre || '—'}`, 48 + W / 2, y, { width: W / 2 });
    y += 20;
    doc.font('Helvetica').fontSize(10).fillColor(NEGRO);
    const izq = [
      `Cuenta: ${c.numero_cuenta || '—'}`,
      `Dirección: ${c.direccion || '—'}`,
      `Teléfono: ${c.telefono || '—'}`,
    ];
    const der = [
      `Mensualidad: ${dinero(plan.precio)} MXN`,
      `Fecha de pago: día ${c.dia_corte || '—'} de cada mes`,
      `Cliente desde: ${fechaCorta(c.fecha_alta)}`,
      `Estado: ${c.estado === 'activo' ? 'Activo' : c.estado === 'suspendido' ? 'Suspendido' : c.estado || '—'}`,
    ];
    let yi = y;
    izq.forEach((t) => { doc.text(t, 48, yi, { width: W / 2 - 12 }); yi = doc.y + 3; });
    let yd = y;
    der.forEach((t) => { doc.text(t, 48 + W / 2, yd, { width: W / 2 }); yd = doc.y + 3; });
    y = Math.max(yi, yd) + 14;

    // Resumen de adeudo
    const total = d.mesesPendientes.length * d.precio;
    const alCorriente = total <= 0;
    doc.roundedRect(48, y, W, 54, 8).fill(alCorriente ? '#E8F5EA' : '#FDECEA');
    doc.fillColor(alCorriente ? VERDE : ROJO).font('Helvetica-Bold').fontSize(16)
      .text(alCorriente ? 'Estás al corriente' : `Saldo pendiente: ${dinero(total)} MXN`, 64, y + 12, { width: W - 32 });
    doc.font('Helvetica').fontSize(10).fillColor(NEGRO)
      .text(alCorriente ? '¡Gracias por tu pago puntual!' : `${d.mesesPendientes.length} mes(es): ${d.mesesPendientes.map(nombreMes).join(', ')}`, 64, y + 33, { width: W - 32 });
    y += 72;

    // Desglose de pagos
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(12).text('Desglose de mensualidades', 48, y);
    y += 20;
    const cols = [48, 200, 300, 420];
    doc.rect(48, y, W, 20).fill('#EEF3F8');
    doc.fillColor(GRIS).font('Helvetica-Bold').fontSize(9);
    ['Mes', 'Estado', 'Fecha de pago', 'Método / Monto'].forEach((h, i) => doc.text(h, cols[i] + 6, y + 6));
    y += 24;
    doc.font('Helvetica').fontSize(10);
    for (const fila of d.filas) {
      if (y > doc.page.height - 190) { doc.addPage(); y = 60; }
      doc.fillColor(NEGRO).text(nombreMes(fila.mes), cols[0] + 6, y);
      doc.fillColor(fila.pagado ? VERDE : ROJO).font('Helvetica-Bold').text(fila.pagado ? 'Pagado' : 'Pendiente', cols[1] + 6, y);
      doc.font('Helvetica').fillColor(NEGRO).text(fila.pagado ? fechaCorta(fila.fecha) : '—', cols[2] + 6, y);
      doc.text(fila.pagado ? `${METODO[fila.metodo] || fila.metodo || '—'} · ${dinero(fila.monto)}` : dinero(d.precio), cols[3] + 6, y);
      y += 18;
      doc.moveTo(48, y - 4).lineTo(48 + W, y - 4).strokeColor('#E3EAF2').lineWidth(1).stroke();
    }

    // Formas de pago
    y += 14;
    if (y > doc.page.height - 170) { doc.addPage(); y = 60; }
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(12).text('Formas de pago', 48, y);
    y += 20;
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text('Tarjeta de débito o crédito', 48, y);
    doc.font('Helvetica').fillColor(GRIS).text('Escribe "pagar" a nuestro WhatsApp 56 6857 4395 y recibe tu link seguro de pago. Se aplica al instante.', 48, y + 14, { width: W / 2 - 12 });
    if (d.banco && d.banco.clabe) {
      doc.fillColor(NEGRO).font('Helvetica-Bold').text('Transferencia', 48 + W / 2, y);
      doc.font('Helvetica').fillColor(GRIS).text(
        `${d.banco.banco || ''}\nCLABE: ${d.banco.clabe}\nA nombre de: ${d.banco.titular || 'Internet VillaNet'}\nEnvía tu comprobante por WhatsApp con tu número de cuenta.`,
        48 + W / 2, y + 14, { width: W / 2 }
      );
    }

    // Pie
    doc.fillColor(GRIS).fontSize(8).font('Helvetica')
      .text('VillaNet MX · WhatsApp 56 6857 4395 · Atención 24 horas por WhatsApp. Documento informativo, no es comprobante fiscal.',
        48, doc.page.height - 60, { width: W, align: 'center' });
    doc.end();
  });
}

module.exports = { generarEstadoCuentaPdf };
