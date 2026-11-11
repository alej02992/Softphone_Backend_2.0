/* ═══════════════════════════════════════════════════════════════════
   BPM CONSULTING · TRADUCTOR DE FLUJOS IVR A PLAN DE MARCACIÓN

   Convierte el dibujo de cada flujo activo en contextos de Asterisk y
   los escribe en /etc/asterisk/extensions_flujos.conf, un archivo solo
   de flujos: nunca se toca extensions.conf.

   Cada bloque se vuelve una extensión dentro del contexto del flujo
   (b1, b2…). Las flechas son saltos (Goto) entre esas extensiones.

   SEGURIDAD: al archivo solo llegan valores de listas cerradas —teclas,
   números, nombres de audios que existen en disco, colas y extensiones
   leídas de la base—. Ningún texto que escribe el usuario llega tal cual
   al plan de marcación: sería el equivalente a una inyección SQL.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const bd = require('./bd');
const CONFIG = require('./config');

const ARCHIVO = '/etc/asterisk/extensions_flujos.conf';
const CARPETA_AUDIO = CONFIG.tts?.carpeta || '/var/lib/asterisk/sounds/blaster';
const PREFIJO_PRUEBA = '*77';

/**
 * Un número de entrada, como se guarda: solo dígitos; si tiene diez o
 * más, los últimos diez (el número nacional sin 57 ni +57). Devuelve
 * null si no es un número válido.
 */
function normalizar(numero) {
  const d = String(numero || '').replace(/[\s().-]/g, '').replace(/^\+/, '');
  if (!/^\d{3,15}$/.test(d)) return null;
  return d.length >= 10 ? d.slice(-10) : d;
}

/* Las formas en que puede llegar un número nacional de diez dígitos */
const formas = (n) => (n.length === 10 ? [n, `57${n}`, `+57${n}`, `0057${n}`] : [n]);

const DIAS = { L: 'mon', M: 'tue', X: 'wed', J: 'thu', V: 'fri', S: 'sat', D: 'sun' };

/* ═══════════ VALIDAR CONTRA LA REALIDAD ═══════════
   La pantalla ya revisa que el flujo esté completo. Aquí se revisa otra
   vez, y además contra lo que existe de verdad: el audio en disco, la
   campaña con su cola, la extensión del usuario.                       */

const soloNombre = /^[\w.-]{1,120}$/;
const baseAudio = (archivo) => String(archivo || '').replace(/\.(ulaw|wav|gsm|sln|mp3)$/i, '');
function audioExiste(archivo) {
  if (!soloNombre.test(String(archivo || ''))) return false;
  const base = baseAudio(archivo);
  return ['ulaw', 'wav', 'gsm', 'sln'].some((ext) => fs.existsSync(path.join(CARPETA_AUDIO, `${base}.${ext}`)));
}

