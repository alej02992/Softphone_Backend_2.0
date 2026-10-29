/* ═══════════════════════════════════════════════════════════════════
   ESTADOS DE PAUSA

   Los estados los define el supervisor, no el agente. El supervisor
   crea un estado ("Capacitación", "Reunión"…), lo activa, y a partir
   de ese momento aparece como botón en el panel de todos los agentes.
   Si lo desactiva, deja de aparecer.

   El agente solo puede usar estados activos: ya no escribe los suyos.

   Hay dos clases de estados:

     Básicos     los generales (break, almuerzo, baño, reunión…). Los ven
                 todas las campañas y NO se pueden borrar ni desactivar.
                 Lo único que cambia es su duración, y cada campaña puede
                 tener la suya (tabla pausa_limite_campana). Si no tiene,
                 usa la duración general.
     Propios     los que crea un supervisor para una campaña. Se crean,
                 cambian y borran libremente.

   Este archivo se monta ANTES que operacion.js, así que su ruta
   POST /pausas es la que atiende las peticiones y reemplaza a la
   anterior, que creaba estados nuevos con cualquier texto.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

/* ═══════════ A QUÉ CAMPAÑAS ALCANZA CADA QUIEN ═══════════

   El administrador manda sobre todas. El supervisor, solo sobre las
   suyas: las de la tabla `usuario_campana` y, si no tiene ninguna
   asignada ahí, la de su ficha.

   Devuelve null cuando no hay límite (administrador). */
async function campanasDe(usuario) {
  if (usuario.rol === 'admin') return null;

  const filas = await bd.consultar(
    'SELECT campana_id FROM usuario_campana WHERE usuario_id = ?', [usuario.id]);
  const ids = filas.map((f) => f.campana_id);

  if (!ids.length) {
    const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [usuario.id]);
    if (yo?.campana_id) ids.push(yo.campana_id);
  }
  return ids;
}

/* ═══════════ LA DURACIÓN QUE APLICA ═══════════
   La de la campaña si la tiene, si no la general. Ojo: una fila con
   limite_minutos vacío quiere decir "sin límite en esta campaña", que no
   es lo mismo que no tener fila. Por eso se mira si existe la fila, no
   si el valor está vacío.

   Uso: unir pausa_limite_campana como `plc` y poner LIMITE_EFECTIVO
   donde antes iba t.limite_minutos.                                     */
const LIMITE_EFECTIVO = (t = 't') =>
  `IF(plc.pausa_tipo_id IS NULL, ${t}.limite_minutos, plc.limite_minutos)`;

/* Las campañas sobre las que puede crear estados. El desplegable de la
   plataforma se llena con esto. */
router.get('/pausas/campanas', auth.exigirSesion, auth.exigir('supervision'),
  async (req, res, next) => {
    try {
      const mias = await campanasDe(req.usuario);

      if (mias === null) {
        const todas = await bd.consultar(
          'SELECT id, nombre FROM campana WHERE activa = TRUE ORDER BY nombre');
        return res.json({ general: true, campanas: todas });
      }
      if (!mias.length) return res.json({ general: false, campanas: [] });

      const campanas = await bd.consultar(
        `SELECT id, nombre FROM campana WHERE activa = TRUE AND id IN (${mias.map(() => '?').join(',')}) ORDER BY nombre`,
        mias);
      res.json({ general: false, campanas });
    } catch (e) { next(e); }
  });

/* ═══════════ LISTAR ═══════════
   Cualquier usuario con sesión: el agente la usa para pintar sus
   botones. El supervisor pide también los inactivos con ?todos=1. */
/** Cierra las pausas que quedaron abiertas de una sesión anterior.

    Si alguien cierra sesión —o se le vence— mientras está en pausa,
    esa fila se queda sin `fin` y el agente aparece en ese estado para
    siempre. Se limpian aquí porque el agente pide sus estados justo
    después de entrar. */
async function cerrarPausasHuerfanas(usuarioId) {
  await bd.consultar(
    `UPDATE pausa p
        SET p.fin = COALESCE(
              (SELECT MAX(s.cerrada) FROM sesion s
                WHERE s.usuario_id = p.usuario_id AND s.cerrada IS NOT NULL
                  AND s.cerrada > p.inicio),
              p.inicio)
      WHERE p.usuario_id = ?
        AND p.fin IS NULL
        AND p.inicio < COALESCE(
              (SELECT MIN(s.inicio) FROM sesion s
                WHERE s.usuario_id = p.usuario_id AND s.cerrada IS NULL AND s.vence > NOW()),
              NOW())`,
    [usuarioId]);
}

