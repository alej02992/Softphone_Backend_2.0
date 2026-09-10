/* ═══════════════════════════════════════════════════════════════════
   AUTENTICACIÓN Y PERMISOS

   Dos ideas separadas que suelen confundirse:

     AUTENTICAR  = ¿quién eres?      (validar usuario y contraseña)
     AUTORIZAR   = ¿puedes hacerlo?  (validar permisos)

   Ambas se comprueban EN EL SERVIDOR. Que el menú del navegador
   esconda una opción no es seguridad: cualquiera puede enviar la
   petición a mano desde la consola.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const CONFIG = require('./config');
const bd = require('./bd');

/* ── Contraseñas ────────────────────────────────────────────────────
   Nunca se guarda la contraseña. Se guarda el resultado de bcrypt,
   que es irreversible: de él no se puede volver a la original.

   El 12 es el "coste": cuántas vueltas da el algoritmo. Más alto es
   más seguro y más lento. 12 tarda unos 250 ms, que es lo que se
   busca: suficiente para que probar millones de claves sea inviable.  */

const cifrarClave = (clave) => bcrypt.hash(clave, 12);
const verificarClave = (clave, hash) => bcrypt.compare(clave, hash);


/* ── Tokens ─────────────────────────────────────────────────────────
   Un token es un texto firmado que dice "esta persona inició sesión".
   El navegador lo guarda y lo envía en cada petición.

   Va FIRMADO, no cifrado: cualquiera puede leer su contenido, pero
   nadie puede modificarlo sin la clave del servidor. Por eso dentro
   solo van datos no sensibles.                                       */

function crearToken(usuario, sesionId) {
  return jwt.sign(
    {
      id: usuario.id,
      usuario: usuario.usuario,
      rol: usuario.rol,
      sesion: sesionId,
    },
    CONFIG.jwt.clave,
    { expiresIn: CONFIG.jwt.duracion }
  );
}


/* ── Middleware ─────────────────────────────────────────────────────
   Un middleware es una función que se ejecuta ANTES de la ruta.
   Si todo está bien llama a next() y sigue; si no, corta y responde
   con un error. Así la validación no se repite en cada ruta.         */

/**
 * Exige que la petición traiga un token válido.
 * Deja los datos del usuario en req.usuario.
 */
async function exigirSesion(req, res, next) {
  const cabecera = req.headers.authorization || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Falta iniciar sesión' });
  }

  let datos;
  try {
    datos = jwt.verify(token, CONFIG.jwt.clave);
  } catch (e) {
    const vencido = e.name === 'TokenExpiredError';
    return res.status(401).json({
      error: vencido ? 'La sesión venció' : 'Sesión inválida',
      vencido,
    });
  }

  // El token puede ser válido pero la sesión haberse cerrado.
  // Por eso se comprueba también contra la base.
  const sesion = await bd.una(
    'SELECT id, cerrada, vence FROM sesion WHERE id = ?',
    [datos.sesion]
  );

  if (!sesion || sesion.cerrada) {
    return res.status(401).json({ error: 'La sesión fue cerrada' });
  }

  // Se cargan los permisos frescos: si un administrador acaba de
  // cambiarle el rol, el cambio aplica de inmediato.
  const usuario = await bd.una(
    `SELECT u.id, u.usuario, u.nombre, u.extension, u.activo,
            r.nombre AS rol, u.campana_id, c.nombre AS campana
     FROM usuario u
     JOIN rol r ON r.id = u.rol_id
     LEFT JOIN campana c ON c.id = u.campana_id
     WHERE u.id = ?`,
    [datos.id]
  );

  if (!usuario || !usuario.activo) {
    return res.status(401).json({ error: 'El usuario está inactivo' });
  }

  const permisos = await bd.consultar(
    `SELECT p.clave FROM permiso p
     JOIN rol_permiso rp ON rp.permiso_id = p.id
     JOIN rol r ON r.id = rp.rol_id
     WHERE r.nombre = ?`,
    [usuario.rol]
  );

  usuario.permisos = permisos.map((p) => p.clave);
  usuario.sesion = datos.sesion;
  req.usuario = usuario;
  next();
}

/**
 * Exige un permiso concreto. Se usa después de exigirSesion:
 *
 *   app.post('/api/usuarios', exigirSesion, exigir('usuarios'), ...)
 */
function exigir(permiso) {
  return (req, res, next) => {
    if (!req.usuario.permisos.includes(permiso)) {
      return res.status(403).json({
        error: 'No tienes permiso para hacer esto',
        permiso,
      });
    }
    next();
  };
}

/** Deja pasar solo a quien supervisa esa campaña (o al administrador). */
async function puedeVerCampana(usuario, campanaId) {
  if (usuario.permisos.includes('usuarios')) return true;  // admin
  if (usuario.campana_id === Number(campanaId)) return true;

  const r = await bd.una(
    'SELECT 1 AS si FROM usuario_campana WHERE usuario_id = ? AND campana_id = ?',
    [usuario.id, campanaId]
  );
  return !!r;
}


/* ── Registro de auditoría ── */
async function auditar(usuarioId, accion, entidad, entidadId, detalle, ip) {
  await bd.consultar(
    `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [usuarioId, accion, entidad, String(entidadId ?? ''), detalle || null, ip || null]
  );
}

module.exports = {
  cifrarClave, verificarClave, crearToken,
  exigirSesion, exigir, puedeVerCampana, auditar,
};
