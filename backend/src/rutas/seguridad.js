/* ═══════════════════════════════════════════════════════════════════
   SEGURIDAD

   El administrador define las reglas de contraseñas y ve qué cuentas
   están bloqueadas.

   Las reglas viven en la base para que se puedan cambiar desde la
   plataforma. Si mañana la empresa decide que son 10 caracteres y no
   8, nadie tiene que entrar al servidor.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const auth = require('../auth');
const politica = require('../politica');

const router = express.Router();

/* El permiso se exige en cada ruta, no con `router.use`.

   Con `router.use`, al estar este router montado en /api, ese permiso
   se le pedía a TODAS las rutas que pasaran por aquí: registrar una
   llamada, pedir un contacto, cualquier cosa. La plataforma entera
   quedaba exigiendo permisos de administrador. */
const soloAdmin = [auth.exigirSesion, auth.exigir('usuarios')];

router.get('/seguridad/politica', soloAdmin, async (req, res, next) => {
  try {
    res.json(await politica.leer(true));
  } catch (e) { next(e); }
});

router.put('/seguridad/politica', soloAdmin, async (req, res, next) => {
  try {
    const reglas = await politica.guardar(req.body || {}, req.usuario.id, req.ip);

    /* Avisos sobre reglas que suelen traer consecuencias no previstas */
    const avisos = [];
    if (reglas.dias_inactividad && reglas.dias_inactividad < 20) {
      avisos.push(`Con ${reglas.dias_inactividad} días, quien salga de vacaciones ` +
                  'puede volver y encontrar su cuenta desactivada.');
    }
    if (reglas.dias_expiracion && reglas.dias_expiracion < 30) {
      avisos.push('Cambiar la contraseña muy seguido suele llevar a contraseñas ' +
                  'más débiles, del tipo "Clave01", "Clave02".');
    }
    if (reglas.intentos_maximos && reglas.intentos_maximos < 3) {
      avisos.push('Con tan pocos intentos, un error de tecleo bloquea la cuenta.');
    }
    if (!reglas.minutos_bloqueo) {
      avisos.push('Los bloqueos duran hasta que un administrador los quite: ' +
                  'revisa la lista de cuentas bloqueadas con frecuencia.');
    }

    res.json({ ok: true, politica: reglas, avisos });
  } catch (e) { next(e); }
});

/** Cuentas bloqueadas ahora mismo. Sin esto, el administrador no se
    entera de que alguien no puede entrar hasta que lo llamen. */
router.get('/seguridad/bloqueados', soloAdmin, async (req, res, next) => {
  try {
    res.json(await politica.bloqueados());
  } catch (e) { next(e); }
});

router.post('/seguridad/desbloquear/:id', soloAdmin, async (req, res, next) => {
  try {
    const nombre = await politica.desbloquear(Number(req.params.id), req.usuario.id, req.ip);
    if (!nombre) return res.status(404).json({ error: 'El usuario no existe' });
    res.json({ ok: true, nombre });
  } catch (e) { next(e); }
});

/** Desactiva a quienes llevan demasiado tiempo sin entrar. Se lanza a
    mano para que el administrador vea a cuántos afecta antes. */
router.post('/seguridad/inactivos', soloAdmin, async (req, res, next) => {
  try {
    const n = await politica.desactivarInactivos();
    if (n) {
      await auth.auditar(req.usuario.id, 'desactivar', 'usuario', null,
        `Desactivó ${n} usuario(s) por inactividad`, req.ip);
    }
    res.json({ desactivados: n });
  } catch (e) { next(e); }
});

module.exports = router;
