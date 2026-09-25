/* ═══════════════════════════════════════════════════════════════════
   ESTADOS DE PAUSA

   Los estados los define el supervisor, no el agente. El supervisor
   crea un estado ("Capacitación", "Reunión"…), lo activa, y a partir
   de ese momento aparece como botón en el panel de todos los agentes.
   Si lo desactiva, deja de aparecer.

   El agente solo puede usar estados activos: ya no escribe los suyos.

   Este archivo se monta ANTES que operacion.js, así que su ruta
   POST /pausas es la que atiende las peticiones y reemplaza a la
   anterior, que creaba estados nuevos con cualquier texto.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

/* ═══════════ LISTAR ═══════════
   Cualquier usuario con sesión: el agente la usa para pintar sus
   botones. El supervisor pide también los inactivos con ?todos=1. */
router.get('/pausas/tipos', auth.exigirSesion, async (req, res, next) => {
  try {
    /* El supervisor pide la lista completa para administrarla; el
       agente recibe solo los estados activos que le corresponden: los
       generales y los de su campaña. */
    const todos = req.query.todos === '1' &&
      (req.usuario.permisos || []).includes('supervision');

    let sql = `SELECT t.id, t.nombre, t.productiva, t.limite_minutos, t.activo,
                      t.campana_id, c.nombre AS campana
                 FROM pausa_tipo t
                 LEFT JOIN campana c ON c.id = t.campana_id`;
    const val = [];

    if (!todos) {
      const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [req.usuario.id]);
      sql += ' WHERE t.activo = TRUE AND (t.campana_id IS NULL OR t.campana_id = ?)';
      val.push(yo?.campana_id || 0);
    }

    sql += ' ORDER BY t.campana_id IS NULL DESC, t.id';

    const filas = await bd.consultar(sql, val);
    res.json(filas.map((f) => ({
      ...f, activo: !!f.activo, productiva: !!f.productiva,
    })));
  } catch (e) { next(e); }
});

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

    const [r] = await bd.pool.execute(
      'INSERT INTO pausa_tipo (nombre, productiva, activo, campana_id, creado_por) VALUES (?, FALSE, ?, ?, ?)',
      [nombre, activo, campana_id, req.usuario.id]);

    await auth.auditar(req.usuario.id, 'crear', 'pausa_tipo', r.insertId,
      `Creó el estado "${nombre}"${campana_id ? ' para una campaña' : ' para todas las campañas'}`, req.ip);

    res.status(201).json({ id: r.insertId, nombre, activo, campana_id });
  } catch (e) { next(e); }
});

/* ═══════════ ACTIVAR O DESACTIVAR ═══════════ */
router.put('/pausas/tipos/:id', auth.exigirSesion, auth.exigir('supervision'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const t = await bd.una('SELECT nombre FROM pausa_tipo WHERE id = ?', [id]);
    if (!t) return res.status(404).json({ error: 'El estado no existe' });

    const activo = req.body.activo === undefined ? undefined : !!req.body.activo;
    const campana_id = req.body.campana_id === undefined
      ? undefined : (Number(req.body.campana_id) || null);

    if (activo !== undefined) {
      await bd.consultar('UPDATE pausa_tipo SET activo = ? WHERE id = ?', [activo, id]);
    }
    if (campana_id !== undefined) {
      await bd.consultar('UPDATE pausa_tipo SET campana_id = ? WHERE id = ?', [campana_id, id]);
    }

    await auth.auditar(req.usuario.id, 'modificar', 'pausa_tipo', id,
      `Cambió el estado "${t.nombre}"`, req.ip);

    res.json({ ok: true, activo, campana_id });
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
      const t = await bd.una('SELECT nombre FROM pausa_tipo WHERE id = ?', [id]);
      if (!t) return res.status(404).json({ error: 'El estado no existe' });

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
      `SELECT id FROM pausa_tipo
        WHERE nombre = ? AND activo = TRUE
          AND (campana_id IS NULL OR campana_id = ?)
        LIMIT 1`,
      [String(tipo).trim(), yo?.campana_id || 0]);

    if (!t) {
      return res.status(400).json({
        error: 'Ese estado no está habilitado para tu campaña. Pídeselo al supervisor.' });
    }

    const [r] = await bd.pool.execute(
      'INSERT INTO pausa (usuario_id, pausa_tipo_id, inicio) VALUES (?, ?, NOW())',
      [req.usuario.id, t.id]);

    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

module.exports = router;
