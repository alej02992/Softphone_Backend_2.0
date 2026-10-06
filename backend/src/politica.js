/* ═══════════════════════════════════════════════════════════════════
   POLÍTICA DE CONTRASEÑAS

   Las reglas viven en la base, no en el código, para que el
   administrador pueda cambiarlas desde la plataforma sin que nadie
   toque el servidor.

   CÓMO SE APLICA SIN TOCAR EL INICIO DE SESIÓN
   Esto se monta como una capa delante de las rutas de sesión: ve pasar
   la petición, deja que la atienda quien corresponde, y mira cómo
   terminó. Si fue un fallo, cuenta el intento; si fue un acierto,
   borra el contador.

   Se hizo así a propósito. El inicio de sesión es la pieza más
   delicada de la plataforma y lleva meses funcionando: meterle mano
   para agregar un contador es arriesgar lo que ya sirve. Esta capa
   hace lo mismo sin tocar una línea de ese archivo.

   EL HISTORIAL
   Se guarda el cifrado de cada contraseña usada, nunca la contraseña.
   No se puede leer: solo comparar una nueva contra las anteriores para
   saber si ya la usó.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const bd = require('./bd');
const auth = require('./auth');

/* Las reglas se leen de la base, pero no en cada petición: se guardan
   un minuto en memoria. Son datos que cambian una vez al año. */
let cache = null;
let cacheHasta = 0;

const POR_DEFECTO = {
  dias_expiracion: 0,
  intentos_maximos: 5,
  minutos_bloqueo: 0,
  claves_recordadas: 5,
  dias_inactividad: 0,
  largo_minimo: 8,
  exige_minusculas: 1,
  exige_mayusculas: 1,
  exige_numeros: 1,
  exige_especiales: 0,
};

/** Fecha que significa "bloqueado hasta que un administrador lo quite". */
const PARA_SIEMPRE = '9999-12-31 00:00:00';

async function leer(forzar = false) {
  if (!forzar && cache && Date.now() < cacheHasta) return cache;

  try {
    const filas = await bd.consultar('SELECT clave, valor FROM politica');
    const reglas = { ...POR_DEFECTO };
    filas.forEach((f) => { reglas[f.clave] = Number(f.valor); });
    cache = reglas;
    cacheHasta = Date.now() + 60000;
  } catch {
    /* Si la tabla todavía no existe, se usan los valores por defecto:
       la plataforma no puede quedarse sin iniciar sesión por esto. */
    cache = { ...POR_DEFECTO };
    cacheHasta = Date.now() + 10000;
  }
  return cache;
}

