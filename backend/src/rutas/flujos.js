/* ═══════════════════════════════════════════════════════════════════
   BPM CONSULTING · Flujos IVR (fase 1: el diseñador)

   Guarda los flujos que se dibujan en el lienzo: qué bloques tienen,
   cómo están configurados, dónde están y cómo se unen.

   Un flujo "activo" se traduce a plan de marcación y la central lo usa
   (flujos-asterisk.js). Se prueba marcando *77 más su número desde
   cualquier extensión. Si la central rechaza el cambio, todo vuelve a
   como estaba.

   Solo para administradores: es el mismo permiso que usuarios y
   troncales, porque un flujo decide a dónde va cada llamada que entra.
   ═══════════════════════════════════════════════════════════════════ */

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');
const central = require('../flujos-asterisk');

const router = express.Router();

/* Los bloques que existen. Lo que no esté aquí no se guarda. */
const TIPOS = ['inicio', 'reproducir', 'menu', 'campana', 'persona', 'horario', 'colgar'];

const MAX_BLOQUES = 150;
const MAX_FLECHAS = 400;
const MAX_TAMANO = 200 * 1024;        // 200 KB de diseño: sobra para cualquier IVR

/* El diseño de un flujo nuevo: solo el bloque de inicio */
const DISENO_NUEVO = () => ({
  nodos: [{ id: 'inicio', tipo: 'inicio', x: 80, y: 160, config: {} }],
  flechas: [],
});

/**
 * Comprueba que el diseño tenga la forma correcta antes de guardarlo.
 *
 * No juzga si el flujo está completo —eso lo hace el lienzo, y lo
 * repetirá la fase 2 antes de activarlo—: solo que no llegue basura, ni
 * algo enorme, ni flechas que apunten a bloques que no existen.
 * Devuelve el diseño limpio, o un texto con el problema.
 */
function revisarDiseno(d) {
  if (!d || typeof d !== 'object') return 'El diseño llegó vacío';
  if (JSON.stringify(d).length > MAX_TAMANO) return 'El flujo es demasiado grande';

  const nodos = Array.isArray(d.nodos) ? d.nodos : [];
  const flechas = Array.isArray(d.flechas) ? d.flechas : [];
  if (!nodos.length) return 'El flujo no tiene bloques';
  if (nodos.length > MAX_BLOQUES) return `Un flujo puede tener hasta ${MAX_BLOQUES} bloques`;
  if (flechas.length > MAX_FLECHAS) return `Un flujo puede tener hasta ${MAX_FLECHAS} flechas`;

  const ids = new Set();
  const limpios = [];
  for (const n of nodos) {
    const id = String(n?.id || '');
    if (!/^[a-z0-9_-]{1,40}$/i.test(id)) return 'Hay un bloque con un identificador no válido';
    if (ids.has(id)) return 'Hay dos bloques con el mismo identificador';
    if (!TIPOS.includes(n.tipo)) return `Tipo de bloque desconocido: ${String(n.tipo).slice(0, 20)}`;
    ids.add(id);
    limpios.push({
      id,
      tipo: n.tipo,
      x: Math.round(Number(n.x) || 0),
      y: Math.round(Number(n.y) || 0),
      config: n.config && typeof n.config === 'object' ? n.config : {},
    });
  }
  if (limpios.filter((n) => n.tipo === 'inicio').length !== 1) {
    return 'El flujo debe tener un solo bloque de inicio';
  }

  const usadas = new Set();
  const flechasLimpias = [];
  for (const f of flechas) {
    const desde = String(f?.desde || ''), hacia = String(f?.hacia || '');
    const salida = String(f?.salida || '').slice(0, 20);
    if (!ids.has(desde) || !ids.has(hacia)) return 'Hay una flecha que apunta a un bloque que no existe';
    /* De cada salida sale una sola flecha */
    const clave = desde + '·' + salida;
    if (usadas.has(clave)) continue;
    usadas.add(clave);
    flechasLimpias.push({ desde, salida, hacia });
  }

  return { nodos: limpios, flechas: flechasLimpias };
}

const leerDiseno = (txt) => {
  try { return JSON.parse(txt); } catch { return DISENO_NUEVO(); }
};

const nombreValido = (txt) => {
  const n = String(txt || '').trim();
  if (n.length < 3) return { error: 'El nombre debe tener al menos 3 caracteres' };
  if (n.length > 80) return { error: 'El nombre puede tener hasta 80 caracteres' };
  return { nombre: n };
};

/* ═══════════ NÚMEROS DE ENTRADA (fase 3) ═══════════
   Qué flujo atiende cada número que entra por las troncales. Van antes
   que /flujos/:id: si no, "numeros" se tomaría por el número de un flujo.

   Cada cambio se publica en la central; si la central no lo acepta, se
   deshace en la base y todo queda como estaba.                        */

