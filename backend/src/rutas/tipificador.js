/* ═══════════════════════════════════════════════════════════════════
   TIPIFICADOR

   Cada campaña define cómo se cierran sus gestiones. Una de atención
   al ciudadano no tiene los mismos resultados que una de cobranza, y
   forzar una lista única hace que los agentes elijan lo que menos mal
   les suene.

   DOS NIVELES
   Categoría es el resultado general; subcategoría, el detalle. El
   agente elige la primera y la segunda se filtra sola.

   LO IMPORTANTE: LA ACCIÓN
   Una tipificación no es solo un registro. Dice qué hace el sistema
   con ese contacto:

     cerrar          la gestión terminó, no se vuelve a llamar
     reintentar      vuelve a la cola para intentarlo más tarde
     otro_telefono   se reintenta con el segundo número
     agendar         el agente fija fecha y hora
     no_llamar       el número sale de todas las campañas

   Así el agente tipifica una vez y el sistema hace el resto, en lugar
   de pedirle que además pulse botones aparte.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

/** Qué hace cada acción, para explicarlo en la pantalla. */
const ACCIONES = {
  cerrar:        'La gestión termina. No se vuelve a llamar.',
  reintentar:    'Vuelve a la cola y se reintenta más tarde.',
  otro_telefono: 'Se reintenta con el segundo teléfono del contacto.',
  agendar:       'El agente fija fecha y hora para volver a llamar.',
  no_llamar:     'El número sale de todas las campañas.',
};

/* ═══════════ CONSULTAR ═══════════ */

/** Las tipificaciones de una campaña, para administrarlas. */
router.get('/tipificador/:campanaId', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const campanaId = Number(req.params.campanaId) || null;

      const filas = await bd.consultar(
        `SELECT id, categoria, subcategoria, efectiva, requiere_agenda,
                accion, activa, orden
           FROM tipificacion
          WHERE ${campanaId ? 'campana_id = ?' : 'campana_id IS NULL'}
          ORDER BY orden, categoria, subcategoria`,
        campanaId ? [campanaId] : []);

      res.json({ tipificaciones: filas, acciones: ACCIONES });
    } catch (e) { next(e); }
  });

/* ═══════════ GUARDAR ═══════════ */

/**
 * Guarda la lista completa de una campaña.
 *
 * Se reemplaza entera en vez de ir una por una porque el administrador
 * trabaja sobre la lista completa: agrega, quita y reordena, y después
 * guarda. Lo que ya se usó no se borra: se desactiva, para que los
 * reportes antiguos sigan mostrando con qué se cerró cada gestión.
 */
router.put('/tipificador/:campanaId', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const campanaId = Number(req.params.campanaId) || null;
      const lista = Array.isArray(req.body.tipificaciones) ? req.body.tipificaciones : [];

      if (!lista.length) {
        return res.status(400).json({ error: 'Define al menos una tipificación' });
      }
      if (lista.length > 200) {
        return res.status(400).json({ error: 'Demasiadas tipificaciones' });
      }

      /* Se revisan todas antes de tocar nada: a medio guardar quedaría
         una campaña con la lista incompleta. */
      for (const t of lista) {
        const cat = String(t.categoria || '').trim();
        if (cat.length < 2) {
          return res.status(400).json({ error: 'Cada tipificación necesita una categoría' });
        }
        if (t.accion && !ACCIONES[t.accion]) {
          return res.status(400).json({ error: `Acción desconocida: ${t.accion}` });
        }
      }

      const usadas = await bd.consultar(
        `SELECT DISTINCT tipificacion_id FROM interaccion
          WHERE tipificacion_id IS NOT NULL`);
      const seUsaron = new Set(usadas.map((u) => u.tipificacion_id));

      let creadas = 0, actualizadas = 0, desactivadas = 0, eliminadas = 0;

      await bd.transaccion(async (cx) => {
        const previas = await bd.consultar(
          `SELECT id FROM tipificacion
            WHERE ${campanaId ? 'campana_id = ?' : 'campana_id IS NULL'}`,
          campanaId ? [campanaId] : []);

        const quedan = new Set(lista.map((t) => Number(t.id)).filter(Boolean));

        /* Las que ya no están en la lista */
        for (const p of previas) {
          if (quedan.has(p.id)) continue;

          if (seUsaron.has(p.id)) {
            /* Ya se usó en una gestión: se desactiva para que el
               historial siga teniendo sentido. */
            await cx.execute('UPDATE tipificacion SET activa = FALSE WHERE id = ?', [p.id]);
            desactivadas++;
          } else {
            await cx.execute('DELETE FROM tipificacion WHERE id = ?', [p.id]);
            eliminadas++;
          }
        }

        /* Las de la lista, en el orden en que llegan */
        for (let i = 0; i < lista.length; i++) {
          const t = lista[i];
          const datos = [
            String(t.categoria).trim().slice(0, 80),
            String(t.subcategoria || '').trim().slice(0, 80) || null,
            !!t.efectiva,
            t.accion === 'agendar',          // requiere_agenda sigue sirviendo
            t.accion || 'cerrar',
            t.activa === false ? 0 : 1,
            i,
          ];

          if (t.id) {
            await cx.execute(
              `UPDATE tipificacion
                  SET categoria = ?, subcategoria = ?, efectiva = ?, requiere_agenda = ?,
                      accion = ?, activa = ?, orden = ?
                WHERE id = ?`, [...datos, Number(t.id)]);
            actualizadas++;
          } else {
            await cx.execute(
              `INSERT INTO tipificacion
                 (categoria, subcategoria, efectiva, requiere_agenda, accion, activa,
                  orden, campana_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [...datos, campanaId]);
            creadas++;
          }
        }
      });

      await auth.auditar(req.usuario.id, 'modificar', 'tipificacion', campanaId,
        `Actualizó el tipificador de la campaña ${campanaId || 'general'}`, req.ip);

      res.json({ ok: true, creadas, actualizadas, desactivadas, eliminadas });
    } catch (e) { next(e); }
  });

module.exports = router;