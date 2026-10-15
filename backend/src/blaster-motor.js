/* ═══════════════════════════════════════════════════════════════════
   MOTOR DEL BLASTER

   Toma los destinatarios de los blasters activos y los llama. Cuando
   el cliente contesta, la central le reproduce el mensaje y cuelga.

   ES UN ARCHIVO APARTE DEL MOTOR DE MARCACIÓN, A PROPÓSITO
   El de marcación reparte llamadas entre agentes y está probado en
   producción. Este no tiene agentes: marca al cliente y reproduce un
   audio. Mezclarlos habría puesto en riesgo lo que ya funciona.

   CÓMO FUNCIONA
   Un ciclo cada cinco segundos:
     1. Busca blasters en curso, aprobados y dentro de su horario.
     2. Cuenta cuántas llamadas hay en curso y respeta el tope.
     3. Toma destinatarios pendientes, genera su audio si hace falta
        y ordena llamarlos.
     4. Cuando la central responde, anota si contestaron o no.
     5. Si ya no queda nadie por llamar, da el blaster por terminado.

   Igual que el motor de marcación, es un ciclo y no una reacción a
   eventos: si se pierde un aviso de la central, la vuelta siguiente
   lo corrige.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const bd = require('./bd');
const ami = require('./ami');
const voz = require('./voz');
const CONFIG = require('./config');

/* Cada cuánto se revisa */
const CICLO_MS = 5000;

/* Cuántas llamadas del blaster puede haber a la vez, sumando todos.
   Cada una ocupa un canal de la troncal: si se pasa del límite del
   operador, las llamadas fallan o, peor, bloquean las de los agentes. */
const SIMULTANEAS = Number(process.env.BLASTER_SIMULTANEAS) || 5;

/* Una llamada que no recibió respuesta de la central en este tiempo se
   da por perdida y se cuenta como intento. */
const MINUTOS_ATASCO = 3;

let reloj = null;
let trabajando = false;

/* Las llamadas en vuelo: identificador de la orden → destinatario.
   La central devuelve ese mismo identificador cuando responde, y es la
   forma fiable de saber a qué número corresponde cada aviso. */
const enVuelo = new Map();

const ultimas = [];
function anotar(texto) {
  ultimas.unshift({ cuando: new Date().toISOString(), texto });
  if (ultimas.length > 30) ultimas.length = 30;
}

/* ═══════════ QUÉ TOCA LLAMAR ═══════════ */

const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/** Los blasters que pueden marcar ahora mismo. */
async function blastersActivos() {
  const hoy = DIAS[new Date().getDay()];

  return bd.consultar(
    `SELECT id, nombre, tipo, guion, audio_archivo, voz_id,
            respuesta, respuesta_tipo, respuesta_guion, respuesta_opciones,
            respuesta_digitos, reintentos, intervalo_min
       FROM blaster
      WHERE estado = 'activo'
        AND aprobado = TRUE
        AND CURTIME() BETWEEN hora_inicio AND hora_fin
        AND FIND_IN_SET(?, dias) > 0`, [hoy]);
}

/** Cuántas llamadas del blaster están en curso, en total. */
async function enCurso() {
  const r = await bd.una(
    "SELECT COUNT(*) AS n FROM blaster_destinatario WHERE estado = 'llamando'");
  return Number(r.n) || 0;
}

/* ═══════════ EL AUDIO DE CADA DESTINATARIO ═══════════ */

/**
 * Devuelve la ruta que Asterisk necesita para reproducir el mensaje.
 *
 * Asterisk pide la ruta SIN extensión: elige solo el formato. Por eso
 * se quita aquí.
 *
 *   audio grabado      → el mismo archivo para todos
 *   texto              → se genera una vez y se reutiliza
 *   texto con variables → uno por persona, con su nombre o sus datos
 */
