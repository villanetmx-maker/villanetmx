/**
 * index.js
 * VillaNet MX - Backend principal
 * Arranca el servidor web (para futuros webhooks/endpoints) y el cron de cortes.
 */

const express = require('express');
const app = express();
app.use(express.json());

// Arranca el cron de revisión de pagos/cortes automáticos
require('./cronCorteISP');

// Endpoint simple de salud, para confirmar que el servicio está vivo
app.get('/', (req, res) => {
  res.send('VillaNet MX backend activo');
});

// Endpoint de prueba manual: ver estado de conexión de un cliente
// Ejemplo de uso: GET /estado/cliente001
const mikrotik = require('./mikrotikService');
app.get('/estado/:secretName', async (req, res) => {
  try {
    const estado = await mikrotik.estadoConexion(req.params.secretName);
    res.json(estado);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ENDPOINTS TEMPORALES DE PRUEBA - quitar después de validar
app.get('/test-suspender/:secretName', async (req, res) => {
  try {
    const resultado = await mikrotik.suspenderCliente(req.params.secretName);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get('/test-reactivar/:secretName', async (req, res) => {
  try {
    const resultado = await mikrotik.reactivarCliente(req.params.secretName);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VillaNet MX backend corriendo en puerto ${PORT}`);
});
