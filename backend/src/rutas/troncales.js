/* ═══════════════════════════════════════════════════════════════════
   TRONCALES

   Una troncal es el enlace con el operador telefónico: por ahí salen y
   entran las llamadas hacia la calle. Sin troncal, la central solo
   puede comunicar extensiones entre sí.

   ESTE MÓDULO SOLO MIRA, NO TOCA
   Las troncales de esta central viven en /etc/asterisk/pjsip.conf, y
   por ellas salen las llamadas de toda la operación. Modificarlas desde
   la plataforma, sin haber probado antes, podría dejar a la empresa sin
   servicio telefónico.

   Por eso esta primera versión es de solo lectura: muestra lo que hay y
   cómo está. Crear y modificar vendrá después, cuando esto esté
   probado.

   DE DÓNDE SALEN LOS DATOS
   De la propia central, preguntándole por línea de comandos. Son
   consultas de solo lectura y fijas, nunca armadas con algo que
   escriba un usuario.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { execFile } = require('child_process');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

/**
 * Pregunta algo a Asterisk.
 *
 * Se usa `execFile` con la orden y sus argumentos por separado, nunca
 * una cadena armada: así no hay forma de colar un comando extra. Y las
 * órdenes están escritas aquí, no llegan de fuera.
 */
function preguntarAsterisk(orden) {
  return new Promise((resolver) => {
    execFile('asterisk', ['-rx', orden], { timeout: 5000 }, (err, salida) => {
      if (err) return resolver({ ok: false, error: err.message, texto: '' });
      resolver({ ok: true, texto: String(salida || '') });
    });
  });
}

/* ═══════════ LEER LAS TRONCALES ═══════════ */

/**
 * Las troncales configuradas.
 *
 * Asterisk las llama "endpoints", igual que a las extensiones de los
 * agentes. Se distinguen porque una troncal apunta a un servidor
 * externo y tiene su propio contexto de entrada, mientras que una
 * extensión se registra desde un navegador.
 */
function leerEndpoints(texto) {
  const troncales = [];

  /* Cada línea de endpoint se ve así:
       Endpoint:  servcom/BPM    Not in use    0 of inf  */
  texto.split('\n').forEach((linea) => {
    /* Se descartan las líneas de encabezado y los separadores: en la
       salida de Asterisk empiezan por <, = o traen "Objects found". */
    if (/^\s*[<=]|Objects found/.test(linea)) return;

    const m = /^\s*Endpoint:\s+([^\s/]+)(?:\/\S+)?\s+(.+?)\s{2,}/.exec(linea);
    if (!m) return;

    const nombre = m[1].trim();
    const estado = m[2].trim();

    /* El propio encabezado también empieza por "Endpoint:" */
    if (nombre.startsWith('<')) return;

    /* Las extensiones de los agentes son números; las troncales, no.
       Es la forma más fiable de separarlas sin leer el archivo. */
    if (/^\d+$/.test(nombre)) return;

    troncales.push({ nombre, estado, registro: null, servidor: null });
  });

  return troncales;
}

/**
 * El estado del registro contra el operador.
 *
 * Esto es lo que de verdad importa: una troncal puede existir y estar
 * mal registrada, y entonces las llamadas entrantes no llegan.
 */