router.get('/pausas/tipos', auth.exigirSesion, async (req, res, next) => {
  try {
    await cerrarPausasHuerfanas(req.usuario.id);
    /* El supervisor pide la lista completa para administrarla; el
       agente recibe solo los estados activos que le corresponden: los
       generales y los de su campaña. */
    const todos = req.query.todos === '1' &&
      (req.usuario.permisos || []).includes('supervision');

    let sql, val;

    if (!todos) {
      /* El agente: cada estado con la duración de SU campaña */
      const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [req.usuario.id]);
      const mia = yo?.campana_id || 0;
      sql = `SELECT t.id, t.nombre, t.productiva, ${LIMITE_EFECTIVO()} AS limite_minutos, t.activo,
                    t.campana_id, c.nombre AS campana
               FROM pausa_tipo t
               LEFT JOIN campana c ON c.id = t.campana_id
               LEFT JOIN pausa_limite_campana plc ON plc.pausa_tipo_id = t.id AND plc.campana_id = ?
              WHERE t.activo = TRUE AND (t.campana_id IS NULL OR t.campana_id = ?)`;
      val = [mia, mia];
    } else {
      sql = `SELECT t.id, t.nombre, t.productiva, t.limite_minutos, t.activo,
                    t.campana_id, c.nombre AS campana
               FROM pausa_tipo t
               LEFT JOIN campana c ON c.id = t.campana_id`;
      val = [];
    }

    sql += ' ORDER BY t.campana_id IS NULL DESC, t.id';

    const filas = await bd.consultar(sql, val);
    const mias = todos ? await campanasDe(req.usuario) : null;

    /* Para administrar: la duración de cada básico en cada campaña que
       ve quien pregunta. */
    const porCampana = new Map();
    if (todos) {
      const cond = mias === null ? '' : mias.length ? ` WHERE campana_id IN (${mias.map(() => '?').join(',')})` : ' WHERE 1 = 0';
      (await bd.consultar(`SELECT pausa_tipo_id, campana_id, limite_minutos FROM pausa_limite_campana${cond}`,
        mias === null ? [] : mias)).forEach((x) => {
        if (!porCampana.has(x.pausa_tipo_id)) porCampana.set(x.pausa_tipo_id, {});
        porCampana.get(x.pausa_tipo_id)[x.campana_id] = x.limite_minutos;
      });
    }

    res.json(filas.map((f) => ({
      ...f,
      activo: !!f.activo,
      productiva: !!f.productiva,
      basico: !f.campana_id,
      ...(todos && !f.campana_id ? { porCampana: porCampana.get(f.id) || {} } : {}),
      /* El supervisor ve los estados generales para entender por qué
         sus agentes tienen esos botones, pero no puede modificarlos:
         afectarían a campañas que no son suyas. */
      editable: mias === null ? true : (!!f.campana_id && mias.includes(f.campana_id)),
    })));
  } catch (e) { next(e); }
});

/** Comprueba si el usuario puede modificar o eliminar un estado.
    Devuelve el motivo del rechazo, o null si puede. */
async function puedeTocar(usuario, estado) {
  const mias = await campanasDe(usuario);
  if (mias === null) return null;                 // administrador

  if (!estado.campana_id) {
    return 'Ese estado es general: solo el administrador puede cambiarlo.';
  }
  if (!mias.includes(estado.campana_id)) {
    return 'Ese estado es de otra campaña.';
  }
  return null;
}

