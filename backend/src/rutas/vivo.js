/* ═══════════════════════════════════════════════════════════════════
   ESTADO EN VIVO DE LA OPERACIÓN

   Alimenta el panel del supervisor. Responde a una pregunta simple:
   ¿qué está pasando ahora mismo?

   De dónde sale cada dato:

     Agentes conectados   tabla `sesion`, las que no están cerradas ni
                          vencidas. Si el agente cerró sesión o pasaron
                          ocho horas, deja de aparecer.

     Estado y desde cuándo  tabla `pausa`. La última fila sin `fin` es
                          la pausa en curso; si no hay ninguna, el
                          agente está disponible.

     Llamadas activas     se consulta a Asterisk. Si el backend no
                          puede ejecutar el comando, se informa en la
                          respuesta en lugar de inventar datos.

   No usa eventos: el navegador vuelve a preguntar cada pocos segundos.
   Es menos inmediato que escuchar el AMI, pero funciona sin montar un
   canal permanente y el supervisor no nota la diferencia.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { exec } = require('child_process');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

/** Ejecuta un comando de Asterisk. Nunca lanza: si falla, lo dice. */
function asteriskCLI(comando) {
  return new Promise((resolve) => {
    exec(`asterisk -rx "${comando}"`, { timeout: 4000 }, (err, salida) => {
      if (err) return resolve({ ok: false, motivo: err.message.split('\n')[0] });
      resolve({ ok: true, salida: String(salida) });
    });
  });
}

/* Cada línea de `core show channels concise` trae los campos separados
   por "!". Los que interesan son el canal, el contexto, la extensión,
   el estado, la duración y el identificador de quien llama. */
function interpretarCanales(texto) {
  const canales = [];

  texto.split('\n').forEach((linea) => {
    if (!linea.includes('!')) return;
    const c = linea.split('!');
    if (c.length < 10) return;

    const canal = c[0];                       // PJSIP/1011-00000042
    const m = canal.match(/^PJSIP\/([^-]+)-/);
    if (!m) return;

    canales.push({
      canal,
      extension: m[1],
      contexto: c[1],
      marcado: c[2],
      estado: c[4],                           // Up, Ring, Ringing…
      numero: c[7] || c[2],
      segundos: Number(c[11]) || 0,
    });
  });

  return canales;
}

/* ═══════════════════════════════════════════════════════════════════
   GET /api/vivo
   ═══════════════════════════════════════════════════════════════════ */

/* exigirSesion identifica a quien pregunta; exigir comprueba que
   tenga el permiso. El orden importa: sin lo primero, lo segundo no
   tiene a quién mirar. */
