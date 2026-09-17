/* ═══════════════════════════════════════════════════════════════════
   USUARIOS

   Crear, listar, modificar y desactivar.

   Aquí está el punto delicado del proyecto: crear un usuario debe
   crear TAMBIÉN su extensión en Asterisk. Las dos cosas van en una
   transacción para que no quede una sin la otra.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const crypto = require('crypto');
const bd = require('../bd');
const auth = require('../auth');
const CONFIG = require('../config');
const asterisk = require('../asterisk');

const router = express.Router();

/* Todas las rutas de este archivo exigen sesión y permiso */
router.use(auth.exigirSesion, auth.exigir('usuarios'));


/* ── Listar ──────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const filas = await bd.consultar(
      `SELECT u.id, u.usuario, u.nombre, u.correo, u.extension, u.activo,
              u.ultimo_acceso, r.nombre AS rol, c.nombre AS campana
       FROM usuario u
       JOIN rol r ON r.id = u.rol_id
       LEFT JOIN campana c ON c.id = u.campana_id
       ORDER BY u.nombre`
    );
    res.json(filas);
  } catch (e) { next(e); }
});


/* ── Crear ───────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  try {
    const { usuario, nombre, correo, rol_id, campana_id, extension } = req.body;

    /* 1. Validar lo que llega. Nunca se confía en el navegador. */
    if (!usuario || !nombre || !rol_id) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    /* La contraseña NO la elige quien crea el usuario. Se asigna la
       temporal y la persona la cambia en su primer acceso. Así nadie
       maneja contraseñas ajenas. */
    const clave = CONFIG.claveTemporal;
    if (extension && !/^\d{3,6}$/.test(extension)) {
      return res.status(400).json({ error: 'La extensión debe tener entre 3 y 6 dígitos' });
    }

    /* 2. Comprobar que no exista ya.
          La base también lo impide, pero así el mensaje es claro. */
    const repetido = await bd.una(
      'SELECT id FROM usuario WHERE usuario = ? OR (extension IS NOT NULL AND extension = ?)',
      [usuario, extension || null]
    );
    if (repetido) {
      return res.status(409).json({ error: 'Ese usuario o esa extensión ya existen' });
    }

    /* 3. Cifrar la contraseña temporal */
    const clave_hash = await auth.cifrarClave(clave);

    /* 4. Escribir en la plataforma Y en Asterisk, todo o nada */
    const claveSip = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '');

    const resultado = await bd.transaccion(async (cx) => {
      const [r] = await cx.execute(
        `INSERT INTO usuario (usuario, nombre, correo, clave_hash, rol_id, campana_id, extension)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [usuario, nombre, correo || null, clave_hash, rol_id, campana_id || null, extension || null]
      );

      let ext = { creada: false };
      if (extension) {
        ext = await asterisk.crearExtension(cx, { extension, clave: claveSip });

        // Si pertenece a una campaña, se le asigna su cola
        if (campana_id) {
          const c = await cx.execute(
            'SELECT cola_asterisk FROM campana WHERE id = ?', [campana_id]
          );
          const cola = c[0][0]?.cola_asterisk;
          if (cola) await asterisk.asignarCola(cx, extension, cola, true);
        }
      }

      return { id: r.insertId, extensionCreada: ext.creada, motivo: ext.motivo };
    });

    /* 5. Dejar rastro */
    await auth.auditar(req.usuario.id, 'crear', 'usuario', resultado.id,
      `Creó a ${nombre}` + (extension ? ` con extensión ${extension}` : ''), req.ip);

    res.status(201).json(resultado);
  } catch (e) { next(e); }
});


/* ── Modificar ───────────────────────────────────────────────────── */
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { nombre, correo, rol_id, campana_id, activo } = req.body;

    const antes = await bd.una('SELECT * FROM usuario WHERE id = ?', [id]);
    if (!antes) return res.status(404).json({ error: 'El usuario no existe' });

    await bd.consultar(
      `UPDATE usuario
       SET nombre = ?, correo = ?, rol_id = ?, campana_id = ?, activo = ?
       WHERE id = ?`,
      [nombre ?? antes.nombre, correo ?? antes.correo, rol_id ?? antes.rol_id,
       campana_id ?? antes.campana_id, activo ?? antes.activo, id]
    );

    /* Cambiar el rol es solo cambiar una columna.
       La persona ve el menú nuevo en su siguiente inicio de sesión. */
    const cambioRol = rol_id && rol_id !== antes.rol_id;

    await auth.auditar(req.usuario.id, 'modificar', 'usuario', id,
      cambioRol ? `Cambió el rol de ${antes.nombre}` : `Modificó a ${antes.nombre}`, req.ip);

    res.json({ ok: true, cambioRol });
  } catch (e) { next(e); }
});


/* ── Cambiar contraseña ──────────────────────────────────────────── */
router.put('/:id/clave', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { clave } = req.body;

    if (!clave || String(clave).length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    const u = await bd.una('SELECT nombre FROM usuario WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ error: 'El usuario no existe' });

    await bd.consultar(
      'UPDATE usuario SET clave_hash = ?, debe_cambiar_clave = TRUE WHERE id = ?',
      [await auth.cifrarClave(clave), id]);

    /* Se cierran sus sesiones abiertas: si alguien le robó el token,
       deja de servir. */
    await bd.consultar(
      'UPDATE sesion SET cerrada = NOW() WHERE usuario_id = ? AND cerrada IS NULL', [id]);

    await auth.auditar(req.usuario.id, 'modificar', 'usuario', id,
      `Cambió la contraseña de ${u.nombre}`, req.ip);

    res.json({ ok: true });
  } catch (e) { next(e); }
});


/* ── Restablecer la contraseña ───────────────────────────────────
   Deja al usuario con la temporal y le vuelve a exigir el cambio.
   Es lo que se usa cuando alguien olvida la suya.                  */
router.post('/:id/restablecer', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    const u = await bd.una('SELECT nombre FROM usuario WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ error: 'El usuario no existe' });

    await bd.consultar(
      'UPDATE usuario SET clave_hash = ?, debe_cambiar_clave = TRUE WHERE id = ?',
      [await auth.cifrarClave(CONFIG.claveTemporal), id]
    );

    /* Se cierran sus sesiones abiertas */
    await bd.consultar(
      'UPDATE sesion SET cerrada = NOW() WHERE usuario_id = ? AND cerrada IS NULL', [id]);

    await auth.auditar(req.usuario.id, 'modificar', 'usuario', id,
      `Restableció la contraseña de ${u.nombre}`, req.ip);

    res.json({ ok: true, claveTemporal: CONFIG.claveTemporal });
  } catch (e) { next(e); }
});

/* ── Desactivar ──────────────────────────────────────────────────────
   No se borra: se desactiva. Borrarlo dejaría sus llamadas e
   interacciones sin dueño y rompería el historial.                    */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (id === req.usuario.id) {
      return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });
    }

    const u = await bd.una('SELECT nombre, extension FROM usuario WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ error: 'El usuario no existe' });

    await bd.transaccion(async (cx) => {
      await cx.execute('UPDATE usuario SET activo = FALSE WHERE id = ?', [id]);
      await cx.execute(
        'UPDATE sesion SET cerrada = NOW() WHERE usuario_id = ? AND cerrada IS NULL', [id]);
      if (u.extension) await asterisk.eliminarExtension(cx, u.extension);
    });

    await auth.auditar(req.usuario.id, 'desactivar', 'usuario', id,
      `Desactivó a ${u.nombre}`, req.ip);

    res.json({ ok: true });
  } catch (e) { next(e); }
});


/* ── Roles disponibles ── */
router.get('/roles/lista', async (req, res, next) => {
  try {
    res.json(await bd.consultar('SELECT id, nombre, descripcion FROM rol ORDER BY id'));
  } catch (e) { next(e); }
});

module.exports = router;