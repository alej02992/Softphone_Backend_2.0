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
      `SELECT id, nombre, tipo, cola_asterisk, did, formulario_id,
              hora_apertura, hora_cierre, abierta, acw_segundos, activa
       FROM campana WHERE activa = TRUE ORDER BY nombre`));
  } catch (e) { next(e); }
});

router.post('/campanas', auth.exigir('campanas'), async (req, res, next) => {
  try {
    const { nombre, tipo, cola_asterisk, did, formulario_id,
            hora_apertura, hora_cierre, acw_segundos } = req.body;

    if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la campaña' });
    if (!cola_asterisk) return res.status(400).json({ error: 'Falta la cola de Asterisk' });

    /* Una campaña que recibe llamadas necesita un número por donde
       entren. Sin él, no hay forma de enrutar hacia ella. */
    if (tipo !== 'saliente' && !did) {
      return res.status(400).json({ error: 'Una campaña de entrada necesita un DID' });
    }

    const repetida = await bd.una(
      'SELECT id FROM campana WHERE nombre = ? OR cola_asterisk = ?',
      [nombre, cola_asterisk]);
    if (repetida) {
      return res.status(409).json({ error: 'Ya existe una campaña con ese nombre o esa cola' });
    }

    const r = await bd.transaccion(async (cx) => {
      const [ins] = await cx.execute(
        `INSERT INTO campana (nombre, tipo, cola_asterisk, did, formulario_id,
                              hora_apertura, hora_cierre, acw_segundos)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [nombre, tipo || 'entrante', cola_asterisk, did || null, formulario_id || null,
         hora_apertura || '08:00:00', hora_cierre || '18:00:00', acw_segundos || 60]
      );

      /* La cola en Asterisk. El tiempo de cierre de la cola debe
         coincidir con el de la plataforma, o el agente recibiría una
         llamada nueva mientras aún está tipificando. */
      const cola = await asterisk.crearCola(cx, {
        nombre: cola_asterisk,
        wrapuptime: acw_segundos || 60,
      });

      return { id: ins.insertId, colaCreada: cola.creada, motivo: cola.motivo };
    });

    await auth.auditar(req.usuario.id, 'crear', 'campana', r.id,
      `Creó la campaña ${nombre} sobre la cola ${cola_asterisk}`, req.ip);
    res.status(201).json(r);
  } catch (e) { next(e); }
});

/* Modificar una campaña. */
router.put('/campanas/:id', auth.exigir('campanas'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const c = await bd.una('SELECT nombre, cola_asterisk FROM campana WHERE id = ?', [id]);
    if (!c) return res.status(404).json({ error: 'La campaña no existe' });

    const campos = [];
    const valores = [];
    const permitidos = ['nombre', 'tipo', 'did', 'formulario_id',
                        'hora_apertura', 'hora_cierre', 'acw_segundos'];

    permitidos.forEach((k) => {
      if (req.body[k] !== undefined) { campos.push(`${k} = ?`); valores.push(req.body[k] || null); }
    });

    if (!campos.length) return res.status(400).json({ error: 'No hay nada que cambiar' });

    valores.push(id);
    await bd.consultar(`UPDATE campana SET ${campos.join(', ')} WHERE id = ?`, valores);

    /* Si cambió el tiempo de cierre, se ajusta también en la cola */
    if (req.body.acw_segundos !== undefined && c.cola_asterisk) {
      await bd.consultar('UPDATE queues SET wrapuptime = ? WHERE name = ?',
        [req.body.acw_segundos, c.cola_asterisk]).catch(() => {});
    }

    await auth.auditar(req.usuario.id, 'modificar', 'campana', id,
      `Modificó la campaña ${c.nombre}`, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Desactivar una campaña. No se borra: sus interacciones deben
   conservarse para los reportes históricos. */
router.delete('/campanas/:id', auth.exigir('campanas'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const c = await bd.una('SELECT nombre, cola_asterisk FROM campana WHERE id = ?', [id]);
    if (!c) return res.status(404).json({ error: 'La campaña no existe' });

    const enUso = await bd.una(
      'SELECT COUNT(*) AS n FROM usuario WHERE campana_id = ? AND activo = TRUE', [id]);
    if (enUso.n > 0) {
      return res.status(409).json({
        error: `Hay ${enUso.n} usuario(s) asignados a esta campaña. Reasígnalos primero.` });
    }

    await bd.transaccion(async (cx) => {
      await cx.execute('UPDATE campana SET activa = FALSE, abierta = FALSE WHERE id = ?', [id]);
      if (c.cola_asterisk) await asterisk.eliminarCola(cx, c.cola_asterisk);
    });

    await auth.auditar(req.usuario.id, 'eliminar', 'campana', id,
      `Desactivó la campaña ${c.nombre}`, req.ip);
    res.json({ ok: true });
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
    /* La plataforma envía el nombre de la pausa, no un identificador.
       Es lo natural desde el navegador y además permite los estados
       personalizados, donde el agente escribe su propio motivo. */
    const { tipo, entrando, pausa_tipo_id } = req.body;

    /* Se cierra cualquier pausa abierta antes de empezar otra */
    await bd.consultar(
      'UPDATE pausa SET fin = NOW() WHERE usuario_id = ? AND fin IS NULL',
      [req.usuario.id]
    );

    /* Volver a disponible: no se abre pausa nueva */
    if (entrando === false || (!tipo && !pausa_tipo_id)) {
      return res.json({ ok: true, disponible: true });
    }

    let tipoId = pausa_tipo_id;

    if (!tipoId) {
      const nombre = String(tipo).trim().slice(0, 60);
      if (nombre.length < 3) {
        return res.status(400).json({ error: 'El motivo de la pausa es demasiado corto' });
      }

      const existe = await bd.una('SELECT id FROM pausa_tipo WHERE nombre = ?', [nombre]);

      if (existe) {
        tipoId = existe.id;
      } else {
        /* Estado personalizado: se registra como un tipo más, para que
           aparezca en los reportes con el nombre que escribió el
           agente en lugar de perderse. */
        const [ins] = await bd.pool.execute(
          'INSERT INTO pausa_tipo (nombre, productiva) VALUES (?, FALSE)', [nombre]);
        tipoId = ins.insertId;
      }
    }

    const [r] = await bd.pool.execute(
      'INSERT INTO pausa (usuario_id, pausa_tipo_id, inicio) VALUES (?, ?, NOW())',
      [req.usuario.id, tipoId]
    );

    res.status(201).json({ id: r.insertId, pausa_tipo_id: tipoId });
  } catch (e) { next(e); }
});

module.exports = router;