async function revisar(diseno) {
  const errores = [];
  const { nodos = [], flechas = [] } = diseno || {};
  const salida = (id, clave) => flechas.find((f) => f.desde === id && f.salida === clave);

  const campanas = new Map((await bd.consultar(
    `SELECT id, nombre, cola_asterisk FROM campana
      WHERE activa = TRUE AND cola_asterisk IS NOT NULL AND cola_asterisk <> ''`))
    .map((c) => [String(c.id), c]));
  const extensiones = new Set((await bd.consultar(
    "SELECT extension FROM usuario WHERE activo = TRUE AND extension IS NOT NULL AND extension <> ''"))
    .map((u) => String(u.extension)));

  const inicio = nodos.filter((n) => n.tipo === 'inicio');
  if (inicio.length !== 1) errores.push('El flujo debe tener un solo inicio');
  else if (!salida(inicio[0].id, 'siguiente')) errores.push('El inicio no va a ningún lado');

  for (const n of nodos) {
    const c = n.config || {};
    if (n.tipo === 'reproducir') {
      if (!audioExiste(c.audio)) errores.push(`Reproducir: el audio "${c.audio || '—'}" no existe en la central`);
      if (!salida(n.id, 'siguiente')) errores.push('Reproducir: la salida no va a ningún lado');
    }
    if (n.tipo === 'menu') {
      /* El audio del menú es opcional: sin él, el menú espera la tecla en
         silencio (por si el mensaje ya sonó antes). Si lo tiene, debe existir. */
      if (c.audio && !audioExiste(c.audio)) errores.push(`Menú: el audio "${c.audio}" no existe en la central`);
      const ops = c.opciones || [];
      if (!ops.length) errores.push('Menú: no tiene opciones');
      ops.forEach((o) => {
        if (!/^[0-9*]$/.test(String(o.tecla))) {
          errores.push(`Menú: la tecla "${o.tecla}" no se puede usar (la # cierra la marcación en la central)`);
        } else if (!salida(n.id, 'op' + o.tecla)) {
          errores.push(`Menú: la opción ${o.tecla} no va a ningún lado`);
        }
      });
    }
    if (n.tipo === 'campana' && !campanas.has(String(c.campana_id))) {
      errores.push('Pasar a campaña: la campaña no existe, no está activa o no tiene cola en la central');
    }
    if (n.tipo === 'persona' && (!/^\d{2,10}$/.test(String(c.extension || '')) || !extensiones.has(String(c.extension)))) {
      errores.push('Pasar a una persona: esa extensión no existe');
    }
    if (n.tipo === 'horario') {
      if (!(c.dias || []).some((d) => DIAS[d])) errores.push('Horario: no tiene días');
      if (!/^\d{2}:\d{2}$/.test(String(c.desde)) || !/^\d{2}:\d{2}$/.test(String(c.hasta)) || c.desde >= c.hasta) {
        errores.push('Horario: las horas no son válidas');
      }
      if (!salida(n.id, 'dentro') || !salida(n.id, 'fuera')) errores.push('Horario: le falta una salida');
    }
  }
  return { errores: [...new Set(errores)], campanas };
}

/* ═══════════ TRADUCIR UN FLUJO ═══════════ */