const activos = () => bd.consultar("SELECT id, nombre FROM flujo WHERE estado = 'activo' ORDER BY nombre");

async function publicarODeshacer(deshacer) {
  try {
    await central.publicar();
    return null;
  } catch (e) {
    await deshacer();
    return e.message;
  }
}

router.get('/flujos/numeros', auth.exigirSesion, auth.exigir('usuarios'), async (req, res, next) => {
  try {
    const filas = await bd.consultar(
      `SELECT fn.id, fn.numero, fn.flujo_id, fn.descripcion, f.nombre AS flujo, f.estado
         FROM flujo_numero fn JOIN flujo f ON f.id = fn.flujo_id ORDER BY fn.numero`);
    const def = filas.find((x) => x.numero === '*');
    res.json({
      numeros: filas.filter((x) => x.numero !== '*'),
      porDefecto: def ? def.flujo_id : null,
      flujos: await activos(),
    });
  } catch (e) { next(e); }
});

router.post('/flujos/numeros', auth.exigirSesion, auth.exigir('usuarios'), async (req, res, next) => {
  try {
    const numero = central.normalizar(req.body?.numero);
    if (!numero) return res.status(400).json({ error: 'El número debe tener solo dígitos, de 3 a 15' });
    const flujoId = Number(req.body?.flujo_id);
    if (!(await activos()).some((f) => f.id === flujoId)) {
      return res.status(400).json({ error: 'Elige un flujo activo: uno en borrador no puede atender llamadas' });
    }
    const ya = await bd.una('SELECT id FROM flujo_numero WHERE numero = ?', [numero]);
    if (ya) return res.status(409).json({ error: `El número ${numero} ya está asignado a un flujo` });

    const r = await bd.consultar(
      'INSERT INTO flujo_numero (numero, flujo_id, descripcion, creado_por) VALUES (?, ?, ?, ?)',
      [numero, flujoId, String(req.body?.descripcion || '').slice(0, 120) || null, req.usuario.id]);
    const fallo = await publicarODeshacer(() => bd.consultar('DELETE FROM flujo_numero WHERE id = ?', [r.insertId]));
    if (fallo) return res.status(502).json({ error: fallo });

    await auth.auditar(req.usuario.id, 'crear', 'flujo_numero', r.insertId,
      `El número ${numero} lo atiende el flujo ${flujoId}`, req.ip);
    res.status(201).json({ ok: true, id: r.insertId, numero });
  } catch (e) { next(e); }
});

