/* ═══════════════════════════════════════════════════════════════════
   FORMULARIOS

   Los diseña el administrador y los llenan los agentes durante la
   llamada. Viven en la base de datos, no en el navegador: así el
   administrador puede trabajar desde cualquier equipo y las respuestas
   quedan disponibles para los reportes.

   CAMPOS FIJOS
   Todo formulario nace con los diez datos del contacto. No se pueden
   borrar ni renombrar, y el agente los llena en cada gestión. Se
   guardan con la respuesta, así que cada llamada conserva los datos tal
   como estaban en ese momento: si el cliente cambia de teléfono, la
   gestión anterior mantiene el que se usó entonces.

   UBICACIONES
   País, departamento y ciudad salen del catálogo. Para Colombia, la
   ciudad depende del departamento elegido. Para otros países se
   escriben a mano, porque no tenemos sus divisiones cargadas.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

/* ═══════════ LOS DIEZ CAMPOS DEL CONTACTO ═══════════ */

const CAMPOS_FIJOS = [
  { clave: 'nombre_contacto', etiqueta: 'Nombre del contacto', tipo: 'texto',
    requerido: true,  ayuda: 'Nombre completo de quien está en la llamada' },
  { clave: 'telefono_1',      etiqueta: 'Teléfono 1',          tipo: 'telefono',
    requerido: true,  ayuda: 'Celular de 10 dígitos o fijo con indicativo' },
  { clave: 'telefono_2',      etiqueta: 'Teléfono 2',          tipo: 'telefono',
    requerido: false, ayuda: 'Opcional' },
  { clave: 'correo',          etiqueta: 'Correo',              tipo: 'correo',
    requerido: false, ayuda: '' },
  { clave: 'tipo_documento',  etiqueta: 'Tipo de documento',   tipo: 'lista',
    requerido: true,  opciones: 'CC,CE,TI,NIT,PA,PPT,RC', ayuda: '' },
  { clave: 'numero_documento', etiqueta: 'Número de documento', tipo: 'texto',
    requerido: true,  ayuda: 'Sin puntos ni espacios' },
  { clave: 'direccion',       etiqueta: 'Dirección',           tipo: 'texto',
    requerido: false, ayuda: '' },
  { clave: 'pais',            etiqueta: 'País',                tipo: 'pais',
    requerido: true,  ayuda: '' },
  { clave: 'departamento',    etiqueta: 'Departamento',        tipo: 'departamento',
    requerido: false, ayuda: 'Se despliega al elegir Colombia' },
  { clave: 'ciudad',          etiqueta: 'Ciudad',              tipo: 'ciudad',
    requerido: true,  ayuda: 'En Colombia depende del departamento' },
];

/** Inserta los campos fijos en un formulario recién creado. */
async function crearCamposFijos(cx, formularioId) {
  for (let i = 0; i < CAMPOS_FIJOS.length; i++) {
    const c = CAMPOS_FIJOS[i];
    await cx.execute(
      `INSERT INTO formulario_campo
         (formulario_id, clave, etiqueta, tipo, opciones, requerido, fijo, orden, ayuda)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?)`,
      [formularioId, c.clave, c.etiqueta, c.tipo, c.opciones || null,
       !!c.requerido, i, c.ayuda || null]
    );
  }
}

/* ═══════════ CATÁLOGO DE UBICACIONES ═══════════ */

router.get('/ubicaciones/paises', auth.exigirSesion, async (req, res, next) => {
  try {
    res.json(await bd.consultar(
      'SELECT codigo, nombre, tiene_divisiones FROM pais ORDER BY orden, nombre'));
  } catch (e) { next(e); }
});

router.get('/ubicaciones/departamentos', auth.exigirSesion, async (req, res, next) => {
  try {
    res.json(await bd.consultar(
      'SELECT codigo, nombre FROM departamento WHERE pais_codigo = ? ORDER BY nombre',
      [req.query.pais || 'CO']));
  } catch (e) { next(e); }
});

router.get('/ubicaciones/municipios', auth.exigirSesion, async (req, res, next) => {
  try {
    const dep = req.query.departamento;
    if (!dep) return res.status(400).json({ error: 'Falta el departamento' });
    res.json(await bd.consultar(
      'SELECT codigo, nombre FROM municipio WHERE departamento_codigo = ? ORDER BY nombre',
      [dep]));
  } catch (e) { next(e); }
});

/* ═══════════ LISTAR Y LEER ═══════════ */

/* Cualquier usuario con sesión puede listarlos: el agente necesita
   saber cuál le corresponde a su campaña. */