async function audioPara(b, d) {
  let archivo;

  /* Primero, lo que ya se generó. La plataforma genera los audios ANTES
     de lanzar el blaster —para que el supervisor los escuche— y aquí se
     reutilizan. Generarlos otra vez al llamar gastaría el doble de
     créditos del servicio de voz, que se cobra por carácter. */
  if (d.audio_archivo) {
    archivo = d.audio_archivo;

  } else if (b.tipo === 'audio' || (b.tipo === 'texto' && b.audio_archivo)) {
    archivo = b.audio_archivo;

  } else {
    /* El texto, con las variables de cada persona reemplazadas */
    let texto = String(b.guion || '');
    if (b.tipo === 'variables') {
      let datos = {};
      try { datos = typeof d.datos === 'string' ? JSON.parse(d.datos) : (d.datos || {}); }
      catch { datos = {}; }
      datos.nombre = datos.nombre || d.nombre || '';
      texto = texto.replace(/\{(\w+)\}/g, (_, k) => String(datos[k] ?? ''));
    }

    const pregunta = String(b.respuesta_guion || '').trim();
    if (b.respuesta && pregunta) texto = `${texto} ${pregunta}`;

    const r = await voz.generar(texto, b.voz_id, `blaster-${b.id}`);
    if (r.error) throw new Error(r.error);
    archivo = r.archivo;
  }

  if (!archivo) throw new Error('El blaster no tiene audio');

  const ruta = path.isAbsolute(archivo) ? archivo : path.join(voz.CARPETA, archivo);
  return ruta.replace(/\.(wav|ulaw|alaw|gsm|sln|mp3)$/i, '');
}

/* ═══════════ LLAMAR ═══════════ */

async function llamar(b, d) {
  /* Primero se reserva el destinatario, después se lee. Si otro ciclo
     estuviera corriendo a la vez, no podría tomar el mismo. Es la misma
     lógica que evita en el motor de marcación que dos agentes reciban
     el mismo contacto. */
  const [r] = await bd.pool.execute(
    `UPDATE blaster_destinatario
        SET estado = 'llamando', ultimo_intento = NOW()
      WHERE id = ? AND estado = 'pendiente'`, [d.id]);
  if (!r.affectedRows) return;

  let audio;
  try {
    audio = await audioPara(b, d);
  } catch (e) {
    /* Sin audio no tiene sentido llamar: el cliente contestaría y
       escucharía silencio. Se marca el fallo y se sigue con el resto. */
    await bd.consultar(
      "UPDATE blaster_destinatario SET estado = 'fallida' WHERE id = ?", [d.id]);
    anotar(`Destinatario ${d.id}: no se pudo generar el audio (${e.message})`);
    return;
  }

  try {
    const resp = await ami.originarBlaster({
      numero: d.numero,
      audio,
      /* Si se pide respuesta, cuántas teclas escuchar: una sola para
         "marque 1 o 2", o varias para "digite su documento". */
      digitos: !b.respuesta ? 0
        : b.respuesta_tipo === 'numero' ? (b.respuesta_digitos || 10) : 1,
      identificador: `blaster-${d.id}`,
      contextoSalida: CONFIG.blaster?.contextoSalida || 'from-internal',
    });

    if (resp?.ActionID) enVuelo.set(resp.ActionID, d.id);
    anotar(`Llamando a ${d.numero} (${b.nombre})`);
  } catch (e) {
    await terminarIntento(d.id, b, false);
    anotar(`No se pudo llamar a ${d.numero}: ${e.message}`);
  }
}

/* ═══════════ EL RESULTADO ═══════════ */

/**
 * Cierra un intento: contestó, o no contestó y quizá se reintenta.
 */
async function terminarIntento(destinoId, b, contesto) {
  if (contesto) {
    await bd.consultar(
      `UPDATE blaster_destinatario
          SET estado = 'contestada', intentos = intentos + 1
        WHERE id = ?`, [destinoId]);
    return;
  }

  const d = await bd.una(
    'SELECT intentos FROM blaster_destinatario WHERE id = ?', [destinoId]);
  const intentos = (d?.intentos || 0) + 1;
  const quedan = intentos <= (b?.reintentos ?? 2);

  await bd.consultar(
    `UPDATE blaster_destinatario
        SET estado = ?, intentos = ?, proximo_intento = ?
      WHERE id = ?`,
    [quedan ? 'pendiente' : 'sin_respuesta', intentos,
     quedan ? new Date(Date.now() + (b?.intervalo_min || 30) * 60000) : null,
     destinoId]);
}

/** La central avisó qué pasó con una llamada que se ordenó. */
async function alResponder(e) {
  const destinoId = enVuelo.get(e.ActionID);
  if (!destinoId) return;                    // no es nuestra
  enVuelo.delete(e.ActionID);

  const d = await bd.una(
    `SELECT d.id, b.reintentos, b.intervalo_min
       FROM blaster_destinatario d JOIN blaster b ON b.id = d.blaster_id
      WHERE d.id = ?`, [destinoId]);
  if (!d) return;

  /* "Success" significa que el cliente contestó y se le pasó al
     contexto que reproduce el audio. Cualquier otra cosa —no contestó,
     ocupado, número inválido— cuenta como intento fallido. */
  const contesto = e.Response === 'Success';
  await terminarIntento(destinoId, d, contesto);
}

