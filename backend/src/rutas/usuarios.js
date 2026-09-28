/* ═══════════════════════════════════════════════════════════════════
   USUARIOS

   Crear, listar, modificar y desactivar. También el alta masiva desde
   un archivo y las campañas a cargo de un supervisor.

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

      /* La campaña principal cuenta también como campaña a cargo: de
         `usuario_campana` salen los permisos de supervisión. */
      if (campana_id) {
        await cx.execute(
          'INSERT IGNORE INTO usuario_campana (usuario_id, campana_id) VALUES (?, ?)',
          [r.insertId, campana_id]);
      }

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


/* ═══════════ ALTA MASIVA ═══════════

   Poner 300 agentes a mano no es viable. El administrador sube un
   archivo separado por comas —lo que Excel exporta como CSV— y la
   plataforma crea todos de una vez.

   Dos pasos a propósito: primero una revisión que no escribe nada y
   devuelve fila por fila qué está bien y qué está mal, y después la
   creación. Así se ven los errores antes de crear nada.

   Cada fila se crea por separado: si una falla, las demás siguen. Con
   300 filas, detener todo por un correo mal escrito sería peor.

   Va antes de las rutas con /:id para que "masivo" no se confunda con
   el identificador de un usuario.                                     */

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USUARIO = /^[a-z0-9._-]{3,40}$/;
const EXTENSION = /^\d{3,6}$/;

const ROLES = { agente: 1, supervisor: 2, admin: 3, administrador: 3, superadmin: 3 };

/** Revisa la forma de una fila. No consulta la base: eso se hace
    después, una sola vez para todas. */
function revisarForma(f) {
  const errores = [];

  const usuario = String(f.usuario || '').trim().toLowerCase();
  const nombre = String(f.nombre || '').trim();
  const correo = String(f.correo || '').trim();
  const extension = String(f.extension || '').trim();
  const rol = String(f.rol || 'agente').trim().toLowerCase();

  if (!USUARIO.test(usuario)) {
    errores.push('El usuario debe tener de 3 a 40 caracteres, sin espacios ni tildes');
  }
  if (nombre.length < 3) errores.push('Falta el nombre completo');
  if (correo && !CORREO.test(correo)) errores.push('El correo no es válido');
  if (extension && !EXTENSION.test(extension)) errores.push('La extensión debe ser de 3 a 6 dígitos');
  if (!ROLES[rol]) errores.push(`Rol desconocido: "${f.rol}"`);

  return { usuario, nombre, correo, extension, rol, rol_id: ROLES[rol], errores };
}

