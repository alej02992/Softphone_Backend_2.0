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

    /* Se crea la sesión con su credencial SIP temporal */
    const sesionId = crypto.randomUUID();
    const claveSip = CONFIG.pbx.claveFija || generarClaveSip();
    const vence = new Date(Date.now() + 8 * 60 * 60 * 1000);   // 8 horas

    await bd.consultar(
      `INSERT INTO sesion (id, usuario_id, clave_sip, vence, ip)
       VALUES (?, ?, ?, ?, ?)`,
      [sesionId, u.id, claveSip, vence, req.ip]
    );

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