function leerRegistros(texto) {
  const registros = [];

  /* Cada línea se ve así:
       servcom_reg/sip:66.70.176.235:5060   servcom_auth   Registered */
  texto.split('\n').forEach((linea) => {
    /* Fuera encabezados y separadores antes de analizar nada */
    if (/^\s*[<=]|Objects found/.test(linea)) return;

    const m = /^\s*(\S+?)\/(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(linea);
    if (!m) return;

    const [, nombre, servidor, , estado] = m;
    if (nombre.startsWith('<')) return;

    registros.push({
      nombre: nombre.replace(/_reg$/, ''),
      servidor: servidor.replace(/^sip:/, ''),
      estado: estado.trim(),
      /* "Registered" es lo único que cuenta como bien. Cualquier otra
         cosa —Rejected, Unregistered— significa que el operador no está
         aceptando el registro. */
      registrada: /^Registered/i.test(estado.trim()),
    });
  });

  return registros;
}

router.get('/troncales', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const [ep, reg] = await Promise.all([
        preguntarAsterisk('pjsip show endpoints'),
        preguntarAsterisk('pjsip show registrations'),
      ]);

      if (!ep.ok && !reg.ok) {
        return res.status(503).json({
          error: 'No se pudo consultar la central',
          detalle: ep.error || reg.error,
        });
      }

      const troncales = leerEndpoints(ep.texto);
      const registros = leerRegistros(reg.texto);

      /* Se cruzan por nombre: el registro suele llamarse igual que la
         troncal, con "_reg" al final. */
      troncales.forEach((t) => {
        const r = registros.find((x) => x.nombre === t.nombre);
        if (r) {
          t.registro = r.estado;
          t.registrada = r.registrada;
          t.servidor = r.servidor;
        }
      });

      /* Un registro sin troncal también se muestra: suele significar
         que algo quedó a medio configurar. */
      registros.forEach((r) => {
        if (!troncales.some((t) => t.nombre === r.nombre)) {
          troncales.push({
            nombre: r.nombre,
            estado: 'Sin endpoint configurado',
            registro: r.estado,
            registrada: r.registrada,
            servidor: r.servidor,
          });
        }
      });

      res.json({
        troncales,
        resumen: {
          total: troncales.length,
          registradas: troncales.filter((t) => t.registrada).length,
          conProblema: troncales.filter((t) => t.registro && !t.registrada).length,
        },
      });
    } catch (e) { next(e); }
  });

/* ═══════════ ADMINISTRAR TRONCALES ═══════════

   Las que crea la plataforma se guardan primero en nuestra tabla, no en
   las de Asterisk. La central lee sus tablas en vivo: lo que se escriba
   ahí entra en servicio de inmediato, así que una troncal a medio
   configurar quedaría activa al instante.

   Por eso hay dos momentos separados: GUARDAR, que no afecta a nada, y
   ACTIVAR, que la pone en servicio.                                   */

/** Lo que se devuelve de una troncal. Nunca incluye la contraseña. */
const sinClave = (t) => ({
  id: t.id,
  nombre: t.nombre,
  descripcion: t.descripcion,
  servidor: t.servidor,
  puerto: t.puerto,
  usuario: t.usuario,
  tieneClave: !!t.clave,
  registra: !!t.registra,
  contexto: t.contexto,
  codecs: t.codecs,
  identificador: t.identificador,
  prefijo: t.prefijo || '',
  estado: t.estado,
  activada: t.activada,
});

router.get('/troncales/propias', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const filas = await bd.consultar(
        'SELECT * FROM troncal ORDER BY nombre');
      res.json(filas.map(sinClave));
    } catch (e) { next(e); }
  });