router.get('/formularios', auth.exigirSesion, async (req, res, next) => {
  try {
    const cond = ['f.activo = TRUE'];
    const val = [];
    if (req.query.campana) {
      cond.push('(f.campana_id = ? OR f.campana_id IS NULL)');
      val.push(Number(req.query.campana));
    }
    res.json(await bd.consultar(
      `SELECT f.id, f.nombre, f.campana_id, c.nombre AS campana, f.creado,
              (SELECT COUNT(*) FROM formulario_campo fc WHERE fc.formulario_id = f.id) AS campos
         FROM formulario f
         LEFT JOIN campana c ON c.id = f.campana_id
        WHERE ${cond.join(' AND ')}
        ORDER BY f.nombre`, val));
  } catch (e) { next(e); }
});

router.get('/formularios/:id', auth.exigirSesion, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const f = await bd.una(
      `SELECT f.id, f.nombre, f.campana_id, c.nombre AS campana, f.activo
         FROM formulario f LEFT JOIN campana c ON c.id = f.campana_id
        WHERE f.id = ?`, [id]);
    if (!f) return res.status(404).json({ error: 'El formulario no existe' });

    f.campos = await bd.consultar(
      `SELECT id, clave, etiqueta, tipo, opciones, requerido, fijo, orden, ayuda
         FROM formulario_campo WHERE formulario_id = ? ORDER BY orden, id`, [id]);
    f.campos.forEach((c) => {
      c.requerido = !!c.requerido;
      c.fijo = !!c.fijo;
      c.opciones = c.opciones ? c.opciones.split(',').map((o) => o.trim()) : [];
    });
    res.json(f);
  } catch (e) { next(e); }
});

/* ═══════════ CREAR, MODIFICAR Y DESACTIVAR ═══════════ */

router.post('/formularios', auth.exigirSesion, auth.exigir('disenar_formularios'),
  async (req, res, next) => {
    try {
      const nombre = String(req.body.nombre || '').trim();
      if (nombre.length < 3) {
        return res.status(400).json({ error: 'El formulario necesita un nombre' });
      }

      const r = await bd.transaccion(async (cx) => {
        const [ins] = await cx.execute(
          'INSERT INTO formulario (nombre, campana_id, creado_por) VALUES (?, ?, ?)',
          [nombre, req.body.campana_id || null, req.usuario.id]);
        await crearCamposFijos(cx, ins.insertId);
        return { id: ins.insertId };
      });

      await auth.auditar(req.usuario.id, 'crear', 'formulario', r.id,
        `Creó el formulario ${nombre}`, req.ip);
      res.status(201).json({ id: r.id, campos: CAMPOS_FIJOS.length });
    } catch (e) { next(e); }
  });

/* Cambia el nombre, la campaña y los campos AÑADIDOS. Los campos fijos
   no se tocan: llegan o no llegan, se conservan igual. */