router.get('/vivo', auth.exigirSesion, auth.exigir('supervision'), async (req, res, next) => {
  try {
    /* ── Qué campañas puede ver quien pregunta ───────────────────── */
    const esAdmin = req.usuario.rol === 'admin';

    let campanasVisibles = null;               // null = todas
    if (!esAdmin) {
      const filas = await bd.consultar(
        'SELECT campana_id FROM usuario_campana WHERE usuario_id = ?', [req.usuario.id]);
      campanasVisibles = filas.map((f) => f.campana_id);

      /* Sin campañas asignadas, ve la suya propia. Así un supervisor
         recién creado no se encuentra la pantalla vacía. */
      if (!campanasVisibles.length) {
        const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [req.usuario.id]);
        if (yo?.campana_id) campanasVisibles = [yo.campana_id];
      }
    }

    /* ── Agentes con sesión abierta ──────────────────────────────── */
    const agentes = await bd.consultar(
      `SELECT u.id, u.usuario, u.nombre, u.extension,
              c.id AS campana_id, c.nombre AS campana,
              s.inicio AS desde_sesion,
              (SELECT p.id FROM pausa p
                WHERE p.usuario_id = u.id AND p.fin IS NULL
                ORDER BY p.inicio DESC LIMIT 1) AS pausa_id,
              (SELECT pt.nombre FROM pausa p
                 JOIN pausa_tipo pt ON pt.id = p.pausa_tipo_id
                WHERE p.usuario_id = u.id AND p.fin IS NULL
                ORDER BY p.inicio DESC LIMIT 1) AS pausa_motivo,
              (SELECT p.inicio FROM pausa p
                WHERE p.usuario_id = u.id AND p.fin IS NULL
                ORDER BY p.inicio DESC LIMIT 1) AS pausa_desde
         FROM sesion s
         JOIN usuario u ON u.id = s.usuario_id
         LEFT JOIN campana c ON c.id = u.campana_id
        WHERE s.cerrada IS NULL
          AND s.vence > NOW()
          AND u.activo = TRUE
        GROUP BY u.id
        ORDER BY u.nombre`);

    /* ── Llamadas activas, desde Asterisk ────────────────────────── */
    const cli = await asteriskCLI('core show channels concise');
    const canales = cli.ok ? interpretarCanales(cli.salida) : [];

    const porExtension = {};
    canales.forEach((c) => {
      /* Si un agente tiene dos canales (una transferencia consultada),
         se queda el que lleva más tiempo: es la llamada principal. */
      const previo = porExtension[c.extension];
      if (!previo || c.segundos > previo.segundos) porExtension[c.extension] = c;
    });

    const ahora = Date.now();

    let lista = agentes.map((a) => {
      const canal = a.extension ? porExtension[a.extension] : null;

      let estado, desde;
      if (canal) {
        estado = canal.estado === 'Up' ? 'En llamada' : 'Timbrando';
        desde = canal.segundos;
      } else if (a.pausa_id) {
        estado = a.pausa_motivo || 'En pausa';
        desde = Math.floor((ahora - new Date(a.pausa_desde).getTime()) / 1000);
      } else {
        estado = 'Disponible';
        desde = Math.floor((ahora - new Date(a.desde_sesion).getTime()) / 1000);
      }

      return {
        id: a.id,
        usuario: a.usuario,
        nombre: a.nombre,
        extension: a.extension,
        campana: a.campana || '—',
        campana_id: a.campana_id,
        estado,
        desde: desde < 0 ? 0 : desde,
        numero: canal ? canal.numero : null,
      };
    });

    if (campanasVisibles) {
      lista = lista.filter((a) => campanasVisibles.includes(a.campana_id));
    }

    /* ── Indicadores ─────────────────────────────────────────────── */
    const enLlamada = lista.filter((a) => a.estado === 'En llamada').length;
    const disponibles = lista.filter((a) => a.estado === 'Disponible').length;
    const enPausa = lista.length - enLlamada - disponibles -
                    lista.filter((a) => a.estado === 'Timbrando').length;

    /* ── Llamadas del día, de la base ────────────────────────────── */
    const hoy = await bd.una(
      `SELECT COUNT(*) AS total,
              SUM(contestada = 1) AS contestadas,
              SUM(contestada = 0) AS abandonadas
         FROM interaccion
        WHERE DATE(inicio) = CURDATE()`).catch(() => null);

    res.json({
      momento: new Date(),
      agentes: lista,
      kpis: {
        conectados: lista.length,
        enLlamada,
        disponibles,
        enPausa: enPausa < 0 ? 0 : enPausa,
        llamadasHoy: hoy?.total || 0,
        contestadasHoy: hoy?.contestadas || 0,
        abandonadasHoy: hoy?.abandonadas || 0,
      },
      /* Si no se pudo consultar a Asterisk, se dice. El supervisor
         verá los agentes conectados pero no quién está en llamada, y
         es mejor que lo sepa a que lo deduzca. */
      telefonia: cli.ok
        ? { ok: true, canales: canales.length }
        : { ok: false, motivo: cli.motivo },
    });
  } catch (e) { next(e); }
});

module.exports = router;