router.put('/flujos/numeros/:id', auth.exigirSesion, auth.exigir('usuarios'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const antes = await bd.una('SELECT numero, flujo_id, descripcion FROM flujo_numero WHERE id = ? AND numero <> ?', [id, '*']);
    if (!antes) return res.status(404).json({ error: 'Ese número no existe' });
    const flujoId = Number(req.body?.flujo_id ?? antes.flujo_id);
    if (!(await activos()).some((f) => f.id === flujoId)) {
      return res.status(400).json({ error: 'Elige un flujo activo' });
    }
    const desc = req.body?.descripcion === undefined ? antes.descripcion : String(req.body.descripcion).slice(0, 120) || null;
    await bd.consultar('UPDATE flujo_numero SET flujo_id = ?, descripcion = ? WHERE id = ?', [flujoId, desc, id]);
    const fallo = await publicarODeshacer(() =>
      bd.consultar('UPDATE flujo_numero SET flujo_id = ?, descripcion = ? WHERE id = ?', [antes.flujo_id, antes.descripcion, id]));
    if (fallo) return res.status(502).json({ error: fallo });

    await auth.auditar(req.usuario.id, 'modificar', 'flujo_numero', id,
      `El número ${antes.numero} ahora lo atiende el flujo ${flujoId}`, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/flujos/numeros/:id', auth.exigirSesion, auth.exigir('usuarios'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const antes = await bd.una('SELECT * FROM flujo_numero WHERE id = ? AND numero <> ?', [id, '*']);
    if (!antes) return res.status(404).json({ error: 'Ese número no existe' });
    await bd.consultar('DELETE FROM flujo_numero WHERE id = ?', [id]);
    const fallo = await publicarODeshacer(() => bd.consultar(
      'INSERT INTO flujo_numero (id, numero, flujo_id, descripcion, creado_por) VALUES (?, ?, ?, ?, ?)',
      [antes.id, antes.numero, antes.flujo_id, antes.descripcion, antes.creado_por]));
    if (fallo) return res.status(502).json({ error: fallo });

    await auth.auditar(req.usuario.id, 'eliminar', 'flujo_numero', id, `Quitó el número ${antes.numero}`, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* El flujo de los números sin asignar: { flujo_id } o { flujo_id: null } para colgar */
router.put('/flujos/numeros-por-defecto', auth.exigirSesion, auth.exigir('usuarios'), async (req, res, next) => {
  try {
    const flujoId = req.body?.flujo_id ? Number(req.body.flujo_id) : null;
    if (flujoId && !(await activos()).some((f) => f.id === flujoId)) {
      return res.status(400).json({ error: 'Elige un flujo activo' });
    }
    const antes = await bd.una("SELECT flujo_id FROM flujo_numero WHERE numero = '*'");
    const poner = (fid) => (fid
      ? bd.consultar(`INSERT INTO flujo_numero (numero, flujo_id, creado_por) VALUES ('*', ?, ?)
                        ON DUPLICATE KEY UPDATE flujo_id = VALUES(flujo_id)`, [fid, req.usuario.id])
      : bd.consultar("DELETE FROM flujo_numero WHERE numero = '*'"));
    await poner(flujoId);
    const fallo = await publicarODeshacer(() => poner(antes?.flujo_id || null));
    if (fallo) return res.status(502).json({ error: fallo });

    await auth.auditar(req.usuario.id, 'modificar', 'flujo_numero', 0,
      flujoId ? `Los números sin asignar los atiende el flujo ${flujoId}` : 'Los números sin asignar se cuelgan', req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════ LISTA ═══════════ */

router.get('/flujos', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const filas = await bd.consultar(
        `SELECT f.id, f.nombre, f.descripcion, f.pendientes, f.estado, f.modificado, f.diseno,
                u.nombre AS modificado_por
           FROM flujo f LEFT JOIN usuario u ON u.id = f.modificado_por
          ORDER BY f.modificado DESC`);

      res.json(filas.map(({ diseno, ...f }) => ({
        ...f,
        bloques: (leerDiseno(diseno).nodos || []).length,
      })));
    } catch (e) { next(e); }
  });

/* ═══════════ ABRIR UNO ═══════════ */

router.get('/flujos/:id', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const f = await bd.una(
        'SELECT id, nombre, descripcion, diseno, pendientes, estado FROM flujo WHERE id = ?',
        [Number(req.params.id)]);
      if (!f) return res.status(404).json({ error: 'Ese flujo no existe' });
      res.json({ ...f, diseno: leerDiseno(f.diseno) });
    } catch (e) { next(e); }
  });

/* ═══════════ CREAR ═══════════ */

router.post('/flujos', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const v = nombreValido(req.body?.nombre);
      if (v.error) return res.status(400).json({ error: v.error });

      const r = await bd.consultar(
        `INSERT INTO flujo (nombre, descripcion, diseno, pendientes, creado_por, modificado_por)
         VALUES (?, ?, ?, 0, ?, ?)`,
        [v.nombre, String(req.body?.descripcion || '').slice(0, 200) || null,
         JSON.stringify(DISENO_NUEVO()), req.usuario.id, req.usuario.id]);

      await auth.auditar(req.usuario.id, 'crear', 'flujo', r.insertId,
        `Creó el flujo ${v.nombre}`, req.ip);
      res.status(201).json({ ok: true, id: r.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un flujo con ese nombre' });
      next(e);
    }
  });

/* ═══════════ GUARDAR ═══════════ */

router.put('/flujos/:id', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const f = await bd.una('SELECT id, estado FROM flujo WHERE id = ?', [id]);
      if (!f) return res.status(404).json({ error: 'Ese flujo no existe' });

      const v = nombreValido(req.body?.nombre);
      if (v.error) return res.status(400).json({ error: v.error });

      const diseno = revisarDiseno(req.body?.diseno);
      if (typeof diseno === 'string') return res.status(400).json({ error: diseno });

      const pendientes = Math.max(0, Math.min(999, Number(req.body?.pendientes) || 0));

      /* Un flujo activo está atendiendo llamadas: no puede quedar a medias */
      if (f.estado === 'activo') {
        const r = await central.revisar(diseno);
        if (r.errores.length) {
          return res.status(409).json({
            error: 'Este flujo está activo y quedaría incompleto. Corrige esto o desactívalo antes: ' +
                   r.errores.slice(0, 3).join(' · '), errores: r.errores });
        }
      }

      const anterior = await bd.una('SELECT diseno FROM flujo WHERE id = ?', [id]);
      await bd.consultar(
        `UPDATE flujo SET nombre = ?, descripcion = ?, diseno = ?, pendientes = ?, modificado_por = ?
          WHERE id = ?`,
        [v.nombre, String(req.body?.descripcion || '').slice(0, 200) || null,
         JSON.stringify(diseno), pendientes, req.usuario.id, id]);

      if (f.estado === 'activo') {
        try {
          await central.publicar();
        } catch (e) {
          /* La central no lo aceptó: se devuelve el diseño anterior */
          await bd.consultar('UPDATE flujo SET diseno = ? WHERE id = ?', [anterior.diseno, id]);
          return res.status(502).json({ error: e.message });
        }
      }

      await auth.auditar(req.usuario.id, 'modificar', 'flujo', id,
        `Guardó el flujo ${v.nombre} (${diseno.nodos.length} bloques)`, req.ip);
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un flujo con ese nombre' });
      next(e);
    }
  });

/* ═══════════ DUPLICAR ═══════════
   Para hacer una variante sin tocar el original: el de fin de año
   partiendo del de todos los días, por ejemplo. */

router.post('/flujos/:id/duplicar', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const f = await bd.una('SELECT nombre, descripcion, diseno, pendientes FROM flujo WHERE id = ?',
        [Number(req.params.id)]);
      if (!f) return res.status(404).json({ error: 'Ese flujo no existe' });

      /* "Copia de X", y si ya existe, "Copia 2 de X"… */
      const existentes = new Set((await bd.consultar('SELECT nombre FROM flujo')).map((x) => x.nombre));
      let nombre = `Copia de ${f.nombre}`.slice(0, 80);
      for (let i = 2; existentes.has(nombre) && i < 100; i++) nombre = `Copia ${i} de ${f.nombre}`.slice(0, 80);

      const r = await bd.consultar(
        `INSERT INTO flujo (nombre, descripcion, diseno, pendientes, creado_por, modificado_por)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [nombre, f.descripcion, f.diseno, f.pendientes, req.usuario.id, req.usuario.id]);

      await auth.auditar(req.usuario.id, 'crear', 'flujo', r.insertId,
        `Duplicó el flujo ${f.nombre} como ${nombre}`, req.ip);
      res.status(201).json({ ok: true, id: r.insertId, nombre });
    } catch (e) { next(e); }
  });

/* ═══════════ ELIMINAR ═══════════
   Solo los borradores. Uno activo estará recibiendo llamadas (fase 2):
   primero hay que desactivarlo. */

router.delete('/flujos/:id', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const f = await bd.una('SELECT nombre, estado FROM flujo WHERE id = ?', [id]);
      if (!f) return res.status(404).json({ error: 'Ese flujo no existe' });
      if (f.estado === 'activo') {
        return res.status(409).json({ error: 'Este flujo está activo. Desactívalo antes de eliminarlo.' });
      }

      await bd.consultar('DELETE FROM flujo WHERE id = ?', [id]);
      await auth.auditar(req.usuario.id, 'eliminar', 'flujo', id, `Eliminó el flujo ${f.nombre}`, req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* ═══════════ ACTIVAR Y DESACTIVAR ═══════════
   Activar: se revisa contra lo que existe de verdad, se traduce y se
   recarga la central. Si algo falla, el flujo queda como estaba.      */

router.post('/flujos/:id/activar', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const f = await bd.una('SELECT nombre, diseno, estado FROM flujo WHERE id = ?', [id]);
      if (!f) return res.status(404).json({ error: 'Ese flujo no existe' });

      const r = await central.revisar(leerDiseno(f.diseno));
      if (r.errores.length) {
        return res.status(400).json({ error: 'Todavía no se puede activar', errores: r.errores });
      }

      await bd.consultar("UPDATE flujo SET estado = 'activo' WHERE id = ?", [id]);
      try {
        await central.publicar();
      } catch (e) {
        await bd.consultar('UPDATE flujo SET estado = ? WHERE id = ?', [f.estado, id]);
        return res.status(502).json({ error: e.message });
      }

      await auth.auditar(req.usuario.id, 'modificar', 'flujo', id, `Activó el flujo ${f.nombre}`, req.ip);
      res.json({ ok: true, prueba: `${central.PREFIJO_PRUEBA}${id}` });
    } catch (e) { next(e); }
  });

router.post('/flujos/:id/desactivar', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const f = await bd.una('SELECT nombre, estado FROM flujo WHERE id = ?', [id]);
      if (!f) return res.status(404).json({ error: 'Ese flujo no existe' });

      const usan = await bd.consultar('SELECT numero FROM flujo_numero WHERE flujo_id = ?', [id]);
      if (usan.length) {
        const lista = usan.map((x) => (x.numero === '*' ? 'los números sin asignar' : x.numero)).join(', ');
        return res.status(409).json({
          error: `Este flujo atiende ${lista}. Asígnales otro flujo antes de desactivarlo.` });
      }

      await bd.consultar("UPDATE flujo SET estado = 'borrador' WHERE id = ?", [id]);
      try {
        await central.publicar();
      } catch (e) {
        await bd.consultar("UPDATE flujo SET estado = 'activo' WHERE id = ?", [id]);
        return res.status(502).json({ error: e.message });
      }

      await auth.auditar(req.usuario.id, 'modificar', 'flujo', id, `Desactivó el flujo ${f.nombre}`, req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

module.exports = router;