async function guardar(cambios, usuarioId, ip) {
  const reglas = await leer(true);
  const guardados = [];

  for (const [clave, valor] of Object.entries(cambios)) {
    if (!(clave in POR_DEFECTO)) continue;
    const n = Number(valor);
    if (!Number.isFinite(n) || n < 0) continue;

    await bd.consultar(
      `INSERT INTO politica (clave, valor) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [clave, String(Math.round(n))]);
    if (reglas[clave] !== n) guardados.push(`${clave}: ${reglas[clave]} → ${n}`);
  }

  cache = null;
  if (guardados.length) {
    await auth.auditar(usuarioId, 'modificar', 'politica', null,
      'Cambió la política: ' + guardados.join(', '), ip);
  }
  return leer(true);
}

/* ═══════════ REVISAR UNA CONTRASEÑA NUEVA ═══════════ */

/** Devuelve la lista de reglas que no cumple. Vacía si está bien. */
async function revisarFormato(clave) {
  const r = await leer();
  const c = String(clave || '');
  const faltan = [];

  if (c.length < r.largo_minimo) faltan.push(`al menos ${r.largo_minimo} caracteres`);
  if (r.exige_minusculas && !/[a-záéíóúñ]/.test(c)) faltan.push('una minúscula');
  if (r.exige_mayusculas && !/[A-ZÁÉÍÓÚÑ]/.test(c)) faltan.push('una mayúscula');
  if (r.exige_numeros && !/[0-9]/.test(c)) faltan.push('un número');
  if (r.exige_especiales && !/[^A-Za-z0-9áéíóúñÁÉÍÓÚÑ]/.test(c)) {
    faltan.push('un carácter especial');
  }
  return faltan;
}

/** ¿Ya usó esta contraseña antes? */
async function yaLaUso(usuarioId, clave) {
  const r = await leer();
  if (!r.claves_recordadas) return false;

  const anteriores = await bd.consultar(
    `SELECT clave_hash FROM usuario_clave
      WHERE usuario_id = ? ORDER BY creada DESC LIMIT ?`,
    [usuarioId, r.claves_recordadas]);

  for (const a of anteriores) {
    if (await auth.verificarClave(clave, a.clave_hash)) return true;
  }
  return false;
}

/** Guarda la contraseña en el historial y deja solo las últimas. */
async function recordar(usuarioId, claveHash) {
  const r = await leer();
  await bd.consultar(
    'INSERT INTO usuario_clave (usuario_id, clave_hash) VALUES (?, ?)',
    [usuarioId, claveHash]);
  await bd.consultar('UPDATE usuario SET clave_cambiada = NOW() WHERE id = ?', [usuarioId]);

  /* Se conservan unas cuantas más de las que pide la regla, por si
     mañana la suben. */
  const guardar_ = Math.max(r.claves_recordadas * 2, 10);
  const viejas = await bd.consultar(
    `SELECT id FROM usuario_clave WHERE usuario_id = ? ORDER BY creada DESC LIMIT 100 OFFSET ?`,
    [usuarioId, guardar_]);
  for (const v of viejas) {
    await bd.consultar('DELETE FROM usuario_clave WHERE id = ?', [v.id]);
  }
}

/* ═══════════ BLOQUEO POR INTENTOS FALLIDOS ═══════════ */

/** ¿Está bloqueada la cuenta? Devuelve el motivo, o null. */
async function estaBloqueado(usuario) {
  const u = await bd.una(
    'SELECT id, bloqueado_hasta FROM usuario WHERE usuario = ?', [usuario]);
  if (!u?.bloqueado_hasta) return null;

  const hasta = new Date(u.bloqueado_hasta);
  if (hasta > new Date()) {
    /* Un bloqueo con fecha lejana es el que solo quita un administrador */
    if (hasta.getFullYear() >= 9999) {
      return 'Tu cuenta está bloqueada por intentos fallidos. Pídele a un administrador que la libere.';
    }
    const minutos = Math.ceil((hasta - new Date()) / 60000);
    return `Tu cuenta está bloqueada. Intenta de nuevo en ${minutos} minuto(s).`;
  }

  /* El bloqueo ya venció: se levanta solo */
  await bd.consultar(
    'UPDATE usuario SET bloqueado_hasta = NULL, intentos_fallidos = 0 WHERE id = ?', [u.id]);
  return null;
}

async function contarFallo(usuario, ip) {
  const r = await leer();
  const u = await bd.una(
    'SELECT id, nombre, intentos_fallidos FROM usuario WHERE usuario = ?', [usuario]);

  /* Si el usuario no existe no se cuenta nada: contar intentos de
     nombres inventados solo serviría para llenar la base. */
  if (!u) return;

  const fallos = (u.intentos_fallidos || 0) + 1;

  if (fallos >= r.intentos_maximos) {
    const hasta = r.minutos_bloqueo
      ? new Date(Date.now() + r.minutos_bloqueo * 60000)
      : PARA_SIEMPRE;

    await bd.consultar(
      'UPDATE usuario SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?',
      [fallos, hasta, u.id]);

    await auth.auditar(null, 'modificar', 'usuario', u.id,
      `Cuenta de ${u.nombre} bloqueada tras ${fallos} intentos fallidos`, ip);
    return;
  }

  await bd.consultar(
    'UPDATE usuario SET intentos_fallidos = ? WHERE id = ?', [fallos, u.id]);
}

const limpiarFallos = (usuario) =>
  bd.consultar(
    'UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE usuario = ?',
    [usuario]);

/* ═══════════ LA CAPA ═══════════ */

/** De quién es la sesión que viene en la petición.

    La capa se monta antes de que se valide el token, así que aquí se
    mira directamente: se busca la sesión abierta con ese identificador.
    No se usa para dar permisos —de eso se encarga la validación de
    siempre— sino solo para saber de quién es el historial. */
async function deQuienEsElToken(req) {
  try {
    const cabecera = String(req.headers.authorization || '');
    const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
    if (!token) return null;

    const jwt = require('jsonwebtoken');
    const CONFIG = require('./config');
    const datos = jwt.verify(token, CONFIG.jwt.clave || CONFIG.jwt.secreto);
    return datos?.id || datos?.usuario_id || null;
  } catch {
    return null;
  }
}

/**
 * Se monta delante de las rutas de sesión. Comprueba el bloqueo antes
 * de dejar pasar, y mira el resultado para contar o limpiar fallos.
 */
function vigilarAcceso() {
  return async (req, res, siguiente) => {
    /* Solo interesa el inicio de sesión */
    const esEntrada = req.method === 'POST' && (req.path === '/' || req.path === '');
    const esCambio = req.method === 'PUT' && req.path === '/clave';

    if (!esEntrada && !esCambio) return siguiente();

    try {
      /* ── Antes: ¿puede intentarlo siquiera? ── */
      if (esEntrada && req.body?.usuario) {
        const motivo = await estaBloqueado(String(req.body.usuario));
        if (motivo) return res.status(423).json({ error: motivo, bloqueado: true });
      }

      /* ── Antes: ¿la contraseña nueva cumple las reglas? ──

         Esta capa corre ANTES de que se valide la sesión, así que aquí
         todavía no se sabe quién es. El formato se puede revisar sin
         saberlo; para el historial hace falta el usuario, y ese se
         averigua leyendo el token. */
      if (esCambio) {
        /* La plataforma manda `claveNueva`; se aceptan también otros
           nombres por si cambia. */
        const nueva = req.body?.claveNueva || req.body?.nueva || req.body?.clave;
        if (nueva) {
          const faltan = await revisarFormato(nueva);
          if (faltan.length) {
            return res.status(400).json({
              error: 'La contraseña debe tener ' + faltan.join(', ') + '.',
            });
          }
          const quien = await deQuienEsElToken(req);
          if (quien && await yaLaUso(quien, nueva)) {
            const r = await leer();
            return res.status(400).json({
              error: `Esa contraseña ya la usaste. No puedes repetir las últimas ${r.claves_recordadas}.`,
            });
          }
        }
      }
    } catch (e) {
      /* Un fallo aquí no puede dejar a nadie fuera de la plataforma */
      return siguiente();
    }

    /* ── Después: mirar cómo terminó ── */
    const responder = res.json.bind(res);
    res.json = (cuerpo) => {
      const bien = res.statusCode >= 200 && res.statusCode < 300;

      if (esEntrada && req.body?.usuario) {
        if (bien) limpiarFallos(String(req.body.usuario)).catch(() => {});
        else if (res.statusCode === 401) contarFallo(String(req.body.usuario), req.ip).catch(() => {});
      }

      if (esCambio && bien && req.usuario?.id) {
        const nueva = req.body?.claveNueva || req.body?.nueva || req.body?.clave;
        if (nueva) {
          auth.cifrarClave(nueva)
            .then((hash) => recordar(req.usuario.id, hash))
            .catch(() => {});
        }
      }

      return responder(cuerpo);
    };

    siguiente();
  };
}

/* ═══════════ CUENTAS BLOQUEADAS ═══════════ */

const bloqueados = () =>
  bd.consultar(
    `SELECT id, usuario, nombre, correo, intentos_fallidos, bloqueado_hasta
       FROM usuario
      WHERE bloqueado_hasta IS NOT NULL AND bloqueado_hasta > NOW()
      ORDER BY bloqueado_hasta DESC`);

async function desbloquear(id, quien, ip) {
  const u = await bd.una('SELECT nombre FROM usuario WHERE id = ?', [id]);
  if (!u) return null;

  await bd.consultar(
    'UPDATE usuario SET bloqueado_hasta = NULL, intentos_fallidos = 0 WHERE id = ?', [id]);
  await auth.auditar(quien, 'modificar', 'usuario', id,
    `Desbloqueó la cuenta de ${u.nombre}`, ip);
  return u.nombre;
}

/** Usuarios que llevan demasiado tiempo sin entrar. Se desactivan en
    lugar de borrarse: su historial se conserva. */
async function desactivarInactivos() {
  const r = await leer();
  if (!r.dias_inactividad) return 0;

  const [res] = await bd.pool.execute(
    `UPDATE usuario
        SET activo = FALSE
      WHERE activo = TRUE
        AND rol_id <> 3
        AND ultimo_acceso IS NOT NULL
        AND ultimo_acceso < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [r.dias_inactividad]);

  return res.affectedRows;
}

module.exports = {
  leer, guardar, revisarFormato, yaLaUso, recordar,
  vigilarAcceso, bloqueados, desbloquear, desactivarInactivos, PARA_SIEMPRE,
};