/* ═══════════ CREAR ═══════════ */
router.post('/pausas/tipos', auth.exigirSesion, auth.exigir('supervision'), async (req, res, next) => {
  try {
    const nombre = String(req.body.nombre || '').trim().replace(/\s+/g, ' ');
    const activo = req.body.activo !== false;

    if (nombre.length < 3 || nombre.length > 40) {
      return res.status(400).json({ error: 'El nombre del estado debe tener entre 3 y 40 caracteres' });
    }
    if (/^disponible$/i.test(nombre)) {
      return res.status(400).json({ error: '"Disponible" no es un estado de pausa' });
    }

    /* Una campaña concreta o NULL para todas */
    const campana_id = Number(req.body.campana_id) || null;
    const mias = await campanasDe(req.usuario);

    if (mias !== null) {
      /* Supervisor: solo para sus campañas, nunca para todas */
      if (!campana_id) {
        return res.status(403).json({
          error: 'Solo el administrador puede crear estados para todas las campañas. Elige una de las tuyas.' });
      }
      if (!mias.length) {
        return res.status(403).json({
          error: 'No tienes campañas asignadas. Pídele al administrador que te asigne una.' });
      }
      if (!mias.includes(campana_id)) {
        return res.status(403).json({ error: 'Esa campaña no está a tu cargo' });
      }
    }

    if (campana_id) {
      const c = await bd.una('SELECT id FROM campana WHERE id = ? AND activa = TRUE', [campana_id]);
      if (!c) return res.status(400).json({ error: 'Esa campaña no existe' });
    }

    /* El mismo nombre puede repetirse en campañas distintas, pero no
       dentro de la misma ni contra un estado general. */
    const existe = await bd.una(
      `SELECT id, activo, campana_id FROM pausa_tipo
        WHERE nombre = ? AND (campana_id <=> ? OR campana_id IS NULL)`,
      [nombre, campana_id]);
    if (existe) {
      return res.status(409).json({
        error: existe.campana_id
          ? `Ya existe el estado "${nombre}" en esa campaña. Actívalo desde la lista.`
          : `Ya existe el estado general "${nombre}", que ven todas las campañas.` });
    }

    /* Duración máxima en minutos. NULL o 0 = sin límite: hay estados
       que no deben tenerlo, como una capacitación larga. */
    let limite = Number(req.body.limite_minutos);
    if (!Number.isFinite(limite) || limite <= 0) limite = null;
    else if (limite > 480) {
      return res.status(400).json({ error: 'La duración máxima son 480 minutos (8 horas)' });
    }

    const [r] = await bd.pool.execute(
      `INSERT INTO pausa_tipo (nombre, productiva, activo, campana_id, creado_por, limite_minutos)
       VALUES (?, FALSE, ?, ?, ?, ?)`,
      [nombre, activo, campana_id, req.usuario.id, limite]);

    await auth.auditar(req.usuario.id, 'crear', 'pausa_tipo', r.insertId,
      `Creó el estado "${nombre}"${campana_id ? ' para una campaña' : ' para todas las campañas'}`, req.ip);

    res.status(201).json({ id: r.insertId, nombre, activo, campana_id, limite_minutos: limite });
  } catch (e) { next(e); }
});

/* ═══════════ ACTIVAR O DESACTIVAR ═══════════ */
router.put('/pausas/tipos/:id', auth.exigirSesion, auth.exigir('supervision'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const t = await bd.una('SELECT nombre, campana_id FROM pausa_tipo WHERE id = ?', [id]);
    if (!t) return res.status(404).json({ error: 'El estado no existe' });

    const puede = await puedeTocar(req.usuario, t);
    if (puede) return res.status(403).json({ error: puede });

    const activo = req.body.activo === undefined ? undefined : !!req.body.activo;

    /* Un básico no se desactiva ni se pasa a una campaña: es de todas */
    if (!t.campana_id && (activo === false || req.body.campana_id)) {
      return res.status(409).json({
        error: `"${t.nombre}" es un estado básico: no se puede desactivar. Puedes cambiar su duración.` });
    }
    const campana_id = req.body.campana_id === undefined
      ? undefined : (Number(req.body.campana_id) || null);

    if (activo !== undefined) {
      await bd.consultar('UPDATE pausa_tipo SET activo = ? WHERE id = ?', [activo, id]);
    }
    if (campana_id !== undefined) {
      await bd.consultar('UPDATE pausa_tipo SET campana_id = ? WHERE id = ?', [campana_id, id]);
    }
    if (req.body.limite_minutos !== undefined) {
      let lim = Number(req.body.limite_minutos);
      if (!Number.isFinite(lim) || lim <= 0) lim = null;
      await bd.consultar('UPDATE pausa_tipo SET limite_minutos = ? WHERE id = ?', [lim, id]);
    }

    await auth.auditar(req.usuario.id, 'modificar', 'pausa_tipo', id,
      `Cambió el estado "${t.nombre}"`, req.ip);

    res.json({ ok: true, activo, campana_id });
  } catch (e) { next(e); }
});

