/* ═══════════════════════════════════════════════════════════════════
   ESTADO EN VIVO DE LA OPERACIÓN

   Alimenta el panel de seguimiento del supervisor. Responde a una
   pregunta simple: ¿qué está pasando ahora mismo?

   De dónde sale cada dato:

     Agentes conectados   tabla `sesion`, las que no están cerradas ni
                          vencidas. Si el agente cerró sesión o pasaron
                          ocho horas, deja de aparecer.

     Estado y desde cuándo  tabla `pausa`. La última fila sin `fin` es
                          la pausa en curso, con el tiempo máximo de su
                          tipo; si no hay ninguna, está disponible.

     Llamadas activas     se consulta a Asterisk. Si el backend no
                          puede ejecutar el comando, se informa en la
                          respuesta en lugar de inventar datos.

     Números del día      tabla `interaccion`: cuántas llamadas lleva
                          cada agente, cuántas contestadas y cuánto ha
                          hablado.

     Llamadas en cola     se pregunta a la central por AMI, como en el
                          escritorio del agente.

   No usa eventos: el navegador vuelve a preguntar cada pocos segundos.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { exec } = require('child_process');
const bd = require('../bd');
const auth = require('../auth');
const ami = require('../ami');

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

/**
 * Qué campañas puede ver quien pregunta. null = todas (administrador).
 *
 * Un supervisor ve las que tiene a cargo; si no tiene ninguna asignada,
 * la suya propia, para que uno recién creado no vea la pantalla vacía.
 */
async function campanasVisibles(usuario) {
  if (usuario.rol === 'admin') return null;
  const filas = await bd.consultar(
    'SELECT campana_id FROM usuario_campana WHERE usuario_id = ?', [usuario.id]);
  let ids = filas.map((f) => f.campana_id);
  if (!ids.length) {
    const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [usuario.id]);
    if (yo?.campana_id) ids = [yo.campana_id];
  }
  return ids;
}

/** El trozo de consulta que limita a esas campañas, con sus valores. */
const filtroCampanas = (ids, columna) => (ids === null
  ? { sql: '', val: [] }
  : ids.length
    ? { sql: ` AND ${columna} IN (${ids.map(() => '?').join(',')})`, val: ids }
    : { sql: ' AND 1 = 0', val: [] });

/**
 * Quién está esperando en las colas de esas campañas.
 *
 * QueueStatus devuelve un evento por cada persona en espera. Cada
 * campaña sabe cuál es su cola por `cola_asterisk`. Nunca lanza: un
 * fallo de la cola no puede tumbar el resto del panel.
 */
async function colasDe(ids) {
  try {
    if (!ami.estado().conectado) return { ok: false, motivo: 'Sin conexión con la central' };

    const f = filtroCampanas(ids, 'id');
    const campanas = await bd.consultar(
      `SELECT id, nombre, cola_asterisk FROM campana
        WHERE activa = TRUE AND cola_asterisk IS NOT NULL AND cola_asterisk <> ''${f.sql}`, f.val);
    const porCola = new Map(campanas.map((c) => [String(c.cola_asterisk), c]));
    if (!porCola.size) return { ok: true, total: 0, colas: [] };

    const esperando = await ami.listar(
      { Action: 'QueueStatus' }, 'QueueEntry', 'QueueStatusComplete');

    const colas = new Map();
    esperando.forEach((e) => {
      const c = porCola.get(String(e.Queue));
      if (!c) return;
      if (!colas.has(c.id)) colas.set(c.id, { campana: c.nombre, cola: e.Queue, llamadas: [] });
      colas.get(c.id).llamadas.push({
        numero: e.CallerIDNum || e.CallerID || 'Desconocido',
        esperando: Number(e.Wait) || 0,
        posicion: Number(e.Position) || 0,
      });
    });

    const lista = [...colas.values()].map((c) => ({
      ...c,
      total: c.llamadas.length,
      maxEspera: Math.max(...c.llamadas.map((l) => l.esperando)),
      llamadas: c.llamadas.sort((a, b) => a.posicion - b.posicion).slice(0, 10),
    })).sort((a, b) => b.maxEspera - a.maxEspera);

    return { ok: true, total: lista.reduce((s, c) => s + c.total, 0), colas: lista };
  } catch {
    return { ok: false, motivo: 'No se pudo consultar la cola' };
  }
}