/** Revisa lo que llega del formulario. */
function revisar(b, esNueva) {
  const nombre = String(b.nombre || '').trim().toLowerCase();

  /* El nombre acaba siendo un identificador dentro de Asterisk: solo
     letras, números y guion bajo. Un espacio o un acento ahí rompe la
     configuración de la central. */
  if (!/^[a-z0-9_]{3,30}$/.test(nombre)) {
    return 'El nombre debe tener de 3 a 30 caracteres, solo letras, números y guion bajo';
  }

  /* Nombres reservados: chocarían con las extensiones de los agentes */
  if (/^\d+$/.test(nombre)) return 'El nombre no puede ser solo números';

  const servidor = String(b.servidor || '').trim();
  if (servidor.length < 4) return 'Falta la dirección del servidor del operador';
  if (/[\s;'"]/.test(servidor)) return 'La dirección del servidor no es válida';

  const puerto = Number(b.puerto) || 5060;
  if (puerto < 1 || puerto > 65535) return 'El puerto no es válido';

  if (b.registra && !String(b.usuario || '').trim()) {
    return 'Para registrarse hace falta el usuario que entrega el operador';
  }
  if (b.registra && esNueva && !String(b.clave || '').trim()) {
    return 'Para registrarse hace falta la contraseña del operador';
  }

  /* El prefijo que pide el operador antes del número: solo dígitos */
  if (b.prefijo && !/^\d{1,20}$/.test(String(b.prefijo).trim())) {
    return 'El prefijo solo puede tener dígitos';
  }

  const contexto = String(b.contexto || 'from-pstn').trim();
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(contexto)) return 'El contexto no es válido';

  return null;
}

router.post('/troncales/propias', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const b = req.body || {};
      const error = revisar(b, true);
      if (error) return res.status(400).json({ error });

      const nombre = String(b.nombre).trim().toLowerCase();

      const repetida = await bd.una('SELECT id FROM troncal WHERE nombre = ?', [nombre]);
      if (repetida) return res.status(409).json({ error: 'Ya existe una troncal con ese nombre' });

      /* Tampoco puede chocar con lo que ya está en la central */
      const enCentral = await bd.una('SELECT id FROM ps_endpoints WHERE id = ?', [nombre]);
      if (enCentral) return res.status(409).json({ error: 'Ese nombre ya existe en la central' });

      const [r] = await bd.pool.execute(
        `INSERT INTO troncal
           (nombre, descripcion, servidor, puerto, prefijo, usuario, clave, registra,
            contexto, codecs, identificador, estado, creada_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'borrador', ?)`,
        [nombre, (b.descripcion || '').slice(0, 160) || null,
         String(b.servidor).trim(), Number(b.puerto) || 5060,
         String(b.prefijo || '').trim() || null,
         String(b.usuario || '').trim() || null,
         String(b.clave || '').trim() || null,
         b.registra ? 1 : 0,
         String(b.contexto || 'from-pstn').trim(),
         String(b.codecs || 'ulaw,alaw').trim(),
         String(b.identificador || '').trim() || null,
         req.usuario.id]);

      await auth.auditar(req.usuario.id, 'crear', 'troncal', r.insertId,
        `Creó la troncal ${nombre} (${b.servidor})`, req.ip);

      res.status(201).json({ ok: true, id: r.insertId });
    } catch (e) { next(e); }
  });

router.put('/troncales/propias/:id', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};

      const t = await bd.una('SELECT * FROM troncal WHERE id = ?', [id]);
      if (!t) return res.status(404).json({ error: 'Esa troncal no existe' });

      /* Una troncal activa no se edita: habría que rehacer la
         configuración de la central en caliente, y si algo falla a
         mitad la empresa se queda sin salida. Primero se desactiva. */
      if (t.estado === 'activa') {
        return res.status(409).json({
          error: 'Desactiva la troncal antes de modificarla',
        });
      }

      const error = revisar({ ...b, nombre: t.nombre }, false);
      if (error) return res.status(400).json({ error });

      await bd.consultar(
        `UPDATE troncal
            SET descripcion = ?, servidor = ?, puerto = ?, prefijo = ?, usuario = ?,
                clave = COALESCE(?, clave), registra = ?, contexto = ?,
                codecs = ?, identificador = ?
          WHERE id = ?`,
        [(b.descripcion || '').slice(0, 160) || null,
         String(b.servidor).trim(), Number(b.puerto) || 5060,
         String(b.prefijo || '').trim() || null,
         String(b.usuario || '').trim() || null,
         String(b.clave || '').trim() || null,
         b.registra ? 1 : 0,
         String(b.contexto || 'from-pstn').trim(),
         String(b.codecs || 'ulaw,alaw').trim(),
         String(b.identificador || '').trim() || null,
         id]);

      await auth.auditar(req.usuario.id, 'modificar', 'troncal', id,
        `Modificó la troncal ${t.nombre}`, req.ip);

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* ═══════════ ACTIVAR Y DESACTIVAR ═══════════

   Este es el único punto donde la plataforma escribe en las tablas de
   la central. Se hace en una transacción: o se escribe todo, o no se
   escribe nada. Una troncal a medias —con endpoint pero sin
   credenciales, por ejemplo— dejaría a Asterisk con una configuración
   inválida.

   Las troncales que vienen del archivo de configuración NO se tocan
   nunca desde aquí: no están en nuestra tabla, así que no hay forma de
   llegar a ellas por este camino.                                     */

