/* ═══════════════════════════════════════════════════════════════════
   REGISTRO Y REPORTE DE LLAMADAS

   Cada llamada queda guardada en la tabla `interaccion` cuando el agente
   termina de gestionarla: las contestadas al tipificar (o al vencer el
   tiempo de cierre) y las no contestadas en cuanto terminan.

   Quien registra es la propia plataforma del agente, que es la que
   conoce el número, la duración y la tipificación. El identificador de
   la llamada es el Call-ID de SIP: el mismo que aparece en los
   registros de Asterisk, así que sirve para cruzar ambos.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const crypto = require('crypto');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

/* ═══════════ REGISTRAR ═══════════ */
router.post('/llamadas', auth.exigirSesion, async (req, res, next) => {
  try {
    const b = req.body || {};

    const numero = String(b.numero || '').replace(/[^\d+*#]/g, '').slice(0, 30);
    if (!numero) return res.status(400).json({ error: 'Falta el número de la llamada' });

    const direccion = b.direccion === 'entrante' ? 'entrante' : 'saliente';
    const segundos = Math.max(0, Math.round(Number(b.segundos) || 0));
    const contestada = !!b.contestada;

    /* Momento de inicio: el que manda la plataforma, o se deduce de la
       duración si no llega. */
    const fin = new Date();
    let inicio = b.inicio ? new Date(b.inicio) : new Date(fin.getTime() - segundos * 1000);
    if (isNaN(inicio)) inicio = new Date(fin.getTime() - segundos * 1000);

    /* Identificador: Call-ID de SIP si lo hay; si no, uno propio.
       Debe ser único porque la columna lo exige. */
    let id = String(b.callId || '').slice(0, 64);
    if (!id) id = 'bpm-' + crypto.randomUUID();

    const yo = await bd.una(
      'SELECT extension, campana_id FROM usuario WHERE id = ?', [req.usuario.id]);

    /* La tipificación se guarda enlazada al catálogo cuando coincide, y
       además como texto, para que el reporte la muestre aunque el
       catálogo cambie después. */
    let tipId = null, resultado = null;
    if (b.categoria) {
      resultado = b.subcategoria ? `${b.categoria} · ${b.subcategoria}` : b.categoria;
      const t = await bd.una(
        `SELECT id FROM tipificacion
          WHERE categoria = ? AND (subcategoria <=> ? OR (? IS NULL AND subcategoria IS NULL))
          LIMIT 1`,
        [b.categoria, b.subcategoria || null, b.subcategoria || null]);
      tipId = t ? t.id : null;
    }

    const [r] = await bd.pool.execute(
      `INSERT INTO interaccion
         (linkedid, direccion, numero, campana_id, inicio, fin, contestada,
          segundos_total, tipificacion_id, resultado, observaciones,
          usuario_id, extension)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
          tipificacion_id = VALUES(tipificacion_id),
          resultado       = VALUES(resultado),
          observaciones   = VALUES(observaciones)`,
      [id, direccion, numero, yo?.campana_id || null, inicio, fin, contestada,
       segundos, tipId, resultado, (b.observaciones || '').slice(0, 2000) || null,
       req.usuario.id, yo?.extension || null]);

    res.status(201).json({ ok: true, id: r.insertId || null, llamada: id });
  } catch (e) { next(e); }
});

/* ═══════════ REPORTE ═══════════ */
router.get('/reportes/llamadas', auth.exigirSesion, auth.exigir('reportes'), async (req, res, next) => {
  try {
    const { desde, hasta, extension, numero, estado } = req.query;
    const cond = [];
    const val = [];

    /* Sin fechas, el día de hoy: lo primero que se quiere ver es la
       llamada que se acaba de hacer. */
    cond.push('i.inicio >= ?'); val.push((desde || hoy()) + ' 00:00:00');
    cond.push('i.inicio <= ?'); val.push((hasta || desde || hoy()) + ' 23:59:59');

    if (extension) { cond.push('i.extension = ?'); val.push(extension); }
    if (numero)    { cond.push('i.numero LIKE ?'); val.push('%' + String(numero).replace(/\D/g, '') + '%'); }
    if (estado === 'contestada')    cond.push('i.contestada = TRUE');
    if (estado === 'no_contestada') cond.push('i.contestada = FALSE');

    const filas = await bd.consultar(
      `SELECT i.id, i.linkedid, i.direccion, i.numero, i.inicio, i.fin,
              i.contestada, i.segundos_total, i.resultado, i.observaciones,
              i.extension, u.nombre AS agente, c.nombre AS campana
         FROM interaccion i
         LEFT JOIN usuario u ON u.id = i.usuario_id
         LEFT JOIN campana c ON c.id = i.campana_id
        WHERE ${cond.join(' AND ')}
        ORDER BY i.inicio DESC
        LIMIT 1000`, val);

    const total = filas.length;
    const contestadas = filas.filter((f) => f.contestada).length;
    const hablados = filas.reduce((s, f) => s + (f.segundos_total || 0), 0);

    res.json({
      resumen: {
        total,
        contestadas,
        noContestadas: total - contestadas,
        segundosHablados: hablados,
        promedio: contestadas ? Math.round(hablados / contestadas) : 0,
      },
      llamadas: filas.map((f) => ({
        id: f.id,
        llamada: f.linkedid,
        fecha: fecha(f.inicio),
        hora: hora(f.inicio),
        agente: f.agente || '—',
        extension: f.extension || '—',
        campana: f.campana || '—',
        direccion: f.direccion,
        numero: f.numero,
        estado: f.contestada ? 'Contestada' : 'No contestada',
        segundos: f.segundos_total || 0,
        resultado: f.resultado || (f.contestada ? 'Sin tipificar' : '—'),
        observaciones: f.observaciones || '',
      })),
    });
  } catch (e) { next(e); }
});

const dos = (n) => String(n).padStart(2, '0');
function hoy() { const d = new Date(); return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`; }
function fecha(d) { d = new Date(d); return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`; }
function hora(d) { d = new Date(d); return `${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`; }

module.exports = router;