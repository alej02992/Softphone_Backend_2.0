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

    /* ── Cerrar el contacto de la base ──

       Si la llamada venía de una base de marcación, el agente acaba de
       tipificarla aquí. Sin esto, el contacto se quedaría asignado a su
       nombre y el motor dejaría de mandarle llamadas: era la causa de
       que la marcación se detuviera después de dos. */
    if (resultado) {
      try {
        /* Qué hay que hacer con el contacto según la tipificación que
           eligió el agente. Una tipificación no es solo un registro:
           dice si se reintenta, si se usa el otro teléfono, si se
           agenda o si no se vuelve a llamar nunca. */
        const t = tipId
          ? await bd.una('SELECT accion FROM tipificacion WHERE id = ?', [tipId])
          : null;
        const accion = t?.accion || 'cerrar';

        const c = await bd.una(
          `SELECT c.id, c.telefono_1, c.telefono_2, c.intentos, b.reintentos, b.intervalo_min
             FROM base_contacto c JOIN base b ON b.id = c.base_id
            WHERE c.agente_id = ? AND c.estado = 'asignado'
              AND (c.telefono_1 = ? OR c.telefono_2 = ?)
            LIMIT 1`, [req.usuario.id, numero, numero]);

        if (c) {
          const obs = (b.observaciones || '').slice(0, 2000) || null;
          const intentos = (c.intentos || 0) + 1;

          /* Reintentar y usar el otro teléfono comparten la mecánica:
             el contacto vuelve a la cola con una hora futura. Se
             respetan los reintentos de la base para no llamar sin
             límite a la misma persona. */
          const vuelveALaCola = ['reintentar', 'otro_telefono'].includes(accion)
            && intentos <= (c.reintentos ?? 2);

          if (vuelveALaCola) {
            await bd.consultar(
              `UPDATE base_contacto
                  SET estado = 'pendiente', intentos = ?, ultimo_intento = NOW(),
                      proximo_intento = ?, resultado = ?, observaciones = ?,
                      agente_id = NULL, asignado_en = NULL, colgado_en = NULL
                WHERE id = ?`,
              [intentos, new Date(Date.now() + (c.intervalo_min || 60) * 60000),
               resultado, obs, c.id]);

          } else if (accion === 'agendar' && b.agendado_para) {
            await bd.consultar(
              `UPDATE base_contacto
                  SET estado = 'agendado', agendado_para = ?, intentos = ?,
                      ultimo_intento = NOW(), resultado = ?, observaciones = ?,
                      agente_id = NULL, asignado_en = NULL, colgado_en = NULL,
                      proximo_intento = NULL
                WHERE id = ?`,
              [new Date(b.agendado_para), intentos, resultado, obs, c.id]);

          } else {
            /* Cerrar, o reintentar sin intentos disponibles */
            await bd.consultar(
              `UPDATE base_contacto
                  SET estado = ?, gestionado_en = NOW(), resultado = ?,
                      observaciones = COALESCE(observaciones, ?),
                      intentos = ?, ultimo_intento = NOW()
                WHERE id = ?`,
              [accion === 'cerrar' ? 'gestionado' : 'sin_contacto',
               resultado, obs, intentos, c.id]);
          }

          /* Si el cliente pidió no ser contactado, el número sale de
             todas las campañas, no solo de esta base. */
          if (accion === 'no_llamar') {
            await bd.consultar(
              'INSERT IGNORE INTO no_llamar (numero, motivo) VALUES (?, ?)',
              [c.telefono_1, (resultado || 'Lo pidió el cliente').slice(0, 160)]);
            await bd.consultar(
              "UPDATE base_contacto SET estado = 'excluido' WHERE id = ?", [c.id]);
          }
        } else if (accion === 'no_llamar') {
          /* La llamada no venía de una base, pero igual pidió que no
             lo llamen: el número se excluye de todas formas. */
          await bd.consultar(
            'INSERT IGNORE INTO no_llamar (numero, motivo) VALUES (?, ?)',
            [numero, (resultado || 'Lo pidió el cliente').slice(0, 160)]);
        }
      } catch { /* si no venía de una base, no hay nada que cerrar */ }
    }

    res.status(201).json({ ok: true, id: r.insertId || null, llamada: id });
  } catch (e) { next(e); }
});

/* ═══════════ REPORTE ═══════════ */
/** Las campañas de un supervisor. `null` significa "todas", que es lo
    que corresponde a un administrador. */
async function campanasDelSupervisor(usuario) {
  if (usuario.rol === 'admin') return null;

  const filas = await bd.consultar(
    'SELECT campana_id FROM usuario_campana WHERE usuario_id = ?', [usuario.id]);
  const ids = filas.map((f) => f.campana_id);

  /* Si no tiene campañas asignadas, se usa la de su ficha */
  if (!ids.length) {
    const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [usuario.id]);
    if (yo?.campana_id) ids.push(yo.campana_id);
  }
  return ids;
}

router.get('/reportes/llamadas', auth.exigirSesion, auth.exigir('reportes'), async (req, res, next) => {
  try {
    const { desde, hasta, extension, numero, estado, desdeHora, hastaHora } = req.query;
    const cond = [];
    const val = [];

    /* Sin fechas, el día de hoy: lo primero que se quiere ver es la
       llamada que se acaba de hacer. */
    cond.push('i.inicio >= ?'); val.push((desde || hoy()) + ' ' + (desdeHora || '00:00') + ':00');
    cond.push('i.inicio <= ?'); val.push((hasta || desde || hoy()) + ' ' + (hastaHora || '23:59') + ':59');

    /* Con varios días, la hora acota la franja de CADA día: así se
       puede ver "de 8 a 10 de la mañana toda la semana". */
    if ((desdeHora || hastaHora) && hasta && hasta !== desde) {
      cond.push('TIME(i.inicio) BETWEEN ? AND ?');
      val.push((desdeHora || '00:00') + ':00', (hastaHora || '23:59') + ':59');
    }

    if (extension) { cond.push('i.extension = ?'); val.push(extension); }
    if (numero)    { cond.push('i.numero LIKE ?'); val.push('%' + String(numero).replace(/\D/g, '') + '%'); }
    if (estado === 'contestada')    cond.push('i.contestada = TRUE');
    if (estado === 'no_contestada') cond.push('i.contestada = FALSE');

    /* Un supervisor solo ve las llamadas de sus campañas. Esto se
       comprueba aquí y no en la pantalla: cualquiera podría pedir la
       dirección a mano y ver lo que no le corresponde.
       El administrador no lleva filtro: ve la operación completa. */
    const mias = await campanasDelSupervisor(req.usuario);
    if (mias !== null) {
      if (!mias.length) {
        return res.json({
          resumen: { total: 0, contestadas: 0, noContestadas: 0,
                     segundosHablados: 0, promedio: 0 },
          llamadas: [],
        });
      }
      cond.push(`i.campana_id IN (${mias.map(() => '?').join(',')})`);
      val.push(...mias);
    }

    const filas = await bd.consultar(
      `SELECT i.id, i.linkedid, i.direccion, i.numero, i.inicio, i.fin,
              i.contestada, i.segundos_total, i.resultado, i.observaciones,
              i.extension, COALESCE(u.nombre, i.agente_nombre) AS agente, c.nombre AS campana
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