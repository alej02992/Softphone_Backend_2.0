/* ═══════════════════════════════════════════════════════════════════
   SESIÓN

   Estas dos rutas son las que hoy simula js/servicio.js en el
   navegador. Al conectarlas, el frontend deja de inventar datos.

     POST /api/sesion            iniciar sesión
     POST /api/sesion/sip        pedir la credencial de telefonía
     DELETE /api/sesion          cerrar sesión
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const crypto = require('crypto');
const bd = require('../bd');
const auth = require('../auth');
const CONFIG = require('../config');

const router = express.Router();


/* ── Iniciar sesión ──────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  try {
    const { usuario, clave } = req.body;

    if (!usuario || !clave) {
      return res.status(400).json({ error: 'Faltan usuario o contraseña' });
    }

    const u = await bd.una(
      `SELECT u.id, u.usuario, u.nombre, u.clave_hash, u.extension, u.activo,
              u.debe_cambiar_clave,
              r.nombre AS rol, u.campana_id, c.nombre AS campana
       FROM usuario u
       JOIN rol r ON r.id = u.rol_id
       LEFT JOIN campana c ON c.id = u.campana_id
       WHERE u.usuario = ?`,
      [String(usuario).toLowerCase().trim()]
    );

    /* El mensaje es el mismo si el usuario no existe o si la clave está
       mal. Decir cuál de los dos falló le confirma a un atacante qué
       usuarios existen. */
    const generico = { error: 'Usuario o contraseña incorrectos' };

    if (!u || !u.activo) return res.status(401).json(generico);

    const correcta = await auth.verificarClave(clave, u.clave_hash);
    if (!correcta) return res.status(401).json(generico);

    /* Permisos según el rol */
    const permisos = await bd.consultar(
      `SELECT p.clave FROM permiso p
       JOIN rol_permiso rp ON rp.permiso_id = p.id
       WHERE rp.rol_id = (SELECT rol_id FROM usuario WHERE id = ?)`,
      [u.id]
    );

    /* ── Credencial SIP de la sesión ──────────────────────────────
       Con Realtime, cada inicio de sesión genera una contraseña nueva
       y la escribe en la extensión de Asterisk. Así, si alguien copia
       la clave que ve el navegador, deja de servir en cuanto el agente
       cierra sesión o vuelve a entrar.

       Sin Realtime, Asterisk lee su configuración de archivos y la
       contraseña no se puede rotar: se usa la fija del entorno.      */
    const sesionId = crypto.randomUUID();
    const claveSip = (CONFIG.realtime && u.extension)
      ? generarClaveSip()
      : (CONFIG.pbx.claveFija || generarClaveSip());
    const vence = new Date(Date.now() + 8 * 60 * 60 * 1000);   // 8 horas

    await bd.transaccion(async (cx) => {
      await cx.execute(
        `INSERT INTO sesion (id, usuario_id, clave_sip, vence, ip)
         VALUES (?, ?, ?, ?, ?)`,
        [sesionId, u.id, claveSip, vence, req.ip]
      );

      /* Se rota la contraseña en la extensión. Si esto falla, tampoco
         se crea la sesión: el agente no recibiría una credencial que
         la central no reconoce. */
      if (CONFIG.realtime && u.extension) {
        await cx.execute('UPDATE ps_auths SET password = ? WHERE id = ?',
          [claveSip, u.extension]);
      }

      /* Sesiones anteriores del mismo usuario quedan cerradas: una
         persona, una sesión. */
      await cx.execute(
        `UPDATE sesion SET cerrada = NOW()
          WHERE usuario_id = ? AND cerrada IS NULL AND id <> ?`,
        [u.id, sesionId]
      );
    });

    await bd.consultar('UPDATE usuario SET ultimo_acceso = NOW() WHERE id = ?', [u.id]);

    res.json({
      token: auth.crearToken({ ...u, rol: u.rol }, sesionId),
      usuario: {
        id: u.id,
        usuario: u.usuario,
        nombre: u.nombre,
        rol: u.rol,
        extension: u.extension,
        campana: u.campana,
        campana_id: u.campana_id,
        permisos: permisos.map((p) => p.clave),

        /* Si es TRUE, la plataforma muestra la pantalla de cambio de
           contraseña y no deja entrar al escritorio hasta que la
           cambie. Es el primer acceso, o un restablecimiento. */
        debeCambiarClave: !!u.debe_cambiar_clave,
      },
    });
  } catch (e) { next(e); }
});