const entero = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function traducir(flujoId, diseno, campanas) {
  const id = entero(flujoId, 1, 999999, 0);
  const ctx = `bpm-flujo-${id}`;
  const { nodos, flechas } = diseno;

  /* Cada bloque se llama b1, b2…: los identificadores del dibujo nunca
     llegan al archivo. */
  const nombre = new Map(nodos.map((n, i) => [n.id, `b${i + 1}`]));
  const ir = (desde, clave) => {
    const f = flechas.find((x) => x.desde === desde && x.salida === clave);
    return f && nombre.has(f.hacia) ? `${nombre.get(f.hacia)},1` : 'fin,1';
  };
  const audio = (a) => path.join(CARPETA_AUDIO, baseAudio(a));

  const L = [`[${ctx}]`, `; Flujo ${id} · generado por la plataforma`];
  const inicio = nodos.find((n) => n.tipo === 'inicio');
  L.push(`exten => s,1,Goto(${nombre.get(inicio.id)},1)`);

  for (const n of nodos) {
    const b = nombre.get(n.id);
    const c = n.config || {};
    L.push('');

    if (n.tipo === 'inicio') {
      /* Contestar, marcar la llamada con su flujo y grabarla, como las
         llamadas de los agentes. */
      L.push(`exten => ${b},1,Answer()`,
        ` same => n,Set(BPM_FLUJO=${id})`,
        ' same => n,Set(calltime=${STRFTIME(${EPOCH},,%C%y%m%d-%H%M%S)})',
        ' same => n,Set(recfile=${calltime}_${CALLERID(num)}_ivr' + id + ')',
        ' same => n,MixMonitor(${recfile}.wav,b,ffmpeg -i /var/spool/asterisk/monitor/${recfile}.wav -b:a 64k /var/spool/asterisk/monitor/${recfile}.mp3 && rm -f /var/spool/asterisk/monitor/${recfile}.wav)',
        ' same => n,Wait(1)',
        ` same => n,Goto(${ir(n.id, 'siguiente')})`);
    }

    if (n.tipo === 'reproducir') {
      L.push(`exten => ${b},1,Playback(${audio(c.audio)})`,
        ` same => n,Goto(${ir(n.id, 'siguiente')})`);
    }

    if (n.tipo === 'menu') {
      /* Read con un solo dígito y un intento: los reintentos los cuenta
         el propio flujo, para poder salir por "No marcó" o "Tecla
         equivocada" al acabarse. */
      const espera = entero(c.espera, 2, 30, 5);
      const intentos = entero(c.intentos, 1, 5, 3);
      L.push(`exten => ${b},1,Set(INT_${b}=0)`,
        ` same => n(leer),Set(INT_${b}=$[\${INT_${b}} + 1])`,
        ` same => n,Read(OP_${b},${c.audio ? audio(c.audio) : ''},1,,1,${espera})`);
      (c.opciones || []).filter((o) => /^[0-9*]$/.test(String(o.tecla))).forEach((o) => {
        L.push(` same => n,GotoIf($["\${OP_${b}}" = "${o.tecla}"]?${ir(n.id, 'op' + o.tecla)})`);
      });
      L.push(` same => n,GotoIf($["\${OP_${b}}" = ""]?vacio)`,
        ` same => n,GotoIf($[\${INT_${b}} < ${intentos}]?leer)`,
        ` same => n,Goto(${ir(n.id, 'invalida')})`,
        ` same => n(vacio),GotoIf($[\${INT_${b}} < ${intentos}]?leer)`,
        ` same => n,Goto(${ir(n.id, 'sin_respuesta')})`);
    }

    if (n.tipo === 'campana') {
      const cp = campanas.get(String(c.campana_id));
      const cola = String(cp.cola_asterisk);
      if (!/^[\w-]{1,40}$/.test(cola)) throw new Error(`La cola de ${cp.nombre} tiene un nombre no válido`);
      L.push(`exten => ${b},1,Set(BPM_CAMPANA=${entero(cp.id, 1, 999999, 0)})`,
        ` same => n,Queue(${cola},,,,${entero(c.espera, 15, 1800, 300)})`,
        ` same => n,Goto(${ir(n.id, 'no_atendida')})`);
    }

    if (n.tipo === 'persona') {
      L.push(`exten => ${b},1,Dial(PJSIP/${String(c.extension).replace(/\D/g, '')},${entero(c.timbre, 5, 120, 25)})`,
        ` same => n,Goto(${ir(n.id, 'no_contesta')})`);
    }

    if (n.tipo === 'horario') {
      const dias = (c.dias || []).map((d) => DIAS[d]).filter(Boolean).join('&');
      L.push(`exten => ${b},1,GotoIfTime(${c.desde}-${c.hasta},${dias},*,*?${ir(n.id, 'dentro')})`,
        ` same => n,Goto(${ir(n.id, 'fuera')})`);
    }

    if (n.tipo === 'colgar') {
      L.push(`exten => ${b},1,Hangup()`);
    }
  }

  /* Adonde van las salidas sin flecha */
  L.push('', 'exten => fin,1,Hangup()');
  return L.join('\n');
}

/* ═══════════ ESCRIBIR Y RECARGAR ═══════════ */

const cli = (comando) => new Promise((ok) => {
  execFile('asterisk', ['-rx', comando], { timeout: 8000 }, (err, salida) =>
    ok({ ok: !err, salida: String(salida || ''), error: err && err.message }));
});

/**
 * Reescribe el archivo con todos los flujos activos y recarga la
 * central. Si la recarga falla, o algún contexto no aparece, vuelve al
 * archivo anterior y lo dice.
 */
