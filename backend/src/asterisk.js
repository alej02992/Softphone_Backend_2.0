/* ═══════════════════════════════════════════════════════════════════
   ASTERISK REALTIME

   Cuando Asterisk está configurado en modo Realtime, lee su
   configuración desde MySQL en lugar de archivos. Crear una extensión
   deja de ser "editar pjsip.conf y recargar" y pasa a ser un INSERT.

   ---------------------------------------------------------------------
   IMPORTANTE: ESTO NO SE PROGRAMA, SE CONFIGURA

   Realtime se habilita EN ASTERISK, no aquí. Este archivo solo escribe
   filas en las tablas que Asterisk ya está leyendo.

   Si Asterisk no está en modo Realtime, estas filas no le sirven de
   nada: se quedan en la base sin efecto.

   Por eso hay un interruptor en config.js (REALTIME). Mientras esté
   en false, el backend crea el usuario en la plataforma y avisa que
   la extensión hay que crearla a mano en VitalPBX.
   ---------------------------------------------------------------------

   LAS TRES TABLAS DE PJSIP

     ps_endpoints  el "quién": códecs, contexto, si usa WebRTC
     ps_auths      el "cómo se identifica": usuario y contraseña
     ps_aors       el "dónde está": dónde entregarle las llamadas

   Una extensión necesita una fila en cada una, con el mismo id.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const CONFIG = require('./config');

/**
 * Crea una extensión WebRTC en Asterisk.
 *
 * Recibe la conexión de la transacción para que, si algo falla
 * después, se deshaga junto con el resto.
 */
async function crearExtension(cx, { extension, clave, contexto = 'desde-agentes' }) {
  if (!CONFIG.realtime) return { creada: false, motivo: 'Realtime desactivado' };

  // 1. Cómo se autentica
  await cx.execute(
    `INSERT INTO ps_auths (id, auth_type, username, password)
     VALUES (?, 'userpass', ?, ?)`,
    [extension, extension, clave]
  );

  // 2. Dónde está registrado
  //    max_contacts = 1  → un agente, una sesión de navegador
  //    remove_existing   → si abre otra pestaña, cierra la anterior
  await cx.execute(
    `INSERT INTO ps_aors (id, max_contacts, remove_existing, qualify_frequency)
     VALUES (?, 1, 'yes', 30)`,
    [extension]
  );

  // 3. Quién es
  //    webrtc = yes es la línea clave: activa de golpe el cifrado
  //    DTLS, ICE, AVPF y el multiplexado que exige el navegador.
  await cx.execute(
    `INSERT INTO ps_endpoints
       (id, transport, aors, auth, context, disallow, allow,
        webrtc, direct_media, force_rport, rewrite_contact, rtp_symmetric)
     VALUES (?, 'transport-wss', ?, ?, ?, 'all', 'opus,ulaw,alaw',
             'yes', 'no', 'yes', 'yes', 'yes')`,
    [extension, extension, extension, contexto]
  );

  return { creada: true };
}

/** Cambia la contraseña de una extensión. */
async function cambiarClave(cx, extension, clave) {
  if (!CONFIG.realtime) return { ok: false };
  await cx.execute('UPDATE ps_auths SET password = ? WHERE id = ?', [clave, extension]);
  return { ok: true };
}

/** Elimina la extensión de las tres tablas. */
async function eliminarExtension(cx, extension) {
  if (!CONFIG.realtime) return { ok: false };
  await cx.execute('DELETE FROM ps_endpoints WHERE id = ?', [extension]);
  await cx.execute('DELETE FROM ps_auths WHERE id = ?', [extension]);
  await cx.execute('DELETE FROM ps_aors WHERE id = ?', [extension]);
  return { ok: true };
}

/** Añade o quita al agente de una cola. */
async function asignarCola(cx, extension, cola, agregar = true) {
  if (!CONFIG.realtime) return { ok: false };
  if (agregar) {
    await cx.execute(
      `INSERT INTO queue_members (queue_name, interface, membername, uniqueid)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE interface = VALUES(interface)`,
      [cola, 'PJSIP/' + extension, extension, cola + '-' + extension]
    );
  } else {
    await cx.execute(
      'DELETE FROM queue_members WHERE queue_name = ? AND interface = ?',
      [cola, 'PJSIP/' + extension]
    );
  }
  return { ok: true };
}

module.exports = { crearExtension, cambiarClave, eliminarExtension, asignarCola };