/* ═══════════ LA RESPUESTA DEL CLIENTE ═══════════

   Cuando el cliente marca, el plan de marcación lo avisa con un evento
   propio, "BlasterRespuesta", que trae el identificador del
   destinatario y lo que marcó. Aquí se guarda.                        */

async function alResponderCliente(e) {
  const m = /^blaster-(\d+)$/.exec(String(e.Id || ''));
  if (!m) return;

  const valor = String(e.Valor || '').replace(/[^0-9*#]/g, '').slice(0, 40);
  if (!valor) return;                      // no marcó nada

  const d = await bd.una(
    `SELECT d.id, d.numero, d.blaster_id, b.respuesta_tipo, b.respuesta_opciones
       FROM blaster_destinatario d JOIN blaster b ON b.id = d.blaster_id
      WHERE d.id = ?`, [Number(m[1])]);
  if (!d) return;

  /* Si se pedía una tecla, solo cuentan las que se ofrecieron. Una
     tecla fuera de la lista se guarda marcada como inválida, para que
     el reporte no la cuente como un sí o un no. */
  const validas = String(d.respuesta_opciones || '').split(',').map((x) => x.trim()).filter(Boolean);
  const final = d.respuesta_tipo === 'tecla' && validas.length && !validas.includes(valor)
    ? `invalida:${valor}` : valor;

  await bd.consultar(
    `INSERT INTO blaster_respuesta (blaster_id, destinatario_id, numero, valor)
     VALUES (?, ?, ?, ?)`, [d.blaster_id, d.id, d.numero, final]);

  anotar(`Respuesta de ${d.numero}: ${final}`);
}

/* ═══════════ LIMPIEZA ═══════════ */

/** Las que quedaron "llamando" sin respuesta de la central. */
async function soltarAtascadas() {
  const atascadas = await bd.consultar(
    `SELECT d.id, b.reintentos, b.intervalo_min
       FROM blaster_destinatario d JOIN blaster b ON b.id = d.blaster_id
      WHERE d.estado = 'llamando'
        AND d.ultimo_intento < DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [MINUTOS_ATASCO]);

  for (const d of atascadas) {
    await terminarIntento(d.id, d, false);
    anotar(`Destinatario ${d.id}: sin respuesta de la central, se reintentará`);
  }
}

/** Los blasters que ya no tienen a nadie por llamar. */
async function cerrarTerminados() {
  await bd.consultar(
    `UPDATE blaster b SET b.estado = 'terminado'
      WHERE b.estado = 'activo'
        AND NOT EXISTS (
          SELECT 1 FROM blaster_destinatario d
           WHERE d.blaster_id = b.id AND d.estado IN ('pendiente','llamando'))`);
}

/* ═══════════ EL CICLO ═══════════ */

async function vuelta() {
  if (trabajando) return;
  if (!ami.estado().conectado) return;       // sin central no hay nada que hacer
  trabajando = true;

  try {
    await soltarAtascadas();

    let libres = SIMULTANEAS - await enCurso();
    if (libres <= 0) return;

    for (const b of await blastersActivos()) {
      if (libres <= 0) break;

      const destinos = await bd.consultar(
        `SELECT id, numero, nombre, datos, audio_archivo
           FROM blaster_destinatario
          WHERE blaster_id = ? AND estado = 'pendiente'
            AND (proximo_intento IS NULL OR proximo_intento <= NOW())
            AND numero NOT IN (SELECT numero FROM no_llamar)
          ORDER BY id
          LIMIT ?`, [b.id, libres]);

      for (const d of destinos) {
        await llamar(b, d);
        libres--;
      }
    }

    await cerrarTerminados();
  } catch (e) {
    anotar('Error en el ciclo: ' + e.message);
  } finally {
    trabajando = false;
  }
}

/* ═══════════ ARRANCAR ═══════════ */

function arrancar() {
  if (reloj) return;

  ami.on('evento', (e) => {
    if (e.Event === 'OriginateResponse') alResponder(e).catch(() => {});
    if (e.Event === 'UserEvent' && e.UserEvent === 'BlasterRespuesta') {
      alResponderCliente(e).catch(() => {});
    }
  });

  reloj = setInterval(vuelta, CICLO_MS);
  anotar('Motor del blaster iniciado');
}

function detener() {
  clearInterval(reloj);
  reloj = null;
}

const estado = () => ({
  andando: !!reloj,
  enVuelo: enVuelo.size,
  simultaneas: SIMULTANEAS,
  ultimas: ultimas.slice(0, 15),
});

module.exports = { arrancar, detener, estado, vuelta };