async function publicar() {
  const activos = await bd.consultar("SELECT id, nombre, diseno FROM flujo WHERE estado = 'activo' ORDER BY id");

  const partes = [
    '; ═══════════════════════════════════════════════════════════════',
    ';  GENERADO POR LA PLATAFORMA BPM — NO EDITAR A MANO',
    ';  Cada vez que se activa o cambia un flujo, este archivo se',
    ';  reescribe completo.',
    '; ═══════════════════════════════════════════════════════════════',
    '',
    '; Probar un flujo sin número de entrada: marcar *77 + su número',
    '[bpm-flujos-prueba]',
    /* Dos patrones: "X" para los flujos 1 a 9, y "X." para los de dos
       cifras o más. "X." solo exige al menos dos dígitos. */
    `exten => _${PREFIJO_PRUEBA}X,1,Goto(bpm-flujo-\${EXTEN:${PREFIJO_PRUEBA.length}},s,1)`,
    `exten => _${PREFIJO_PRUEBA}X.,1,Goto(bpm-flujo-\${EXTEN:${PREFIJO_PRUEBA.length}},s,1)`,
    '',
  ];

  /* ── Las llamadas que entran por las troncales ──
     Toda llamada entra a "buscar", que mira qué flujo atiende el número:
     primero el que marcó el cliente, y si no aparece, el de la cabecera
     To (algunas troncales entregan la llamada a su propio usuario y el
     número real viene ahí). Si no hay flujo, el de los números sin
     asignar, o se cuelga dejando el número en el registro. */
  const numeros = await bd.consultar(
    `SELECT fn.numero, fn.flujo_id FROM flujo_numero fn
       JOIN flujo f ON f.id = fn.flujo_id AND f.estado = 'activo'`).catch(() => []);
  const porDefecto = numeros.find((x) => x.numero === '*');
  const destino = porDefecto
    ? `Goto(bpm-flujo-${entero(porDefecto.flujo_id, 1, 999999, 0)},s,1)` : 'Hangup()';

  partes.push(
    '; Llamadas que entran por las troncales: todas pasan por "buscar"',
    '[from-pstn]',
    'exten => _X.,1,Set(BPM_DID=${EXTEN})',
    ' same => n,Goto(bpm-entrada,buscar,1)',
    'exten => _+X.,1,Set(BPM_DID=${EXTEN})',
    ' same => n,Goto(bpm-entrada,buscar,1)',
    'exten => _[a-zA-Z].,1,Set(BPM_DID=${EXTEN})',
    ' same => n,Goto(bpm-entrada,buscar,1)',
    'exten => s,1,Set(BPM_DID=)',
    ' same => n,Goto(bpm-entrada,buscar,1)',
    '',
    '[bpm-entrada]',
    'exten => buscar,1,GotoIf($[${DIALPLAN_EXISTS(bpm-did,${BPM_DID},1)}]?bpm-did,${BPM_DID},1)',
    ' same => n,Set(BPM_TO=${PJSIP_HEADER(read,To)})',
    ' same => n,Set(BPM_TO=${CUT(BPM_TO,@,1)})',
    ' same => n,Set(BPM_DID_TO=${CUT(BPM_TO,:,2)})',
    ' same => n,GotoIf($[${DIALPLAN_EXISTS(bpm-did,${BPM_DID_TO},1)}]?bpm-did,${BPM_DID_TO},1)',
    ' same => n,NoOp(Llamada entrante a ${BPM_DID} (To: ${BPM_DID_TO}) sin flujo asignado)',
    ` same => n,${destino}`,
    '',
    '; Cada número de entrada, en todas las formas en que puede llegar',
    '[bpm-did]');
  numeros.filter((x) => x.numero !== '*').forEach((x) => {
    const n = normalizar(x.numero);
    if (!n) return;
    formas(n).forEach((forma) => partes.push(
      `exten => ${forma},1,Goto(bpm-flujo-${entero(x.flujo_id, 1, 999999, 0)},s,1)`));
  });

  const { campanas } = await revisar({ nodos: [], flechas: [] });
  for (const f of activos) {
    let d;
    try { d = JSON.parse(f.diseno); } catch { continue; }
    partes.push('', traducir(f.id, d, campanas));
  }
  const texto = partes.join('\n') + '\n';

  const anterior = fs.existsSync(ARCHIVO) ? fs.readFileSync(ARCHIVO, 'utf8') : '';
  fs.writeFileSync(ARCHIVO, texto);

  const r = await cli('dialplan reload');
  const faltan = [];
  if (r.ok) {
    for (const f of activos) {
      const v = await cli(`dialplan show bpm-flujo-${f.id}`);
      if (!/'b1'/.test(v.salida)) faltan.push(f.nombre);
    }
  }

  if (!r.ok || faltan.length) {
    fs.writeFileSync(ARCHIVO, anterior);
    await cli('dialplan reload');
    throw new Error(!r.ok
      ? `La central no aceptó el cambio (${r.error}). Se dejó todo como estaba.`
      : `La central no cargó: ${faltan.join(', ')}. Se dejó todo como estaba.`);
  }
  return { flujos: activos.length };
}

module.exports = { revisar, traducir, publicar, normalizar, ARCHIVO, PREFIJO_PRUEBA };