/* ═══════════ DURACIÓN DE UN BÁSICO EN UNA CAMPAÑA ═══════════
   { limite_minutos: 10 }      → 10 minutos en esta campaña
   { limite_minutos: null }    → sin límite en esta campaña
   { usarGeneral: true }       → vuelve a la duración general

   El supervisor solo en sus campañas; el administrador, en todas.   */
router.put('/pausas/tipos/:id/campanas/:campanaId', auth.exigirSesion, auth.exigir('supervision'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const campanaId = Number(req.params.campanaId);

      const t = await bd.una('SELECT nombre, campana_id, limite_minutos FROM pausa_tipo WHERE id = ?', [id]);
      if (!t) return res.status(404).json({ error: 'El estado no existe' });
      if (t.campana_id) {
        return res.status(400).json({ error: 'Ese estado es propio de una campaña: cambia su duración directamente.' });
      }

      const c = await bd.una('SELECT nombre FROM campana WHERE id = ? AND activa = TRUE', [campanaId]);
      if (!c) return res.status(404).json({ error: 'Esa campaña no existe o no está activa' });

      const mias = await campanasDe(req.usuario);
      if (mias !== null && !mias.includes(campanaId)) {
        return res.status(403).json({ error: 'Esa campaña no está a tu cargo.' });
      }

      if (req.body?.usarGeneral) {
        await bd.consultar('DELETE FROM pausa_limite_campana WHERE pausa_tipo_id = ? AND campana_id = ?', [id, campanaId]);
        await auth.auditar(req.usuario.id, 'modificar', 'pausa_tipo', id,
          `"${t.nombre}" en ${c.nombre} vuelve a la duración general`, req.ip);
        return res.json({ ok: true, general: true, limite_minutos: t.limite_minutos });
      }

      let lim = req.body?.limite_minutos;
      lim = lim === null || lim === '' || lim === undefined ? null : Number(lim);
      if (lim !== null && (!Number.isInteger(lim) || lim < 1 || lim > 480)) {
        return res.status(400).json({ error: 'La duración va de 1 a 480 minutos, o sin límite' });
      }

      await bd.consultar(
        `INSERT INTO pausa_limite_campana (pausa_tipo_id, campana_id, limite_minutos, modificado_por)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE limite_minutos = VALUES(limite_minutos), modificado_por = VALUES(modificado_por)`,
        [id, campanaId, lim, req.usuario.id]);

      await auth.auditar(req.usuario.id, 'modificar', 'pausa_tipo', id,
        `"${t.nombre}" en ${c.nombre}: ${lim === null ? 'sin límite' : lim + ' minutos'}`, req.ip);

      res.json({ ok: true, limite_minutos: lim });
    } catch (e) { next(e); }
  });

/* ═══════════ ELIMINAR ═══════════
   Solo si nunca se usó. Si ya tiene pausas registradas, borrarlo se
   llevaría esas filas y los reportes de productividad quedarían
   incompletos: en ese caso se desactiva, que lo quita de la vista de
   los agentes sin perder el historial. */
