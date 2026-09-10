/* ═══════════════════════════════════════════════════════════════════
   OPERACIÓN — campañas, contactos, tipificación e interacciones
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');
const asterisk = require('../asterisk');

const router = express.Router();
router.use(auth.exigirSesion);


/* ═══════════ CAMPAÑAS ═══════════ */

/* Cualquiera con sesión puede listarlas: el agente necesita saber la
   suya y el supervisor las que tiene a cargo. */
router.get('/campanas', async (req, res, next) => {
  try {
    res.json(await bd.consultar(
      `SELECT id, nombre, tipo, cola_asterisk, hora_apertura, hora_cierre,
              abierta, acw_segundos, activa
       FROM campana WHERE activa = TRUE ORDER BY nombre`));
  } catch (e) { next(e); }
});

router.post('/campanas', auth.exigir('campanas'), async (req, res, next) => {
  try {
    const { nombre, tipo, cola_asterisk, hora_apertura, hora_cierre, acw_segundos } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });

    const [r] = await bd.pool.execute(
      `INSERT INTO campana (nombre, tipo, cola_asterisk, hora_apertura, hora_cierre, acw_segundos)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nombre, tipo || 'entrante', cola_asterisk || null,
       hora_apertura || '08:00:00', hora_cierre || '18:00:00', acw_segundos || 60]
    );

    await auth.auditar(req.usuario.id, 'crear', 'campana', r.insertId,
      `Creó la campaña ${nombre}`, req.ip);
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

/* Abrir o cerrar la campaña. Es la acción del panel de supervisión. */
router.put('/campanas/:id/horario', auth.exigir('supervision'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await auth.puedeVerCampana(req.usuario, id))) {
      return res.status(403).json({ error: 'Esa campaña no está a tu cargo' });
    }

    const c = await bd.una('SELECT nombre, abierta FROM campana WHERE id = ?', [id]);
    if (!c) return res.status(404).json({ error: 'La campaña no existe' });

    const nueva = !c.abierta;
    await bd.consultar('UPDATE campana SET abierta = ? WHERE id = ?', [nueva, id]);

    await auth.auditar(req.usuario.id, 'modificar', 'campana', id,
      `${nueva ? 'Abrió' : 'Cerró'} la campaña ${c.nombre}`, req.ip);

    res.json({ abierta: nueva });
  } catch (e) { next(e); }
});


/* ═══════════ CONTACTOS ═══════════ */

/* Búsqueda por número: es la consulta que corre en CADA llamada
   entrante, antes de que el agente conteste. Por eso la tabla tiene
   índice por teléfono. */
router.get('/contactos/telefono/:numero', async (req, res, next) => {
  try {
    const numero = String(req.params.numero).replace(/\D/g, '');
    const c = await bd.una(
      /* Los alias coinciden con los nombres que usa la ficha del
         agente en el frontend, así no hay que traducir en el navegador. */
      `SELECT id,
              nombre         AS nom,
              tipo_documento AS tipoDoc,
              documento      AS doc,
              telefono       AS n,
              telefono_alt   AS tel2,
              correo         AS cor,
              ciudad         AS ciu,
              descripcion    AS \`desc\`
       FROM contacto WHERE telefono = ? LIMIT 1`,
      [numero]
    );
    if (!c) return res.status(404).json({ error: 'Contacto no encontrado', numero });

    /* Se adjuntan sus últimas gestiones: el agente ve el contexto */
    c.historial = await bd.consultar(
      `SELECT i.inicio, i.direccion, i.segundos_total,
              CONCAT(t.categoria, IFNULL(CONCAT(' · ', t.subcategoria), '')) AS tipificacion
       FROM interaccion i
       LEFT JOIN tipificacion t ON t.id = i.tipificacion_id
       WHERE i.contacto_id = ? ORDER BY i.inicio DESC LIMIT 5`,
      [c.id]
    );

    res.json(c);
  } catch (e) { next(e); }
});

