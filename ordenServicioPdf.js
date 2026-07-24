/**
 * ordenServicioPdf.js
 * VillaNet MX - Generador de PDF profesional para órdenes de servicio
 * Usa PDFKit (sin necesitar navegador headless, ligero para Render).
 */

const PDFDocument = require('pdfkit');

const AZUL = '#0B1B2B';
const VERDE = '#1E8A6E';
const GRIS = '#5B6B7C';

function generarPdfOrdenServicio(orden) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---------- Encabezado ----------
    doc
      .fillColor(AZUL)
      .fontSize(20)
      .font('Helvetica-Bold')
      .text('VillaNet MX', 40, 40);
    doc
      .fillColor(GRIS)
      .fontSize(9)
      .font('Helvetica')
      .text('Internet residencial · Conectamos tu mundo', 40, 64);

    doc
      .fillColor(AZUL)
      .fontSize(14)
      .font('Helvetica-Bold')
      .text('ORDEN DE SERVICIO', 350, 40, { align: 'right', width: 205 });
    doc
      .fillColor(GRIS)
      .fontSize(10)
      .font('Helvetica')
      .text(`Folio: ${orden.folio}`, 350, 60, { align: 'right', width: 205 });
    doc.text(
      `Emitido: ${new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })}`,
      350,
      74,
      { align: 'right', width: 205 }
    );

    doc.moveTo(40, 100).lineTo(555, 100).strokeColor(AZUL).lineWidth(1.5).stroke();

    // ---------- Datos del cliente ----------
    let y = 120;
    doc.fillColor(GRIS).fontSize(9).font('Helvetica-Bold').text('DATOS DEL CLIENTE', 40, y);
    y += 16;
    doc.fillColor('#101C2C').fontSize(13).font('Helvetica-Bold').text(orden.cliente_nombre || '—', 40, y);
    y += 18;
    doc.fillColor(GRIS).fontSize(10).font('Helvetica');
    doc.text(`Cuenta: ${orden.numero_cuenta || '—'}`, 40, y);
    y += 14;
    doc.text(`Dirección: ${orden.direccion || 'Sin dirección registrada'}`, 40, y);
    y += 14;
    doc.text(`Teléfono: ${orden.telefono || '—'}`, 40, y);

    // ---------- Datos de la cita ----------
    y += 34;
    doc.fillColor(GRIS).fontSize(9).font('Helvetica-Bold').text('DETALLES DE LA VISITA', 40, y);
    y += 18;

    const filas = [
      ['Tipo de servicio', capitalizar(orden.tipo_servicio)],
      ['Fecha programada', new Date(orden.fecha_cita + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })],
      ['Hora programada', orden.hora_cita],
      ['Técnico asignado', orden.tecnico || 'Por asignar'],
    ];

    filas.forEach(([label, valor]) => {
      doc.fillColor(GRIS).fontSize(9).font('Helvetica-Bold').text(label, 40, y, { continued: false });
      doc.fillColor('#101C2C').fontSize(11).font('Helvetica').text(valor, 220, y);
      y += 20;
    });

    // ---------- Descripción ----------
    y += 14;
    doc.fillColor(GRIS).fontSize(9).font('Helvetica-Bold').text('DESCRIPCIÓN DEL TRABAJO', 40, y);
    y += 16;
    doc
      .fillColor('#101C2C')
      .fontSize(10)
      .font('Helvetica')
      .text(orden.descripcion || 'Sin descripción adicional.', 40, y, { width: 515 });

    y = doc.y + 30;

    // ---------- Firmas ----------
    if (y > 680) y = 680;
    doc.moveTo(40, y).lineTo(240, y).strokeColor('#CCCCCC').lineWidth(1).stroke();
    doc.moveTo(320, y).lineTo(520, y).strokeColor('#CCCCCC').lineWidth(1).stroke();
    doc.fillColor(GRIS).fontSize(9).font('Helvetica').text('Firma del cliente', 40, y + 6);
    doc.text('Firma del técnico', 320, y + 6);

    // ---------- Pie ----------
    doc
      .fillColor(GRIS)
      .fontSize(8)
      .font('Helvetica')
      .text(
        'VillaNet MX — Este documento es un comprobante interno de servicio, no un comprobante fiscal.',
        40,
        760,
        { width: 515, align: 'center' }
      );

    doc.end();
  });
}

function capitalizar(texto) {
  if (!texto) return '—';
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

module.exports = { generarPdfOrdenServicio };
