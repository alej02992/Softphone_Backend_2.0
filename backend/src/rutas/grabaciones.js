/* ═══════════════════════════════════════════════════════════════════
   GRABACIONES

   Asterisk deja los archivos de audio en una carpeta del servidor. El
   nombre de cada archivo lleva la fecha, la hora, la extensión que
   atendió y el número marcado:

       20260918-143052_1011_3102879726.mp3

   Este módulo lee esa carpeta, interpreta los nombres y sirve el audio
   al navegador.

   No se usa la base de datos: la fuente de verdad son los archivos que
   escribe la central. Cuando exista el registro automático de llamadas,
   esto se cruzará con la tabla `interaccion` para añadir la
   tipificación y el nombre del cliente.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const bd = require('../bd');
const auth = require('../auth');
const CONFIG = require('../config');

const router = express.Router();

/* Todas las rutas exigen sesión iniciada y el permiso de grabaciones.
   El permiso lo tienen supervisor y superadministrador. */
router.use(auth.exigirSesion);

/* Extensiones de audio que Asterisk puede generar */
const AUDIO = ['.mp3', '.wav', '.ogg', '.gsm'];

/* El nombre del archivo: fecha-hora_extensión_número */
const PATRON = /^(\d{8})-(\d{6})_([^_]+)_(.+)\.(mp3|wav|ogg|gsm)$/i;

/** Convierte el nombre del archivo en datos utilizables. */
function interpretar(nombre) {
  const m = nombre.match(PATRON);
  if (!m) return null;

  const [, f, h, extension, numero] = m;
  const fecha = `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
  const hora = `${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}`;

  return {
    archivo: nombre,
    fecha,
    hora,
    fechaHora: `${fecha}T${hora}`,
    extension,
    numero,
  };
}

/** Lee la carpeta de grabaciones y devuelve lo que hay. */
async function listarArchivos() {
  const dir = CONFIG.grabaciones.ruta;

  let entradas;
  try {
    entradas = await fsp.readdir(dir);
  } catch (e) {
    /* La carpeta puede no existir todavía si nunca se ha grabado. Es
       una situación normal, no un error del servidor. */
    if (e.code === 'ENOENT') return { existe: false, archivos: [] };
    throw e;
  }

  const archivos = [];

  for (const nombre of entradas) {
    if (!AUDIO.includes(path.extname(nombre).toLowerCase())) continue;

    const datos = interpretar(nombre);
    if (!datos) continue;              // nombre con otro formato

    let st;
    try { st = await fsp.stat(path.join(dir, nombre)); } catch { continue; }
    if (!st.isFile()) continue;

    /* Los archivos muy pequeños son llamadas que no llegaron a tener
       audio. Se marcan para que el supervisor no pierda tiempo. */
    archivos.push({
      ...datos,
      bytes: st.size,
      vacia: st.size < CONFIG.grabaciones.minimoBytes,
      modificado: st.mtime,
    });
  }

  archivos.sort((a, b) => b.fechaHora.localeCompare(a.fechaHora));
  return { existe: true, archivos };
}

/** Un supervisor solo ve las grabaciones de los agentes de sus
    campañas. El administrador las ve todas. */
async function extensionesPermitidas(usuario) {
  if (usuario.rol === 'admin') return null;     // sin filtro

  const filas = await bd.consultar(
    `SELECT u.extension
       FROM usuario u
       JOIN usuario_campana uc ON uc.campana_id = u.campana_id
      WHERE uc.usuario_id = ? AND u.extension IS NOT NULL`,
    [usuario.id]
  );

  /* Si no tiene campañas asignadas, ve las suyas y nada más. */
  if (!filas.length) {
    const yo = await bd.una('SELECT extension FROM usuario WHERE id = ?', [usuario.id]);
    return yo?.extension ? [yo.extension] : [];
  }
  return filas.map((f) => f.extension);
}

/* ═══════════ LISTAR ═══════════ */

router.get('/', auth.exigirSesion, auth.exigir('grabaciones'), async (req, res, next) => {
  try {
    const { desde, hasta, extension, numero, limite } = req.query;

    const { existe, archivos } = await listarArchivos();

    if (!existe) {
      return res.json({
        total: 0,
        grabaciones: [],
        aviso: 'La carpeta de grabaciones no existe todavía. ' +
               'Se crea con la primera llamada grabada.',
      });
    }

    const permitidas = await extensionesPermitidas(req.usuario);

    /* Nombres de los agentes, para mostrarlos en lugar del número de
       extensión, que no le dice nada al supervisor. */
    const agentes = await bd.consultar(
      'SELECT extension, nombre FROM usuario WHERE extension IS NOT NULL');
    const nombrePorExt = Object.fromEntries(agentes.map((a) => [a.extension, a.nombre]));

    let lista = archivos;

    if (permitidas) lista = lista.filter((g) => permitidas.includes(g.extension));
    if (desde)      lista = lista.filter((g) => g.fecha >= desde);
    if (hasta)      lista = lista.filter((g) => g.fecha <= hasta);
    if (extension)  lista = lista.filter((g) => g.extension === extension);
    if (numero)     lista = lista.filter((g) => g.numero.includes(numero));

    const total = lista.length;
    const tope = Math.min(Number(limite) || 200, 500);

    res.json({
      total,
      mostrando: Math.min(total, tope),
      grabaciones: lista.slice(0, tope).map((g) => ({
        id: g.archivo,
        fecha: g.fecha,
        hora: g.hora,
        extension: g.extension,
        agente: nombrePorExt[g.extension] || '—',
        numero: g.numero,
        bytes: g.bytes,
        vacia: g.vacia,
      })),
    });
  } catch (e) { next(e); }
});

/* ═══════════ REPRODUCIR Y DESCARGAR ═══════════ */

/* El navegador pide el audio por este camino. Se comprueba el permiso
   igual que en la lista: nadie puede escuchar una grabación de otra
   campaña adivinando el nombre del archivo. */
router.get('/:archivo', auth.exigirSesion, auth.exigir('grabaciones'), async (req, res, next) => {
  try {
    const nombre = path.basename(req.params.archivo);   // evita ../
    const datos = interpretar(nombre);

    if (!datos) return res.status(400).json({ error: 'Nombre de grabación no válido' });

    const permitidas = await extensionesPermitidas(req.usuario);
    if (permitidas && !permitidas.includes(datos.extension)) {
      return res.status(403).json({ error: 'Esa grabación no es de tus campañas' });
    }

    const ruta = path.join(CONFIG.grabaciones.ruta, nombre);
    if (!fs.existsSync(ruta)) {
      return res.status(404).json({ error: 'La grabación ya no está en el servidor' });
    }

    await auth.auditar(req.usuario.id, 'consultar', 'grabacion', nombre,
      `Reprodujo la grabación de ${datos.extension} con ${datos.numero}`, req.ip);

    /* Se envía con soporte de rangos para que el reproductor pueda
       saltar a cualquier punto sin descargar todo el archivo. */
    res.sendFile(ruta, {
      headers: { 'Content-Disposition': `inline; filename="${nombre}"` },
    });
  } catch (e) { next(e); }
});

module.exports = router;