/** Recarga la configuración de la central. */
async function recargarPjsip() {
  /* La recarga general no basta: los registros contra el operador y el
     reconocimiento por dirección tienen sus propios módulos, y si no se
     recargan, Asterisk no ve la troncal nueva —ni deja de ver la que se
     desactivó— hasta el siguiente reinicio. Se comprobó en la central. */
  const ordenes = [
    'pjsip reload',
    'module reload res_pjsip_outbound_registration.so',
    'module reload res_pjsip_endpoint_identifier_ip.so',
  ];
  let todo = true;
  for (const o of ordenes) {
    const r = await preguntarAsterisk(o);
    if (!r.ok) todo = false;
  }
  return todo;
}

router.put('/troncales/propias/:id/estado', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const activar = req.body?.estado === 'activa';

      const t = await bd.una('SELECT * FROM troncal WHERE id = ?', [id]);
      if (!t) return res.status(404).json({ error: 'Esa troncal no existe' });

      const n = t.nombre;

      if (activar) {
        /* Antes de tocar nada: comprobar que no choca con algo que ya
           esté en la central y que no sea nuestro. */
        /* Las tablas de Asterisk y las nuestras pueden tener distinto
           cotejamiento de texto, y comparar columnas entre ellas falla.
           Por eso se comparan en memoria y no dentro de la consulta. */
        const yaEnCentral = await bd.una('SELECT id FROM ps_endpoints WHERE id = ?', [n]);
        const nuestras = await bd.consultar('SELECT nombre FROM troncal WHERE id <> ?', [id]);
        const esDeOtra = nuestras.some((x) => x.nombre === n);

        if (yaEnCentral && esDeOtra) {
          return res.status(409).json({ error: 'Ese nombre ya existe en la central' });
        }

        await bd.transaccion(async (cx) => {
          /* Las credenciales, si el operador las pide */
          if (t.usuario) {
            await cx.execute(
              `INSERT INTO ps_auths (id, auth_type, username, password)
               VALUES (?, 'userpass', ?, ?)
               ON DUPLICATE KEY UPDATE username = VALUES(username), password = VALUES(password)`,
              [n + '_auth', t.usuario, t.clave || '']);
          }

          /* A dónde se llama */
          await cx.execute(
            `INSERT INTO ps_aors (id, contact, max_contacts, qualify_frequency)
             VALUES (?, ?, 1, 60)
             ON DUPLICATE KEY UPDATE contact = VALUES(contact)`,
            [n + '_aor', `sip:${t.servidor}:${t.puerto}`]);

          /* La troncal en sí */
          /* WebRTC y todo lo que arrastra —cifrado, ICE, AVPF— se apagan
             de forma explícita. La tabla de extensiones trae webrtc=yes
             POR DEFECTO, porque está pensada para los agentes que llaman
             desde el navegador. Una troncal que lo heredara le exigiría al
             operador un cifrado que los operadores telefónicos no usan, y
             las llamadas no se conectarían. */
          await cx.execute(
            `INSERT INTO ps_endpoints
               (id, transport, context, disallow, allow, aors, outbound_auth,
                from_user, from_domain, direct_media, rtp_symmetric, force_rport,
                rewrite_contact, callerid,
                webrtc, ice_support, use_avpf, media_encryption, rtcp_mux,
                dtls_auto_generate_cert)
             VALUES (?, 'transport-udp', ?, 'all', ?, ?, ?, ?, ?, 'no', 'yes', 'yes', 'yes', ?,
                     'no', 'no', 'no', 'no', 'no', 'no')
             ON DUPLICATE KEY UPDATE
               context = VALUES(context), allow = VALUES(allow),
               aors = VALUES(aors), outbound_auth = VALUES(outbound_auth),
               from_user = VALUES(from_user), from_domain = VALUES(from_domain),
               callerid = VALUES(callerid),
               webrtc = 'no', ice_support = 'no', use_avpf = 'no',
               media_encryption = 'no', rtcp_mux = 'no', dtls_auto_generate_cert = 'no'`,
            [n, t.contexto, t.codecs, n + '_aor',
             t.usuario ? n + '_auth' : null,
             t.usuario || null, t.servidor,
             t.identificador || null]);

          /* El registro contra el operador, si hace falta */
          if (t.registra && t.usuario) {
            await cx.execute(
              `INSERT INTO ps_registrations
                 (id, outbound_auth, server_uri, client_uri, retry_interval, expiration)
               VALUES (?, ?, ?, ?, 15, 3600)
               ON DUPLICATE KEY UPDATE
                 server_uri = VALUES(server_uri), client_uri = VALUES(client_uri)`,
              [n + '_reg', n + '_auth',
               `sip:${t.servidor}:${t.puerto}`,
               `sip:${t.usuario}@${t.servidor}`]);
          }

          /* Reconocer al operador cuando llame él */
          await cx.execute(
            `INSERT INTO ps_endpoint_id_ips (id, endpoint, \u0060match\u0060)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE \u0060match\u0060 = VALUES(\u0060match\u0060)`,
            [n + '_id', n, t.servidor]);

          await cx.execute(
            "UPDATE troncal SET estado = 'activa', activada = NOW() WHERE id = ?", [id]);
        });

      } else {
        /* Si alguna campaña sale por esta troncal, no se desactiva: sus
           llamadas se quedarían sin salida. Primero hay que pasarlas a
           otra en Rutas de salida. Se compara en memoria por la misma
           razón de cotejamiento que en la activación. */
        const usan = (await bd.consultar(
          'SELECT nombre, troncal_salida FROM campana WHERE troncal_salida IS NOT NULL'))
          .filter((c) => String(c.troncal_salida) === n)
          .map((c) => c.nombre);
        if (usan.length) {
          return res.status(409).json({
            error: `No se puede desactivar: la usan ${usan.length === 1 ? 'la campaña' : 'las campañas'} ` +
                   `${usan.join(', ')}. Cámbialas de troncal en Rutas de salida.`,
          });
        }

        /* Desactivar: se quita de la central, pero la configuración se
           conserva en nuestra tabla para poder volver a activarla. */
        await bd.transaccion(async (cx) => {
          await cx.execute('DELETE FROM ps_registrations WHERE id = ?', [n + '_reg']);
          await cx.execute('DELETE FROM ps_endpoint_id_ips WHERE id = ?', [n + '_id']);
          await cx.execute('DELETE FROM ps_endpoints WHERE id = ?', [n]);
          await cx.execute('DELETE FROM ps_aors WHERE id = ?', [n + '_aor']);
          await cx.execute('DELETE FROM ps_auths WHERE id = ?', [n + '_auth']);
          await cx.execute(
            "UPDATE troncal SET estado = 'inactiva' WHERE id = ?", [id]);
        });
      }

      const recargada = await recargarPjsip();

      await auth.auditar(req.usuario.id, 'modificar', 'troncal', id,
        `${activar ? 'Activó' : 'Desactivó'} la troncal ${n}`, req.ip);

      res.json({
        ok: true,
        estado: activar ? 'activa' : 'inactiva',
        /* Si la recarga falla, la configuración quedó guardada pero la
           central sigue con la anterior. Hay que decirlo. */
        recargada,
        aviso: recargada ? null
          : 'La configuración se guardó, pero no se pudo recargar la central. ' +
            'Ejecuta en el servidor: asterisk -rx "module reload res_pjsip_outbound_registration.so"',
      });
    } catch (e) { next(e); }
  });

