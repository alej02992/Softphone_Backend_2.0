/* ═══════════════════════════════════════════════════════════════════
   MOTOR DE MARCACIÓN AUTOMÁTICA

   Un ciclo que se repite cada pocos segundos y hace siempre lo mismo:

     1. ¿Qué bases están activas, en marcación automática y en horario?
     2. ¿Qué agentes de esa campaña están conectados y libres?
     3. Por cada agente libre, tomar el siguiente contacto y ordenarle
        a Asterisk que marque.
     4. Escuchar qué pasó con cada llamada y anotarlo.

   QUÉ SIGNIFICA "LIBRE"
   Un agente está libre si tiene la sesión abierta, no está en pausa y
   no tiene ningún contacto en la mano. Esto último es la clave: en
   cuanto se le asigna uno, deja de estar libre, así que el ciclo
   siguiente no le manda otro.

   SI EL AGENTE NO CONTESTA SU PROPIA EXTENSIÓN
   El contacto vuelve a la cola SIN contar como intento: el cliente
   nunca supo que lo llamaron, así que sería injusto gastarle un
   intento. Y si al agente le pasa dos veces seguidas, se le pone en
   pausa automáticamente: algo le ocurre y no tiene sentido seguir
   mandándole llamadas que nadie atiende.

   POR QUÉ UN CICLO Y NO REACCIONAR A EVENTOS
   Un ciclo que mira el estado real cada pocos segundos se recupera
   solo de cualquier fallo: si se perdió un evento, si se cayó el AMI,
   si alguien tocó la base a mano, la siguiente vuelta lo corrige. Un
   motor basado solo en eventos se queda trabado cuando pierde uno.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const bd = require('./bd');
const ami = require('./ami');

/* Cada cuánto se repite el ciclo */
const CICLO_MS = 4000;
/* Cuánto se espera a que alguien conteste antes de darla por perdida */
const ESPERA_TIMBRE = 30;
/* Si una llamada lleva más de esto "llamando", algo se perdió */
const MINUTOS_ATASCO = 3;
/* Cuántas veces seguidas puede un agente no contestar antes de pausarlo */
const FALLOS_PARA_PAUSA = 2;

let reloj = null;
let trabajando = false;
const fallosPorAgente = new Map();
const historial = [];          // últimas decisiones, para diagnóstico

function anotar(texto) {
  historial.unshift({ cuando: new Date(), texto });
  historial.length = Math.min(historial.length, 50);
}

/* ═══════════ CONSULTAS ═══════════ */

/** Bases que deben estar marcando ahora mismo. */
async function basesActivas() {
  const ahora = new Date();
  const dia = ['D', 'L', 'M', 'X', 'J', 'V', 'S'][ahora.getDay()];
  const hora = ahora.toTimeString().slice(0, 8);

  const filas = await bd.consultar(
    `SELECT id, campana_id, nombre, simultaneas, dias, hora_inicio, hora_fin
       FROM base
      WHERE estado = 'activa' AND marcacion_auto = TRUE
        AND ? BETWEEN hora_inicio AND hora_fin`, [hora]);

  return filas.filter((b) =>
    String(b.dias).split(',').map((d) => d.trim()).includes(dia));
}

/**
 * Agentes de una campaña listos para recibir una llamada: con sesión
 * abierta, sin pausa y sin ningún contacto en la mano.
 */
async function agentesLibres(campanaId) {
  return bd.consultar(
    `SELECT u.id, u.nombre, u.extension
       FROM usuario u
       JOIN sesion s ON s.usuario_id = u.id AND s.cerrada IS NULL AND s.vence > NOW()
      WHERE u.activo = TRUE
        AND u.campana_id = ?
        AND u.extension IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pausa p
                         WHERE p.usuario_id = u.id AND p.fin IS NULL)
        /* Ocupado mientras tenga una llamada en curso, o mientras le
           dure el tiempo de cierre después de colgar. Al vencer ese
           tiempo vuelve a contar como libre aunque no haya tipificado:
           así la operación no se detiene esperando a una persona. */
        AND NOT EXISTS (
          SELECT 1 FROM base_contacto c JOIN base b2 ON b2.id = c.base_id
           WHERE c.agente_id = u.id
             AND (c.estado = 'llamando'
               OR (c.estado = 'asignado'
                   AND (c.colgado_en IS NULL
                        OR c.colgado_en > DATE_SUB(NOW(), INTERVAL b2.cierre_seg SECOND)))))
      GROUP BY u.id`, [campanaId]);
}

/** Toma el siguiente contacto para un agente. Se marca primero y se
    lee después, igual que en el reparto manual: así dos ciclos no
    pueden llevarse el mismo. */