router.delete('/pausas/tipos/:id', auth.exigirSesion, auth.exigir('supervision'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const t = await bd.una('SELECT nombre, campana_id FROM pausa_tipo WHERE id = ?', [id]);
      if (!t) return res.status(404).json({ error: 'El estado no existe' });

      if (!t.campana_id) {
        return res.status(409).json({
          error: `"${t.nombre}" es un estado básico: no se puede eliminar. Puedes cambiar su duración.` });
      }

      const puede = await puedeTocar(req.usuario, t);
      if (puede) return res.status(403).json({ error: puede });

      const uso = await bd.una('SELECT COUNT(*) AS n FROM pausa WHERE pausa_tipo_id = ?', [id]);
      if (uso.n > 0) {
        return res.status(409).json({
          error: `"${t.nombre}" ya se usó ${uso.n} vez/veces. No se puede eliminar sin perder ` +
                 'ese historial: desactívalo y dejará de aparecer a los agentes.',
          usos: uso.n,
        });
      }

      await bd.consultar('DELETE FROM pausa_tipo WHERE id = ?', [id]);
      await auth.auditar(req.usuario.id, 'eliminar', 'pausa_tipo', id,
        `Eliminó el estado "${t.nombre}"`, req.ip);

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* ═══════════ QUIÉNES SE PASARON DEL TIEMPO ═══════════

   Devuelve los agentes que llevan en pausa más de lo que dura ese
   estado. El supervisor solo ve a los de sus campañas.

   El cálculo se hace aquí y no en la plataforma: así todos ven lo
   mismo, sin depender del reloj del equipo de cada quien. */
router.get('/pausas/excedidas', auth.exigirSesion, auth.exigir('supervision'),
  async (req, res, next) => {
    try {
      const mias = await campanasDe(req.usuario);

      let sql = `SELECT u.id, u.nombre, u.extension, u.campana_id,
                        c.nombre AS campana, pt.nombre AS estado,
                        ${LIMITE_EFECTIVO('pt')} AS limite_minutos, p.inicio,
                        TIMESTAMPDIFF(SECOND, p.inicio, NOW()) AS segundos
                   FROM pausa p
                   JOIN usuario u   ON u.id = p.usuario_id
                   JOIN pausa_tipo pt ON pt.id = p.pausa_tipo_id
                   LEFT JOIN campana c ON c.id = u.campana_id
                   LEFT JOIN pausa_limite_campana plc
                          ON plc.pausa_tipo_id = pt.id AND plc.campana_id = u.campana_id
                  WHERE p.fin IS NULL
                    AND ${LIMITE_EFECTIVO('pt')} IS NOT NULL
                    AND TIMESTAMPDIFF(SECOND, p.inicio, NOW()) > ${LIMITE_EFECTIVO('pt')} * 60
                    /* Solo cuenta si la persona tiene la sesión abierta: una
                       pausa sin sesión es un resto de un turno anterior, no
                       alguien que se pasó del tiempo. */
                    AND EXISTS (SELECT 1 FROM sesion s
                                 WHERE s.usuario_id = u.id AND s.cerrada IS NULL
                                   AND s.vence > NOW() AND s.inicio <= p.inicio)`;
      const val = [];

      if (mias !== null) {
        if (!mias.length) return res.json([]);
        sql += ` AND u.campana_id IN (${mias.map(() => '?').join(',')})`;
        val.push(...mias);
      }

      sql += ' ORDER BY segundos DESC';

      const filas = await bd.consultar(sql, val);
      res.json(filas.map((f) => ({
        ...f,
        segundos: Number(f.segundos),
        excedido: Number(f.segundos) - f.limite_minutos * 60,
      })));
    } catch (e) { next(e); }
  });

/* ═══════════ ENTRAR O SALIR DE PAUSA ═══════════
   Reemplaza la ruta de operacion.js. La diferencia: solo acepta
   estados que existan y estén activos. */
router.post('/pausas', auth.exigirSesion, async (req, res, next) => {
  try {
    const { tipo, entrando } = req.body;

    /* Toda pausa abierta se cierra antes de abrir otra */
    await bd.consultar(
      'UPDATE pausa SET fin = NOW() WHERE usuario_id = ? AND fin IS NULL', [req.usuario.id]);

    if (entrando === false || !tipo) return res.json({ ok: true, disponible: true });

    /* Debe estar activo Y corresponderle: general o de su campaña. Se
       comprueba aquí porque la pantalla se puede saltar. */
    const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [req.usuario.id]);
    const t = await bd.una(
      `SELECT t.id, ${LIMITE_EFECTIVO()} AS limite_minutos FROM pausa_tipo t
         LEFT JOIN pausa_limite_campana plc ON plc.pausa_tipo_id = t.id AND plc.campana_id = ?
        WHERE t.nombre = ? AND t.activo = TRUE
          AND (t.campana_id IS NULL OR t.campana_id = ?)
        LIMIT 1`,
      [yo?.campana_id || 0, String(tipo).trim(), yo?.campana_id || 0]);

    if (!t) {
      return res.status(400).json({
        error: 'Ese estado no está habilitado para tu campaña. Pídeselo al supervisor.' });
    }

    const [r] = await bd.pool.execute(
      'INSERT INTO pausa (usuario_id, pausa_tipo_id, inicio) VALUES (?, ?, NOW())',
      [req.usuario.id, t.id]);

    /* El límite viaja de vuelta: con él la plataforma del agente avisa
       dos minutos antes de que se le acabe el tiempo. */
    res.status(201).json({ id: r.insertId, limite_minutos: t.limite_minutos });
  } catch (e) { next(e); }
});

module.exports = router;