router.delete('/troncales/propias/:id', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const t = await bd.una('SELECT * FROM troncal WHERE id = ?', [id]);
      if (!t) return res.status(404).json({ error: 'Esa troncal no existe' });

      if (t.estado === 'activa') {
        return res.status(409).json({ error: 'Desactiva la troncal antes de eliminarla' });
      }

      await bd.consultar('DELETE FROM troncal WHERE id = ?', [id]);
      await auth.auditar(req.usuario.id, 'eliminar', 'troncal', id,
        `Eliminó la troncal ${t.nombre}`, req.ip);

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* ═══════════ RUTAS DE SALIDA ═══════════

   Por qué troncal sale cada campaña. Sin troncal asignada, la campaña
   sale por servcom con su prefijo de siempre: así funcionaba todo antes
   de este módulo, y así sigue mientras nadie asigne otra.

   La central no lee esta tabla directamente: consulta la vista
   v_ruta_salida, que solo dice qué troncal y qué prefijo le tocan a cada
   extensión. El cambio vale desde la llamada siguiente, sin recargar
   nada.                                                               */

const PRINCIPAL = 'servcom';

router.get('/troncales/rutas', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const campanas = await bd.consultar(
        'SELECT id, nombre, troncal_salida FROM campana ORDER BY nombre');
      const propias = await bd.consultar(
        "SELECT nombre, prefijo FROM troncal WHERE estado = 'activa' ORDER BY nombre");

      /* Cuántos agentes con extensión tiene cada campaña: es lo que se ve
         afectado al cambiarle la troncal. */
      const agentes = await bd.consultar(
        `SELECT campana_id, COUNT(*) AS n FROM usuario
          WHERE extension IS NOT NULL AND extension <> '' GROUP BY campana_id`);

      res.json({
        troncales: [
          { nombre: PRINCIPAL, etiqueta: `${PRINCIPAL} (principal)`, principal: true },
          ...propias.map((t) => ({
            nombre: t.nombre,
            etiqueta: t.prefijo ? `${t.nombre} · prefijo ${t.prefijo}` : t.nombre,
          })),
        ],
        campanas: campanas.map((c) => ({
          id: c.id,
          nombre: c.nombre,
          troncal: c.troncal_salida || PRINCIPAL,
          agentes: Number((agentes.find((a) => a.campana_id === c.id) || {}).n) || 0,
        })),
      });
    } catch (e) { next(e); }
  });

router.put('/troncales/rutas/:id', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const elegida = String(req.body?.troncal || PRINCIPAL).trim();

      const c = await bd.una('SELECT id, nombre FROM campana WHERE id = ?', [id]);
      if (!c) return res.status(404).json({ error: 'Esa campaña no existe' });

      /* Solo se puede asignar la principal o una troncal propia activa:
         una inactiva no está en la central y las llamadas no saldrían. */
      if (elegida !== PRINCIPAL) {
        const activas = await bd.consultar("SELECT nombre FROM troncal WHERE estado = 'activa'");
        if (!activas.some((t) => String(t.nombre) === elegida)) {
          return res.status(400).json({ error: 'Esa troncal no existe o no está activa' });
        }
      }

      await bd.consultar('UPDATE campana SET troncal_salida = ? WHERE id = ?',
        [elegida === PRINCIPAL ? null : elegida, id]);

      await auth.auditar(req.usuario.id, 'modificar', 'campana', id,
        `La campaña ${c.nombre} ahora sale por ${elegida}`, req.ip);

      res.json({ ok: true, troncal: elegida });
    } catch (e) { next(e); }
  });

module.exports = router;