/* ═══════════════════════════════════════════════════════════════════
   GET /api/vivo
   ═══════════════════════════════════════════════════════════════════ */

/* exigirSesion identifica a quien pregunta; exigir comprueba que
   tenga el permiso. El orden importa: sin lo primero, lo segundo no
   tiene a quién mirar. */
router.get('/vivo', auth.exigirSesion, auth.exigir('supervision'), async (req, res, next) => {
  try {
    const visibles = await campanasVisibles(req.usuario);

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
              /* La duración de esa pausa en la campaña del agente: la
                 propia de la campaña si la tiene, si no la general. */
              (SELECT IF(plc.pausa_tipo_id IS NULL, pt.limite_minutos, plc.limite_minutos)
                 FROM pausa p
                 JOIN pausa_tipo pt ON pt.id = p.pausa_tipo_id
                 LEFT JOIN pausa_limite_campana plc
                        ON plc.pausa_tipo_id = pt.id AND plc.campana_id = u.campana_id
                WHERE p.usuario_id = u.id AND p.fin IS NULL
                ORDER BY p.inicio DESC LIMIT 1) AS pausa_limite,
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

    /* ── Lo que lleva cada agente hoy ────────────────────────────
       Una sola consulta para todos, agrupada: preguntar agente por
       agente serían decenas de viajes a la base cada tres segundos. */
    const delDia = new Map();
    try {
      const filas = await bd.consultar(
        `SELECT usuario_id, COUNT(*) AS llamadas,
                SUM(contestada = 1) AS contestadas,
                SUM(IFNULL(segundos_total, 0)) AS segundos
           FROM interaccion
          WHERE inicio >= CURDATE()
          GROUP BY usuario_id`);
      filas.forEach((f) => delDia.set(f.usuario_id, {
        llamadas: Number(f.llamadas) || 0,
        contestadas: Number(f.contestadas) || 0,
        segundos: Number(f.segundos) || 0,
      }));
    } catch { /* sin datos del día: las tarjetas los muestran en cero */ }

    const ahora = Date.now();

    let lista = agentes.map((a) => {
      const canal = a.extension ? porExtension[a.extension] : null;

      /* `tipo` es para la pantalla —colores, alertas, orden—; `estado`
         es el texto que se lee, como antes. */
      let estado, tipo, desde, limite = null;
      if (canal) {
        tipo = canal.estado === 'Up' ? 'llamada' : 'timbrando';
        estado = canal.estado === 'Up' ? 'En llamada' : 'Timbrando';
        desde = canal.segundos;
      } else if (a.pausa_id) {
        tipo = 'pausa';
        estado = a.pausa_motivo || 'En pausa';
        desde = Math.floor((ahora - new Date(a.pausa_desde).getTime()) / 1000);
        limite = a.pausa_limite ? Number(a.pausa_limite) * 60 : null;
      } else {
        tipo = 'disponible';
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
        tipo,
        desde: desde < 0 ? 0 : desde,
        limite,
        numero: canal ? canal.numero : null,
        hoy: delDia.get(a.id) || { llamadas: 0, contestadas: 0, segundos: 0 },
      };
    });

    if (visibles) {
      lista = lista.filter((a) => visibles.includes(a.campana_id));
    }

    /* ── Indicadores ─────────────────────────────────────────────── */
    const enLlamada = lista.filter((a) => a.tipo === 'llamada').length;
    const disponibles = lista.filter((a) => a.tipo === 'disponible').length;
    const enPausa = lista.filter((a) => a.tipo === 'pausa').length;

    /* ── Llamadas del día, de la base ────────────────────────────
       Solo las de las campañas que ve quien pregunta. Antes contaba las
       de toda la operación, y un supervisor veía números que no eran
       los de sus campañas. */
    const fd = filtroCampanas(visibles, 'campana_id');
    const hoy = await bd.una(
      `SELECT COUNT(*) AS total,
              SUM(contestada = 1) AS contestadas,
              SUM(contestada = 0) AS abandonadas
         FROM interaccion
        WHERE inicio >= CURDATE()${fd.sql}`, fd.val).catch(() => null);

    const cola = await colasDe(visibles);

    res.json({
      momento: new Date(),
      agentes: lista,
      kpis: {
        conectados: lista.length,
        enLlamada,
        disponibles,
        enPausa,
        llamadasHoy: Number(hoy?.total) || 0,
        contestadasHoy: Number(hoy?.contestadas) || 0,
        abandonadasHoy: Number(hoy?.abandonadas) || 0,
      },
      cola,
      /* Si no se pudo consultar a Asterisk, se dice. El supervisor
         verá los agentes conectados pero no quién está en llamada, y
         es mejor que lo sepa a que lo deduzca. */
      telefonia: cli.ok
        ? { ok: true, canales: canales.length }
        : { ok: false, motivo: cli.motivo },
    });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════════════════════════════
   GET /api/vivo/horas

   Cuántas llamadas hubo en cada hora, hoy y ayer, para el gráfico del
   día. Se pide cada minuto, no cada tres segundos: el dato cambia
   despacio y la consulta recorre todas las llamadas de dos días.
   ═══════════════════════════════════════════════════════════════════ */
router.get('/vivo/horas', auth.exigirSesion, auth.exigir('supervision'), async (req, res, next) => {
  try {
    const visibles = await campanasVisibles(req.usuario);
    const f = filtroCampanas(visibles, 'campana_id');

    const filas = await bd.consultar(
      `SELECT DATE(inicio) = CURDATE() AS es_hoy, HOUR(inicio) AS hora,
              COUNT(*) AS llamadas, SUM(contestada = 1) AS contestadas
         FROM interaccion
        WHERE inicio >= SUBDATE(CURDATE(), 1)${f.sql}
        GROUP BY es_hoy, hora`, f.val);

    const vacio = () => Array.from({ length: 24 }, () => ({ llamadas: 0, contestadas: 0 }));
    const hoy = vacio(), ayer = vacio();
    filas.forEach((x) => {
      const dia = Number(x.es_hoy) ? hoy : ayer;
      dia[Number(x.hora)] = { llamadas: Number(x.llamadas) || 0, contestadas: Number(x.contestadas) || 0 };
    });

    res.json({ hoy, ayer, horaActual: new Date().getHours() });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════════════════════════════
   GET /api/escuchas/recientes?dias=7

   Quién escuchó a quién y cuándo. Cada escucha se guarda en la tabla
   auditoria al momento de autorizarla (entidad "escucha", con el id
   del agente escuchado); esto solo la lee.

   El administrador ve todas. Un supervisor, las que se hicieron a
   agentes de sus campañas, sin importar quién escuchó: así ve también
   si otro supervisor escuchó a su gente.
   ═══════════════════════════════════════════════════════════════════ */

/* El texto que se guardó dice el modo: "escuchó a Ana (extensión 1011)" */
const MODO_ESCUCHA = [
  [/^escuchó a /, 'Escuchó'],
  [/^susurró a /, 'Susurró'],
  [/^entró a la llamada de /, 'Entró a la llamada'],
];

router.get('/escuchas/recientes', auth.exigirSesion, auth.exigir('escucha'), async (req, res, next) => {
  try {
    /* Hoy, la última semana o el último mes. Nada más largo: para eso
       está la base de datos, y una lista de miles no la lee nadie. */
    const dias = [1, 7, 30].includes(Number(req.query.dias)) ? Number(req.query.dias) : 7;
    const desde = dias === 1 ? 'CURDATE()' : `CURDATE() - INTERVAL ${dias - 1} DAY`;

    const visibles = await campanasVisibles(req.usuario);
    const f = filtroCampanas(visibles, 'ag.campana_id');

    const filas = await bd.consultar(
      `SELECT a.fecha, a.detalle, s.nombre AS supervisor,
              ag.nombre AS agente, ag.extension, c.nombre AS campana
         FROM auditoria a
         LEFT JOIN usuario s  ON s.id = a.usuario_id
         LEFT JOIN usuario ag ON ag.id = a.entidad_id
         LEFT JOIN campana c  ON c.id = ag.campana_id
        WHERE a.entidad = 'escucha' AND a.fecha >= ${desde}${f.sql}
        ORDER BY a.fecha DESC
        LIMIT 300`, f.val);

    res.json({
      dias,
      escuchas: filas.map((x) => ({
        fecha: x.fecha,
        supervisor: x.supervisor || '—',
        agente: x.agente || '—',
        extension: x.extension,
        campana: x.campana || '—',
        modo: (MODO_ESCUCHA.find(([re]) => re.test(x.detalle || '')) || [, 'Escuchó'])[1],
      })),
    });
  } catch (e) { next(e); }
});

module.exports = router;