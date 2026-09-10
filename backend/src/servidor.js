/* ═══════════════════════════════════════════════════════════════════
   BPM CONSULTING — BACKEND DE LA PLATAFORMA DE CONTACT CENTER

   Arranque del servidor. Aquí se juntan las piezas:

     config.js     qué host, qué base, qué claves
     bd.js         la conexión a MySQL
     auth.js       quién eres y qué puedes hacer
     rutas/        las operaciones, agrupadas por tema

   Para arrancar:  npm start
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const cors = require('cors');
const CONFIG = require('./config');
const bd = require('./bd');

const app = express();

/* ── Middlewares generales ───────────────────────────────────────────
   Se ejecutan en orden, antes de llegar a cualquier ruta.            */

app.use(cors());              // permite que el navegador llame desde otro puerto
app.use(express.json());      // entiende los cuerpos en JSON

/* Registro de peticiones: útil mientras se desarrolla */
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    const color = res.statusCode >= 500 ? '\x1b[31m'
                : res.statusCode >= 400 ? '\x1b[33m' : '\x1b[32m';
    console.log(`  ${color}${res.statusCode}\x1b[0m ${req.method} ${req.originalUrl} · ${ms} ms`);
  });
  next();
});


/* ── Rutas ───────────────────────────────────────────────────────── */

app.get('/api/salud', async (req, res) => {
  try {
    const version = await bd.probar();
    res.json({
      ok: true,
      base_de_datos: version,
      central_configurada: !!(CONFIG.pbx.wss && CONFIG.pbx.dominio),
      realtime: CONFIG.realtime,
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Sin conexión a la base de datos' });
  }
});

app.use('/api/sesion', require('./rutas/sesion'));
app.use('/api/usuarios', require('./rutas/usuarios'));
app.use('/api', require('./rutas/operacion'));


/* ── Errores ─────────────────────────────────────────────────────────
   Cualquier fallo no capturado llega aquí. Se registra completo en el
   servidor, pero al navegador solo se le manda un mensaje genérico:
   los detalles internos ayudan a quien quiera atacar.                 */

app.use((req, res) => {
  res.status(404).json({ error: 'Esa ruta no existe' });
});

app.use((err, req, res, next) => {
  console.error('\x1b[31m  ERROR\x1b[0m', err.message);
  console.error(err.stack);

  /* Errores de la base traducidos a algo entendible */
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'Ese registro ya existe' });
  }
  if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({ error: 'Se hace referencia a algo que no existe' });
  }

  res.status(500).json({ error: 'Error interno del servidor' });
});


/* ── Arranque ────────────────────────────────────────────────────── */

async function arrancar() {
  console.log();
  console.log('  BPM Consulting — Backend');
  console.log('  ' + '─'.repeat(50));

  try {
    const version = await bd.probar();
    console.log(`  Base de datos    ${version}`);
    console.log(`                   ${CONFIG.bd.usuario}@${CONFIG.bd.host}/${CONFIG.bd.base}`);
  } catch (e) {
    console.error('\x1b[31m  No se pudo conectar a la base de datos\x1b[0m');
    console.error('  ' + e.message);
    console.error('  Revisa las variables BD_* del archivo .env');
    process.exit(1);
  }

  console.log(`  Central          ${CONFIG.pbx.wss || '(sin configurar)'}`);
  console.log(`  Realtime         ${CONFIG.realtime ? 'activo' : 'desactivado'}`);

  app.listen(CONFIG.puerto, () => {
    console.log(`  Escuchando en    http://localhost:${CONFIG.puerto}`);
    console.log();
    console.log('  Ctrl+C para detener');
    console.log();
  });
}

if (require.main === module) arrancar();

module.exports = { app, arrancar };