/* ── Credencial de telefonía ─────────────────────────────────────────
   Se entrega aparte del inicio de sesión, y solo a quien puede usar
   el softphone. Así un supervisor que solo consulta reportes nunca
   recibe una credencial SIP.                                          */
router.post('/sip', auth.exigirSesion, auth.exigir('softphone'), async (req, res, next) => {
  try {
    const u = req.usuario;

    if (!u.extension) {
      return res.status(409).json({ error: 'El usuario no tiene extensión asignada' });
    }
    if (!CONFIG.pbx.wss || !CONFIG.pbx.dominio) {
      return res.status(503).json({ error: 'La central no está configurada en el servidor' });
    }

    const s = await bd.una(
      'SELECT clave_sip, vence FROM sesion WHERE id = ?',
      [u.sesion]
    );

    res.json({
      wss: CONFIG.pbx.wss,
      dominio: CONFIG.pbx.dominio,
      extension: u.extension,
      clave: s.clave_sip,
      ice: CONFIG.pbx.ice.split(',').map((x) => ({ urls: x.trim() })),
      vence: s.vence,
    });
  } catch (e) { next(e); }
});


/* ── Cambiar la propia contraseña ────────────────────────────────
   La usa el agente en su primer acceso. No requiere permiso de
   administración: cualquiera puede cambiar la suya.                */
router.put('/clave', auth.exigirSesion, async (req, res, next) => {
  try {
    const { claveActual, claveNueva } = req.body;

    if (!claveActual || !claveNueva) {
      return res.status(400).json({ error: 'Faltan la contraseña actual y la nueva' });
    }
    if (String(claveNueva).length < 8) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    if (claveActual === claveNueva) {
      return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });
    }

    const u = await bd.una('SELECT clave_hash FROM usuario WHERE id = ?', [req.usuario.id]);
    if (!u) return res.status(404).json({ error: 'El usuario no existe' });

    if (!(await auth.verificarClave(claveActual, u.clave_hash))) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }

    /* Se guarda la nueva y se baja la bandera de cambio obligatorio. */
    await bd.consultar(
      'UPDATE usuario SET clave_hash = ?, debe_cambiar_clave = FALSE WHERE id = ?',
      [await auth.cifrarClave(claveNueva), req.usuario.id]
    );

    await auth.auditar(req.usuario.id, 'modificar', 'usuario', req.usuario.id,
      'Cambió su propia contraseña', req.ip);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ── Cerrar sesión ───────────────────────────────────────────────────
   Marca la sesión como cerrada. A partir de ese momento el token deja
   de servir aunque no haya vencido, y la credencial SIP queda
   invalidada.                                                          */
router.delete('/', auth.exigirSesion, async (req, res, next) => {
  try {
    await bd.consultar('UPDATE sesion SET cerrada = NOW() WHERE id = ?', [req.usuario.sesion]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});


/* ── Quién soy ───────────────────────────────────────────────────────
   Sirve para que el navegador recupere la sesión al recargar la
   página, sin volver a pedir la contraseña.                            */
router.get('/', auth.exigirSesion, (req, res) => {
  const u = req.usuario;
  res.json({
    id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol,
    extension: u.extension, campana: u.campana, campana_id: u.campana_id,
    permisos: u.permisos,
  });
});


/** Clave aleatoria para la sesión. 32 caracteres sin ambigüedades. */
function generarClaveSip() {
  return crypto.randomBytes(24).toString('base64')
    .replace(/[+/=]/g, '').slice(0, 32);
}

module.exports = router;