router.put('/formularios/:id', auth.exigirSesion, auth.exigir('disenar_formularios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const f = await bd.una('SELECT nombre FROM formulario WHERE id = ?', [id]);
      if (!f) return res.status(404).json({ error: 'El formulario no existe' });

      const { nombre, campana_id, campos } = req.body;

      await bd.transaccion(async (cx) => {
        if (nombre !== undefined || campana_id !== undefined) {
          await cx.execute(
            'UPDATE formulario SET nombre = COALESCE(?, nombre), campana_id = ? WHERE id = ?',
            [nombre ? String(nombre).trim() : null, campana_id || null, id]);
        }

        if (Array.isArray(campos)) {
          /* Se reemplazan solo los campos propios del formulario. Los
             fijos quedan intactos: son obligatorios por definición. */
          await cx.execute(
            'DELETE FROM formulario_campo WHERE formulario_id = ? AND fijo = FALSE', [id]);

          const [[{ tope }]] = await cx.execute(
            'SELECT IFNULL(MAX(orden), 0) AS tope FROM formulario_campo WHERE formulario_id = ?',
            [id]);

          for (let i = 0; i < campos.length; i++) {
            const c = campos[i];
            const etiqueta = String(c.etiqueta || '').trim();
            if (!etiqueta) continue;
            await cx.execute(
              `INSERT INTO formulario_campo
                 (formulario_id, clave, etiqueta, tipo, opciones, requerido, fijo, orden, ayuda)
               VALUES (?, NULL, ?, ?, ?, ?, FALSE, ?, ?)`,
              [id, etiqueta.slice(0, 120), c.tipo || 'texto',
               Array.isArray(c.opciones) ? c.opciones.join(',') : (c.opciones || null),
               !!c.requerido, tope + 1 + i, (c.ayuda || '').slice(0, 160) || null]);
          }
        }
      });

      await auth.auditar(req.usuario.id, 'modificar', 'formulario', id,
        `Modificó el formulario ${f.nombre}`, req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* No se elimina: las respuestas ya guardadas deben conservarse. */
router.delete('/formularios/:id', auth.exigirSesion, auth.exigir('disenar_formularios'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const f = await bd.una('SELECT nombre FROM formulario WHERE id = ?', [id]);
      if (!f) return res.status(404).json({ error: 'El formulario no existe' });

      await bd.consultar('UPDATE formulario SET activo = FALSE WHERE id = ?', [id]);
      await auth.auditar(req.usuario.id, 'eliminar', 'formulario', id,
        `Desactivó el formulario ${f.nombre}`, req.ip);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

/* ═══════════ RESPUESTAS ═══════════ */

const SOLO_DIGITOS = /^[0-9]{7,15}$/;
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Comprueba el valor contra el tipo del campo. Devuelve el texto del
    error, o null si está bien. Lo mismo que valida la pantalla, pero
    aquí es donde cuenta: el navegador se puede saltar. */
function revisar(campo, valor) {
  const v = String(valor ?? '').trim();

  if (campo.requerido && !v) return `${campo.etiqueta} es obligatorio`;
  if (!v) return null;

  if (campo.tipo === 'telefono' && !SOLO_DIGITOS.test(v.replace(/[\s()-]/g, ''))) {
    return `${campo.etiqueta} debe ser un número de 7 a 15 dígitos`;
  }
  if (campo.tipo === 'correo' && !CORREO.test(v)) {
    return `${campo.etiqueta} no parece un correo válido`;
  }
  if (campo.tipo === 'numero' && isNaN(Number(v))) {
    return `${campo.etiqueta} debe ser un número`;
  }
  if (campo.tipo === 'lista' && campo.opciones) {
    const ops = campo.opciones.split(',').map((o) => o.trim());
    if (!ops.includes(v)) return `${campo.etiqueta}: "${v}" no está entre las opciones`;
  }
  if (v.length > 2000) return `${campo.etiqueta} es demasiado largo`;
  return null;
}

router.post('/formularios/:id/respuestas', auth.exigirSesion, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const valores = req.body.valores || {};

    const campos = await bd.consultar(
      'SELECT id, clave, etiqueta, tipo, opciones, requerido FROM formulario_campo WHERE formulario_id = ?',
      [id]);
    if (!campos.length) return res.status(404).json({ error: 'El formulario no existe' });

    /* Se valida todo antes de guardar nada: o entra completa o no entra. */
    const errores = [];
    campos.forEach((c) => {
      const e = revisar(c, valores[c.id] ?? valores[c.clave]);
      if (e) errores.push(e);
    });
    if (errores.length) return res.status(400).json({ error: errores[0], errores });

    const creada = req.body.creada ? new Date(req.body.creada) : new Date();

    const r = await bd.transaccion(async (cx) => {
      const [ins] = await cx.execute(
        `INSERT INTO formulario_respuesta
           (formulario_id, usuario_id, numero, creada)
         VALUES (?, ?, ?, ?)`,
        [id, req.usuario.id, (req.body.numero || '').slice(0, 30) || null,
         isNaN(creada) ? new Date() : creada]);

      for (const c of campos) {
        const v = valores[c.id] ?? valores[c.clave];
        if (v === undefined || v === null || String(v).trim() === '') continue;
        await cx.execute(
          'INSERT INTO formulario_valor (respuesta_id, campo_id, valor) VALUES (?, ?, ?)',
          [ins.insertId, c.id, String(v).trim()]);
      }
      return { id: ins.insertId };
    });

    res.status(201).json({ ok: true, id: r.id });
  } catch (e) { next(e); }
});

/* Respuestas guardadas, para consulta y reportes. */
router.get('/formularios/:id/respuestas', auth.exigirSesion, auth.exigir('reportes'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const filas = await bd.consultar(
        `SELECT r.id, r.creada, r.numero, u.nombre AS agente,
                fc.clave, fc.etiqueta, v.valor
           FROM formulario_respuesta r
           LEFT JOIN usuario u ON u.id = r.usuario_id
           LEFT JOIN formulario_valor v ON v.respuesta_id = r.id
           LEFT JOIN formulario_campo fc ON fc.id = v.campo_id
          WHERE r.formulario_id = ?
          ORDER BY r.creada DESC, fc.orden
          LIMIT 5000`, [id]);

      /* Las filas vienen por valor; se agrupan por respuesta. */
      const mapa = new Map();
      filas.forEach((f) => {
        if (!mapa.has(f.id)) {
          mapa.set(f.id, { id: f.id, creada: f.creada, numero: f.numero,
                           agente: f.agente || '—', valores: {} });
        }
        if (f.etiqueta) mapa.get(f.id).valores[f.clave || f.etiqueta] = f.valor;
      });

      res.json({ total: mapa.size, respuestas: [...mapa.values()] });
    } catch (e) { next(e); }
  });

module.exports = router;