router.get('/contactos', async (req, res, next) => {
  try {
    const q = `%${(req.query.buscar || '').trim()}%`;
    res.json(await bd.consultar(
      `SELECT id, nombre, documento, telefono, ciudad, plan, estado_cuenta
       FROM contacto
       WHERE nombre LIKE ? OR telefono LIKE ? OR documento LIKE ?
       ORDER BY nombre LIMIT 100`,
      [q, q, q]
    ));
  } catch (e) { next(e); }
});


/* ═══════════ TIPIFICACIÓN ═══════════ */

/* El catálogo de la campaña del agente. Es lo que llena el selector. */
router.get('/tipificacion', async (req, res, next) => {
  try {
    const campana = req.query.campana_id || req.usuario.campana_id;
    res.json(await bd.consultar(
      `SELECT id, categoria, subcategoria, efectiva, requiere_agenda
       FROM tipificacion
       WHERE activa = TRUE AND (campana_id = ? OR campana_id IS NULL)
       ORDER BY orden, categoria`,
      [campana]
    ));
  } catch (e) { next(e); }
});


/* ═══════════ INTERACCIONES ═══════════ */

/* Guardar la tipificación al terminar la llamada.
   El linkedid viene de Asterisk: es lo que agrupa los tramos de una
   llamada transferida en una sola interacción. */
router.post('/interacciones/:linkedid/tipificar', auth.exigir('tipificar'),
  async (req, res, next) => {
    try {
      const { linkedid } = req.params;
      const { tipificacion_id, observaciones, agenda } = req.body;

      const i = await bd.una('SELECT id FROM interaccion WHERE linkedid = ?', [linkedid]);
      if (!i) return res.status(404).json({ error: 'La interacción no existe' });

      await bd.consultar(
        `UPDATE interaccion
         SET tipificacion_id = ?, observaciones = ?, agenda = ?
         WHERE id = ?`,
        [tipificacion_id || null, observaciones || null, agenda || null, i.id]
      );

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* El historial del agente durante su turno */
router.get('/interacciones/mias', async (req, res, next) => {
  try {
    res.json(await bd.consultar(
      `SELECT i.linkedid, i.numero, i.direccion, i.inicio, i.segundos_total,
              i.contestada, c.nombre AS contacto,
              CONCAT(t.categoria, IFNULL(CONCAT(' · ', t.subcategoria), '')) AS tipificacion
       FROM tramo tr
       JOIN interaccion i ON i.id = tr.interaccion_id
       LEFT JOIN contacto c ON c.id = i.contacto_id
       LEFT JOIN tipificacion t ON t.id = i.tipificacion_id
       WHERE tr.usuario_id = ? AND DATE(tr.inicio) = CURDATE()
       ORDER BY tr.inicio DESC`,
      [req.usuario.id]
    ));
  } catch (e) { next(e); }
});


/* ═══════════ PAUSAS ═══════════ */

router.get('/pausas/tipos', async (req, res, next) => {
  try {
    res.json(await bd.consultar(
      'SELECT id, nombre, productiva, limite_minutos FROM pausa_tipo ORDER BY id'));
  } catch (e) { next(e); }
});

router.post('/pausas', async (req, res, next) => {
  try {
    const { pausa_tipo_id } = req.body;

    /* Se cierra cualquier pausa abierta antes de empezar otra */
    await bd.consultar(
      'UPDATE pausa SET fin = NOW() WHERE usuario_id = ? AND fin IS NULL',
      [req.usuario.id]
    );

    if (!pausa_tipo_id) return res.json({ ok: true, disponible: true });

    const [r] = await bd.pool.execute(
      'INSERT INTO pausa (usuario_id, pausa_tipo_id, inicio) VALUES (?, ?, NOW())',
      [req.usuario.id, pausa_tipo_id]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

module.exports = router;
