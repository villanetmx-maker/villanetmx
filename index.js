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
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VillaNet MX backend corriendo en puerto ${PORT}`);
});