router.post('/masivo', async (req, res, next) => {
  try {
    const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
    const soloRevisar = req.body.revisar !== false;

    if (!filas.length) return res.status(400).json({ error: 'El archivo no trae filas' });
    if (filas.length > 500) {
      return res.status(400).json({ error: 'Máximo 500 filas por archivo. Divídelo en varios.' });
    }

    /* Todo lo que hay en la base, para comparar sin una consulta por fila */
    const [usuariosBd, campanasBd] = await Promise.all([
      bd.consultar('SELECT usuario, extension FROM usuario'),
      bd.consultar('SELECT id, nombre FROM campana WHERE activa = TRUE'),
    ]);

    const usados = new Set(usuariosBd.map((u) => u.usuario.toLowerCase()));
    const extensiones = new Set(usuariosBd.filter((u) => u.extension).map((u) => u.extension));
    const porNombre = new Map(campanasBd.map((c) => [c.nombre.toLowerCase(), c.id]));

    /* Se revisan todas antes de crear ninguna */
    const enArchivo = new Set();
    const extEnArchivo = new Set();

    const revisadas = filas.map((f, i) => {
      const r = revisarForma(f);
      r.linea = i + 2;               // la 1 es el encabezado

      if (usados.has(r.usuario)) r.errores.push('Ese usuario ya existe en la plataforma');
      if (enArchivo.has(r.usuario)) r.errores.push('Ese usuario está repetido en el archivo');
      enArchivo.add(r.usuario);

      if (r.extension) {
        if (extensiones.has(r.extension)) r.errores.push('Esa extensión ya está asignada');
        if (extEnArchivo.has(r.extension)) r.errores.push('Esa extensión se repite en el archivo');
        extEnArchivo.add(r.extension);
      }

      const campana = String(f.campana || '').trim();
      if (campana) {
        const id = porNombre.get(campana.toLowerCase());
        if (!id) r.errores.push(`La campaña "${campana}" no existe`);
        else r.campana_id = id;
      }
      r.campana = campana;
      return r;
    });

    const validas = revisadas.filter((r) => !r.errores.length);

    if (soloRevisar) {
      return res.json({
        revisado: true,
        total: revisadas.length,
        correctas: validas.length,
        conError: revisadas.length - validas.length,
        filas: revisadas.map(({ linea, usuario, nombre, correo, extension, rol, campana, errores }) =>
          ({ linea, usuario, nombre, correo, extension, rol, campana, errores })),
      });
    }

    /* ── Creación ──
       Fila por fila, cada una en su transacción: si una falla, las
       demás se crean igual y el administrador ve cuáles fallaron. */
    const temporal = CONFIG.claveTemporal || 'BpmTemp2026';
    const clave = await auth.cifrarClave(temporal);
    const creados = [];
    const fallidos = [];

    for (const r of validas) {
      try {
        await bd.transaccion(async (cx) => {
          const [ins] = await cx.execute(
            `INSERT INTO usuario (usuario, nombre, correo, clave_hash, rol_id, campana_id, extension)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [r.usuario, r.nombre, r.correo || null, clave, r.rol_id,
             r.campana_id || null, r.extension || null]);

          if (r.campana_id) {
            await cx.execute(
              'INSERT IGNORE INTO usuario_campana (usuario_id, campana_id) VALUES (?, ?)',
              [ins.insertId, r.campana_id]);
          }

          if (r.extension) {
            const claveSip = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '');
            await asterisk.crearExtension(cx, { extension: r.extension, clave: claveSip });

            if (r.campana_id) {
              const c = await cx.execute(
                'SELECT cola_asterisk FROM campana WHERE id = ?', [r.campana_id]);
              const cola = c[0][0]?.cola_asterisk;
              if (cola) await asterisk.asignarCola(cx, r.extension, cola, true);
            }
          }
        });
        creados.push(r.usuario);
      } catch (e) {
        fallidos.push({ linea: r.linea, usuario: r.usuario, error: e.message });
      }
    }

    await auth.auditar(req.usuario.id, 'crear', 'usuario', null,
      `Alta masiva: ${creados.length} usuarios creados de ${filas.length} filas`, req.ip);

    res.json({
      creados: creados.length,
      fallidos,
      omitidas: revisadas.length - validas.length,
      claveTemporal: temporal,
    });
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

    /* Al reactivar a alguien hay que devolverle su extensión: al darlo
       de baja se eliminó de la central, y sin ella entraría a la
       plataforma pero no podría llamar. */
    if (!antes.activo && (activo ?? antes.activo) && antes.extension) {
      await bd.transaccion(async (cx) => {
        await asterisk.crearExtension(cx, {
          extension: antes.extension,
          clave: crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, ''),
        });
      });
    }

    /* Cambiar el rol es solo cambiar una columna.
       La persona ve el menú nuevo en su siguiente inicio de sesión. */
    const cambioRol = rol_id && rol_id !== antes.rol_id;

    await auth.auditar(req.usuario.id, 'modificar', 'usuario', id,
      cambioRol ? `Cambió el rol de ${antes.nombre}` : `Modificó a ${antes.nombre}`, req.ip);

    res.json({ ok: true, cambioRol });
  } catch (e) { next(e); }
});


/* ── Campañas a cargo ─────────────────────────────────────────────
   Un supervisor puede tener varias. La ficha guarda la principal
   (`usuario.campana_id`) y aquí viven todas. De esta tabla salen los
   permisos de supervisión: qué agentes ve, qué grabaciones escucha y
   para qué campañas puede crear estados de pausa.                    */

router.get('/:id/campanas', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    res.json(await bd.consultar(
      `SELECT c.id, c.nombre
         FROM usuario_campana uc
         JOIN campana c ON c.id = uc.campana_id
        WHERE uc.usuario_id = ?
        ORDER BY c.nombre`, [id]));
  } catch (e) { next(e); }
});

/** Reemplaza la lista completa: llegan las que quedan marcadas. */
router.put('/:id/campanas', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const u = await bd.una('SELECT nombre FROM usuario WHERE id = ?', [id]);
    if (!u) return res.status(404).json({ error: 'El usuario no existe' });

    const ids = [...new Set((req.body.campanas || []).map(Number).filter(Boolean))];

    if (ids.length) {
      const validas = await bd.consultar(
        `SELECT id FROM campana WHERE activa = TRUE AND id IN (${ids.map(() => '?').join(',')})`, ids);
      if (validas.length !== ids.length) {
        return res.status(400).json({ error: 'Alguna de las campañas no existe o está inactiva' });
      }
    }

    await bd.transaccion(async (cx) => {
      await cx.execute('DELETE FROM usuario_campana WHERE usuario_id = ?', [id]);
      for (const c of ids) {
        await cx.execute(
          'INSERT INTO usuario_campana (usuario_id, campana_id) VALUES (?, ?)', [id, c]);
      }
    });

    await auth.auditar(req.usuario.id, 'modificar', 'usuario', id,
      `Asignó ${ids.length} campaña(s) a ${u.nombre}`, req.ip);

    res.json({ ok: true, campanas: ids.length });
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