async function tomarContacto(baseId, agenteId) {
  const [r] = await bd.pool.execute(
    `UPDATE base_contacto
        SET estado = 'llamando', agente_id = ?, asignado_en = NOW(), llamado_en = NOW()
      WHERE base_id = ?
        AND estado IN ('pendiente', 'agendado')
        AND (proximo_intento IS NULL OR proximo_intento <= NOW())
        AND (agendado_para IS NULL OR agendado_para <= NOW())
      ORDER BY (agendado_para IS NOT NULL) DESC, agendado_para ASC, id ASC
      LIMIT 1`,
    [agenteId, baseId]);

  if (!r.affectedRows) return null;

  return bd.una(
    `SELECT id, telefono_1, telefono_2, nombre, intentos
       FROM base_contacto
      WHERE agente_id = ? AND estado = 'llamando'
      ORDER BY llamado_en DESC, id DESC LIMIT 1`, [agenteId]);
}

/** Llamadas que quedaron colgadas: se ordenó marcar y nunca llegó el
    resultado. Vuelven a la cola sin gastar intento. */
async function soltarAtascadas() {
  const atascadas = await bd.consultar(
    `SELECT id, agente_id FROM base_contacto
      WHERE estado = 'llamando'
        AND llamado_en < DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [MINUTOS_ATASCO]);

  for (const c of atascadas) {
    await bd.consultar(
      `UPDATE base_contacto
          SET estado = 'pendiente', agente_id = NULL, asignado_en = NULL, canal = NULL
        WHERE id = ?`, [c.id]);
    anotar(`Contacto ${c.id} llevaba demasiado tiempo llamando: vuelve a la cola`);
  }
}

/* ═══════════ EL CICLO ═══════════ */

/**
 * Cierra las gestiones cuya ventana de tipificación ya venció.
 *
 * Si el agente colgó y no escribió el resultado dentro del tiempo de
 * cierre, la gestión se guarda igual marcada como sin tipificar. Si no
 * se hiciera, un agente distraído dejaría contactos bloqueados y la
 * base se iría frenando sola.
 */
async function cerrarVencidas() {
  const vencidas = await bd.consultar(
    `SELECT c.id, c.agente_id
       FROM base_contacto c JOIN base b ON b.id = c.base_id
      WHERE c.estado = 'asignado'
        AND b.marcacion_auto = TRUE
        AND c.colgado_en IS NOT NULL
        AND c.colgado_en <= DATE_SUB(NOW(), INTERVAL b.cierre_seg SECOND)`);

  for (const c of vencidas) {
    await bd.consultar(
      `UPDATE base_contacto
          SET estado = 'gestionado', gestionado_en = NOW(),
              resultado = COALESCE(resultado, 'Sin tipificar'),
              intentos = intentos + 1, ultimo_intento = NOW()
        WHERE id = ? AND estado = 'asignado'`, [c.id]);
    anotar(`Contacto ${c.id}: se cerró solo al vencer el tiempo de cierre`);
  }
}

async function vuelta() {
  if (trabajando) return;            // no se solapan dos vueltas
  if (!ami.estado().conectado) return;

  trabajando = true;
  try {
    await soltarAtascadas();
    await cerrarVencidas();

    for (const base of await basesActivas()) {
      const libres = await agentesLibres(base.campana_id);
      if (!libres.length) continue;

      /* Con simultaneas en 1 se marca una llamada por agente libre.
         Por encima de 1 se marca de más —predictiva—, con el riesgo de
         que alguien conteste y no haya agente. */
      const cuantas = Math.max(1, Math.round(libres.length * Number(base.simultaneas || 1)));

      for (let i = 0; i < Math.min(cuantas, libres.length); i++) {
        const agente = libres[i];
        const contacto = await tomarContacto(base.id, agente.id);
        if (!contacto) break;        // no quedan contactos en esta base

        /* Si ya se intentó y hay segundo teléfono, se usa ese */
        const numero = (contacto.intentos > 0 && contacto.telefono_2)
          ? contacto.telefono_2 : contacto.telefono_1;

        try {
          await ami.originar({
            numero,
            extension: agente.extension,
            identificador: String(contacto.id),
            espera: ESPERA_TIMBRE,
            datos: { BPM_AGENTE: agente.id, BPM_BASE: base.id },
          });
          anotar(`Marcando ${numero} para ${agente.nombre}`);
        } catch (e) {
          /* No se pudo ni ordenar la llamada: el contacto vuelve a la
             cola sin gastar intento, porque el cliente no supo nada. */
          await bd.consultar(
            `UPDATE base_contacto
                SET estado = 'pendiente', agente_id = NULL, asignado_en = NULL
              WHERE id = ?`, [contacto.id]);
          anotar(`No se pudo marcar a ${numero}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    anotar('Error en el ciclo: ' + e.message);
  } finally {
    trabajando = false;
  }
}

/* ═══════════ LO QUE RESPONDE ASTERISK ═══════════ */

/**
 * Asterisk avisa cómo terminó cada intento de llamada. De aquí sale
 * saber si contestaron sin que el agente tenga que decirlo.
 */
async function alResponder(evento) {
  /* El identificador del contacto viaja en la llamada y vuelve aquí */
  const id = Number(evento.BPM_ID || evento.Variable?.BPM_ID);
  if (!id) return;

  const c = await bd.una(
    `SELECT c.*, b.reintentos, b.intervalo_min
       FROM base_contacto c JOIN base b ON b.id = c.base_id
      WHERE c.id = ? AND c.estado = 'llamando'`, [id]);
  if (!c) return;

  const exito = String(evento.Response || '').toLowerCase() === 'success';
  const motivo = String(evento.Reason || evento.Cause || '');

  /* ── Contestaron: el agente ya está hablando ──
     El contacto queda en sus manos; él dirá cómo terminó. */
  if (exito) {
    await bd.consultar(
      `UPDATE base_contacto SET estado = 'asignado', canal = ? WHERE id = ?`,
      [evento.Channel || null, id]);
    fallosPorAgente.delete(c.agente_id);
    anotar(`Contacto ${id}: conectado con el agente`);
    return;
  }

  /* ── No se logró la llamada ──
     Hay dos casos muy distintos y conviene separarlos. */

  /* El agente no contestó su propia extensión. El cliente nunca supo
     nada, así que no se le gasta un intento. */
  const culpaDelAgente = /noanswer|no answer|busy|chanunavail|congestion/i.test(motivo)
    && evento.Contexto === 'agente';

  if (culpaDelAgente) {
    await bd.consultar(
      `UPDATE base_contacto
          SET estado = 'pendiente', agente_id = NULL, asignado_en = NULL, canal = NULL
        WHERE id = ?`, [id]);

    const fallos = (fallosPorAgente.get(c.agente_id) || 0) + 1;
    fallosPorAgente.set(c.agente_id, fallos);
    anotar(`El agente no contestó (${fallos} seguidas). El contacto vuelve a la cola.`);

    /* Dos veces seguidas: se le pone en pausa para dejar de mandarle
       llamadas que nadie atiende. */
    if (fallos >= FALLOS_PARA_PAUSA) {
      await pausarAgente(c.agente_id);
      fallosPorAgente.delete(c.agente_id);
    }
    return;
  }

  /* El cliente no contestó: sí cuenta como intento. */
  const intentos = c.intentos + 1;
  const quedan = intentos <= c.reintentos;

  await bd.consultar(
    `UPDATE base_contacto
        SET estado = ?, intentos = ?, ultimo_intento = NOW(), proximo_intento = ?,
            resultado = ?, agente_id = NULL, asignado_en = NULL, canal = NULL
      WHERE id = ?`,
    [quedan ? 'pendiente' : 'sin_contacto', intentos,
     quedan ? new Date(Date.now() + c.intervalo_min * 60000) : null,
     motivo ? `Sin respuesta (${motivo})` : 'No contesta', id]);

  anotar(`Contacto ${id}: no contestó. Intento ${intentos} de ${c.reintentos + 1}`);
}

/**
 * Asterisk avisa cuando se cuelga un canal. Si era el de una gestión en
 * curso, aquí empieza a contar el tiempo que tiene el agente para
 * escribir el resultado antes de que entre la siguiente llamada.
 */
async function alColgar(evento) {
  const [r] = await bd.pool.execute(
    `UPDATE base_contacto SET colgado_en = NOW()
      WHERE canal = ? AND estado = 'asignado' AND colgado_en IS NULL`,
    [evento.Channel]);

  if (r.affectedRows) anotar(`Llamada terminada en ${evento.Channel}: empieza el cierre`);
}

/** Pone al agente en pausa porque no está atendiendo las llamadas. */
async function pausarAgente(usuarioId) {
  try {
    const tipo = await bd.una(
      `SELECT id FROM pausa_tipo WHERE activo = TRUE ORDER BY id LIMIT 1`);
    if (!tipo) return;

    await bd.consultar(
      'UPDATE pausa SET fin = NOW() WHERE usuario_id = ? AND fin IS NULL', [usuarioId]);
    await bd.consultar(
      'INSERT INTO pausa (usuario_id, pausa_tipo_id, inicio) VALUES (?, ?, NOW())',
      [usuarioId, tipo.id]);

    anotar(`Agente ${usuarioId} puesto en pausa: no contestó dos llamadas seguidas`);
  } catch (e) {
    anotar('No se pudo pausar al agente: ' + e.message);
  }
}

/* ═══════════ ARRANQUE ═══════════ */

function arrancar() {
  if (reloj) return;

  /* Los eventos de Asterisk que interesan. OriginateResponse llega
     cuando termina el intento de llamada. */
  ami.on('evento', (e) => {
    if (e.Event === 'OriginateResponse') alResponder(e).catch(() => {});
    /* Al colgar empieza a correr el tiempo de cierre del agente */
    if (e.Event === 'Hangup' && e.Channel) alColgar(e).catch(() => {});
  });

  reloj = setInterval(() => { vuelta().catch(() => {}); }, CICLO_MS);
  anotar('Motor de marcación iniciado');
}

function detener() {
  clearInterval(reloj);
  reloj = null;
  anotar('Motor de marcación detenido');
}

/** Para mostrar en la plataforma qué está haciendo. */
const estado = () => ({
  andando: !!reloj,
  canal: ami.estado(),
  ultimas: historial.slice(0, 15),
});

module.exports = { arrancar, detener, estado, vuelta };
