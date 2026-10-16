/* ═══════════════════════════════════════════════════════════════════
   BLASTER DE VOZ

   Llamar a una lista de personas y reproducir un mensaje, con o sin
   respuesta del cliente.

   QUÉ HACE ESTE ARCHIVO
   Prepara todo: el mensaje, la lista, las variables de cada persona,
   el audio y la configuración de la respuesta. Guarda también lo que
   el cliente marque.

   QUÉ NO HACE TODAVÍA
   Marcar. Para originar llamadas hace falta el canal de control con
   Asterisk, que es la misma pieza pendiente para la escucha en vivo.
   Mientras tanto un blaster se deja "aprobado" y espera.

   POR QUÉ SE APRUEBA APARTE
   Lanzar un blaster son cientos de llamadas en nombre de la empresa y
   no se puede deshacer. El supervisor lo prepara; el administrador lo
   aprueba. Queda registrado quién hizo cada cosa.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');
const voz = require('../voz');

const router = express.Router();

/** El mensaje completo que se convierte en voz: el guion y, si se pide
    respuesta, la pregunta al final. Van en el mismo audio y con la misma
    voz: si fueran dos audios separados se notaría el corte.

    Con audio grabado no se usa: ahí la pregunta va dentro de la
    grabación. */
function conPregunta(b, texto) {
  const pregunta = String(b.respuesta_guion || '').trim();
  return b.respuesta && pregunta ? `${texto} ${pregunta}` : texto;
}

/**
 * Qué significa cada tecla, limpio y listo para guardar.
 *
 * Solo se guardan las de las teclas que se ofrecen: si alguien marca la
 * 3 y después la desmarca, su etiqueta no debe quedar colgada. Y cada
 * una se recorta, porque es texto libre que acaba en un reporte.
 */
function etiquetasLimpias(b) {
  if (!b.respuesta || b.respuesta_tipo !== 'tecla') return null;

  let crudo = b.respuesta_etiquetas;
  if (typeof crudo === 'string') {
    try { crudo = JSON.parse(crudo); } catch { crudo = {}; }
  }
  if (!crudo || typeof crudo !== 'object') return null;

  const ofrecidas = String(b.respuesta_opciones || '').split(',').map((t) => t.trim());
  const limpio = {};
  for (const tecla of ofrecidas) {
    const texto = String(crudo[tecla] || '').trim().slice(0, 60);
    if (texto) limpio[tecla] = texto;
  }
  return Object.keys(limpio).length ? JSON.stringify(limpio) : null;
}

/* ═══════════ A QUÉ CAMPAÑAS ALCANZA CADA QUIEN ═══════════
   El administrador, a todas. El supervisor, solo a las suyas. */
async function campanasDe(usuario) {
  if (usuario.rol === 'admin') return null;

  const filas = await bd.consultar(
    'SELECT campana_id FROM usuario_campana WHERE usuario_id = ?', [usuario.id]);
  const ids = filas.map((f) => f.campana_id);

  if (!ids.length) {
    const yo = await bd.una('SELECT campana_id FROM usuario WHERE id = ?', [usuario.id]);
    if (yo?.campana_id) ids.push(yo.campana_id);
  }
  return ids;
}

/** Devuelve el motivo del rechazo, o null si puede. */
async function puedeCon(usuario, campanaId) {
  const mias = await campanasDe(usuario);
  if (mias === null) return null;
  if (!mias.length) return 'No tienes campañas asignadas. Pídeselas al administrador.';
  if (!mias.includes(Number(campanaId))) return 'Esa campaña no está a tu cargo.';
  return null;
}

/* ═══════════ VARIABLES DEL MENSAJE ═══════════ */

/** Las variables que usa una plantilla: "Hola {nombre}" → ['nombre'] */
const variablesDe = (texto) =>
  [...new Set([...String(texto || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];

/** Reemplaza las variables con los datos de la persona. Lo que no
    tenga valor se deja marcado para que se vea en la revisión. */
function armarTexto(plantilla, datos = {}) {
  const faltan = [];
  const texto = String(plantilla || '').replace(/\{(\w+)\}/g, (_, v) => {
    const valor = datos[v];
    if (valor === undefined || valor === null || String(valor).trim() === '') {
      faltan.push(v);
      return `{${v}}`;
    }
    return String(valor).trim();
  });
  return { texto, faltan: [...new Set(faltan)] };
}

/* ═══════════ LISTAR Y LEER ═══════════ */

router.get('/blasters', auth.exigirSesion, auth.exigir('blaster'), async (req, res, next) => {
  try {
    const mias = await campanasDe(req.usuario);

    let sql = `SELECT b.id, b.nombre, b.tipo, b.estado, b.campana_id, c.nombre AS campana,
                      b.respuesta, b.creado,
                      (SELECT COUNT(*) FROM blaster_destinatario d WHERE d.blaster_id = b.id) AS destinos,
                      (SELECT COUNT(*) FROM blaster_destinatario d
                        WHERE d.blaster_id = b.id AND d.estado = 'contestada') AS contestadas,
                      (SELECT COUNT(*) FROM blaster_respuesta r WHERE r.blaster_id = b.id) AS respuestas
                 FROM blaster b
                 JOIN campana c ON c.id = b.campana_id`;
    const val = [];

    /* Los cancelados no se muestran: al eliminarlos, la persona espera
       que desaparezcan. Siguen en la base si ya llamaron a alguien, para
       que el historial no se pierda, pero no estorban en la lista. */
    const cond = ["b.estado <> 'cancelado'"];

    if (mias !== null) {
      if (!mias.length) return res.json([]);
      cond.push(`b.campana_id IN (${mias.map(() => '?').join(',')})`);
      val.push(...mias);
    }
    sql += ' WHERE ' + cond.join(' AND ') + ' ORDER BY b.creado DESC';

    res.json(await bd.consultar(sql, val));
  } catch (e) { next(e); }
});

router.get('/blasters/:id', auth.exigirSesion, auth.exigir('blaster'), async (req, res, next) => {
  try {
    const b = await bd.una(
      `SELECT b.*, c.nombre AS campana, u.nombre AS creador
         FROM blaster b
         JOIN campana c ON c.id = b.campana_id
         LEFT JOIN usuario u ON u.id = b.creado_por
        WHERE b.id = ?`, [Number(req.params.id)]);
    if (!b) return res.status(404).json({ error: 'El blaster no existe' });

    const no = await puedeCon(req.usuario, b.campana_id);
    if (no) return res.status(403).json({ error: no });

    b.variables = variablesDe(b.guion);
    b.resumen = await bd.una(
      `SELECT COUNT(*) AS total,
              SUM(estado = 'pendiente')  AS pendientes,
              SUM(estado = 'contestada') AS contestadas,
              SUM(estado IN ('no_contesta','buzon','ocupado','fallida')) AS sin_exito
         FROM blaster_destinatario WHERE blaster_id = ?`, [b.id]);

    res.json(b);
  } catch (e) { next(e); }
});

/* ═══════════ CREAR Y MODIFICAR ═══════════ */

function revisarConfiguracion(b) {
  if (!b.nombre || String(b.nombre).trim().length < 3) return 'El blaster necesita un nombre';
  if (!b.campana_id) return 'Falta la campaña';

  if (b.tipo === 'audio') {
    if (!b.audio_archivo) return 'Falta el audio grabado';
  } else {
    if (!b.guion || String(b.guion).trim().length < 10) {
      return 'El mensaje es demasiado corto';
    }
    if (b.tipo === 'texto' && variablesDe(b.guion).length) {
      return 'Ese mensaje tiene variables: elige el tipo "texto con variables"';
    }
    if (b.tipo === 'variables' && !variablesDe(b.guion).length) {
      return 'El mensaje no tiene ninguna variable entre llaves, como {nombre}';
    }
  }

  if (b.respuesta) {
    /* La pregunta escrita solo hace falta con voz sintética: se añade al
       final del mensaje. Con audio grabado, la pregunta va dentro de la
       propia grabación, y la pantalla ni siquiera muestra el campo.
       Antes se exigía siempre, y un blaster de audio grabado con
       respuesta no se podía guardar. */
    if (b.tipo !== 'audio' &&
        (!b.respuesta_guion || String(b.respuesta_guion).trim().length < 5)) {
      return 'Falta lo que se le dice al cliente para pedirle la respuesta';
    }
    if (b.respuesta_tipo === 'tecla') {
      const teclas = String(b.respuesta_opciones || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!teclas.length) return 'Indica qué teclas puede marcar el cliente';
      if (teclas.some((t) => !/^[0-9*#]$/.test(t))) {
        return 'Las teclas solo pueden ser dígitos, * o #';
      }
    } else {
      const d = Number(b.respuesta_digitos);
      if (!d || d < 1 || d > 20) return 'La cantidad de dígitos debe estar entre 1 y 20';
    }
  }
  return null;
}

router.post('/blasters', auth.exigirSesion, auth.exigir('blaster'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const error = revisarConfiguracion(b);
    if (error) return res.status(400).json({ error });

    const no = await puedeCon(req.usuario, b.campana_id);
    if (no) return res.status(403).json({ error: no });

    const [r] = await bd.pool.execute(
      `INSERT INTO blaster
         (nombre, campana_id, tipo, guion, audio_archivo, voz_id,
          respuesta, respuesta_tipo, respuesta_guion, respuesta_opciones,
          respuesta_etiquetas, respuesta_digitos,
          hora_inicio, hora_fin, dias, reintentos, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(b.nombre).trim(), b.campana_id, b.tipo || 'texto',
       b.guion || null, b.audio_archivo || null, b.voz_id || null,
       !!b.respuesta, b.respuesta_tipo || 'tecla',
       b.tipo === 'audio' ? null : (b.respuesta_guion || null),
       b.respuesta_opciones || null, etiquetasLimpias(b), b.respuesta_digitos || 10,
       b.hora_inicio || '08:00:00', b.hora_fin || '18:00:00',
       b.dias || 'L,M,X,J,V', b.reintentos ?? 2, req.usuario.id]);

    await auth.auditar(req.usuario.id, 'crear', 'blaster', r.insertId,
      `Creó el blaster "${b.nombre}"`, req.ip);

    res.status(201).json({ id: r.insertId, variables: variablesDe(b.guion) });
  } catch (e) { next(e); }
});

router.put('/blasters/:id', auth.exigirSesion, auth.exigir('blaster'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const antes = await bd.una('SELECT * FROM blaster WHERE id = ?', [id]);
    if (!antes) return res.status(404).json({ error: 'El blaster no existe' });

    const no = await puedeCon(req.usuario, antes.campana_id);
    if (no) return res.status(403).json({ error: no });

    /* En curso no se toca: cambiar el mensaje a mitad de las llamadas
       dejaría a unos clientes con un mensaje y a otros con otro. */
    if (['activo', 'terminado'].includes(antes.estado)) {
      return res.status(409).json({
        error: `Un blaster ${antes.estado === 'activo' ? 'en curso' : 'terminado'} no se modifica. Pásalo a pausado o crea uno nuevo.` });
    }

    const b = { ...antes, ...req.body, campana_id: antes.campana_id };
    const error = revisarConfiguracion(b);
    if (error) return res.status(400).json({ error });

    await bd.consultar(
      `UPDATE blaster SET nombre = ?, tipo = ?, guion = ?, audio_archivo = ?, voz_id = ?,
              respuesta = ?, respuesta_tipo = ?, respuesta_guion = ?,
              respuesta_opciones = ?, respuesta_etiquetas = ?, respuesta_digitos = ?,
              hora_inicio = ?, hora_fin = ?, dias = ?, reintentos = ?,
              estado = 'borrador'
        WHERE id = ?`,
      [String(b.nombre).trim(), b.tipo, b.guion || null, b.audio_archivo || null, b.voz_id || null,
       !!b.respuesta, b.respuesta_tipo || 'tecla',
       b.tipo === 'audio' ? null : (b.respuesta_guion || null),
       b.respuesta_opciones || null, etiquetasLimpias(b), b.respuesta_digitos || 10,
       b.hora_inicio, b.hora_fin, b.dias, b.reintentos, id]);

    await auth.auditar(req.usuario.id, 'modificar', 'blaster', id,
      `Modificó el blaster "${b.nombre}"`, req.ip);

    /* Al cambiarlo vuelve a borrador: hay que aprobarlo de nuevo */
    res.json({ ok: true, estado: 'borrador' });
  } catch (e) { next(e); }
});

router.delete('/blasters/:id', auth.exigirSesion, auth.exigir('blaster'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = await bd.una('SELECT nombre, campana_id, estado FROM blaster WHERE id = ?', [id]);
    if (!b) return res.status(404).json({ error: 'El blaster no existe' });

    const no = await puedeCon(req.usuario, b.campana_id);
    if (no) return res.status(403).json({ error: no });

    if (b.estado === 'activo') {
      return res.status(409).json({ error: 'Pausa el blaster antes de cancelarlo' });
    }

    /* Si nunca llamó a nadie, no hay historial que proteger: se borra
       de verdad, con sus destinatarios. Si ya llamó, se cancela y se
       conserva, porque esas llamadas existieron y pueden consultarse. */
    const llamo = await bd.una(
      `SELECT COUNT(*) AS n FROM blaster_destinatario
        WHERE blaster_id = ? AND (intentos > 0 OR estado <> 'pendiente')`, [id]);

    if (!Number(llamo.n)) {
      await bd.transaccion(async (cx) => {
        await cx.execute('DELETE FROM blaster_respuesta WHERE blaster_id = ?', [id]);
        await cx.execute('DELETE FROM blaster_destinatario WHERE blaster_id = ?', [id]);
        await cx.execute('DELETE FROM blaster WHERE id = ?', [id]);
      });
      await auth.auditar(req.usuario.id, 'eliminar', 'blaster', id,
        `Eliminó el blaster "${b.nombre}" (nunca había llamado)`, req.ip);
      return res.json({ ok: true, eliminado: true });
    }

    await bd.consultar("UPDATE blaster SET estado = 'cancelado' WHERE id = ?", [id]);
    await auth.auditar(req.usuario.id, 'eliminar', 'blaster', id,
      `Canceló el blaster "${b.nombre}" (se conserva su historial)`, req.ip);

    res.json({ ok: true, eliminado: false });
  } catch (e) { next(e); }
});

/* ═══════════ DESTINATARIOS ═══════════ */

const NUMERO = /^(\+?57)?[0-9]{7,12}$/;

router.post('/blasters/:id/destinos', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT campana_id, estado, tipo, guion FROM blaster WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'El blaster no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      if (b.estado === 'activo') {
        return res.status(409).json({ error: 'Pausa el blaster antes de cambiar su lista' });
      }

      const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
      const soloRevisar = req.body.revisar !== false;

      if (!filas.length) return res.status(400).json({ error: 'El archivo no trae filas' });
      if (filas.length > 5000) {
        return res.status(400).json({ error: 'Máximo 5.000 destinatarios por archivo' });
      }

      const necesarias = b.tipo === 'variables' ? variablesDe(b.guion) : [];
      const vistos = new Set();

      const revisadas = filas.map((f, i) => {
        const errores = [];
        const numero = String(f.numero || f.telefono || '').replace(/[\s()-]/g, '');
        const nombre = String(f.nombre || '').trim();

        if (!NUMERO.test(numero)) errores.push('Número no válido');
        if (vistos.has(numero)) errores.push('Número repetido en el archivo');
        vistos.add(numero);

        /* Las variables del mensaje salen de las columnas del archivo */
        /* Las variables pueden llegar como columnas sueltas del archivo
           o dentro de un objeto `datos`. Se aceptan las dos formas. */
        const datos = {};
        Object.keys(f).forEach((k) => {
          const clave = k.trim().toLowerCase();
          if (['numero', 'telefono', 'datos'].includes(clave)) return;
          datos[clave] = f[k];
        });
        if (f.datos && typeof f.datos === 'object') {
          Object.entries(f.datos).forEach(([k, v]) => { datos[k.trim().toLowerCase()] = v; });
        }
        if (nombre && !datos.nombre) datos.nombre = nombre;

        const faltan = necesarias.filter((v) =>
          datos[v] === undefined || String(datos[v]).trim() === '');
        if (faltan.length) errores.push(`Sin datos para: ${faltan.join(', ')}`);

        return { linea: i + 2, numero, nombre, datos, errores };
      });

      const validas = revisadas.filter((r) => !r.errores.length);

      if (soloRevisar) {
        /* Se muestra cómo quedará el mensaje de los primeros, para que
           se revise antes de llamar a nadie. */
        const muestra = validas.slice(0, 3).map((r) => ({
          numero: r.numero,
          mensaje: b.tipo === 'audio' ? '(audio grabado)' : armarTexto(b.guion, r.datos).texto,
        }));

        return res.json({
          revisado: true,
          total: revisadas.length,
          correctas: validas.length,
          conError: revisadas.length - validas.length,
          variables: necesarias,
          muestra,
          filas: revisadas.map(({ linea, numero, nombre, errores }) =>
            ({ linea, numero, nombre, errores })),
        });
      }

      /* Se reemplaza la lista completa */
      await bd.transaccion(async (cx) => {
        await cx.execute('DELETE FROM blaster_destinatario WHERE blaster_id = ?', [id]);
        for (const r of validas) {
          await cx.execute(
            'INSERT INTO blaster_destinatario (blaster_id, numero, nombre, datos) VALUES (?, ?, ?, ?)',
            [id, r.numero, r.nombre || null, JSON.stringify(r.datos)]);
        }
      });

      await auth.auditar(req.usuario.id, 'modificar', 'blaster', id,
        `Cargó ${validas.length} destinatarios`, req.ip);

      res.json({ cargados: validas.length, omitidos: revisadas.length - validas.length });
    } catch (e) { next(e); }
  });

router.get('/blasters/:id/destinos', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT campana_id FROM blaster WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'El blaster no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      res.json(await bd.consultar(
        `SELECT id, numero, nombre, estado, intentos, ultimo_intento, proximo_intento,
                ultimo_motivo, segundos_escuchados
           FROM blaster_destinatario WHERE blaster_id = ? ORDER BY id LIMIT 2000`, [id]));
    } catch (e) { next(e); }
  });

/* ═══════════ AUDIO ═══════════

   Un tipo "texto" genera un audio y lo reutiliza para todos. Un tipo
   "variables" genera uno por persona, porque el mensaje cambia.
   Se hace antes de llamar: generar audio a mitad de la llamada haría
   esperar al cliente. */

router.post('/blasters/:id/audio', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT * FROM blaster WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'El blaster no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      if (b.tipo === 'audio') {
        return res.status(400).json({ error: 'Este blaster usa un audio grabado: no hay nada que generar' });
      }
      if (!voz.disponible()) {
        return res.status(503).json({
          error: 'No hay servicio de voz configurado. Revisa TTS_PROVEEDOR y TTS_CLAVE en el servidor.',
          proveedor: voz.proveedor(),
        });
      }

      /* Solo una muestra, para escuchar cómo suena antes de gastar */
      if (req.body.muestra) {
        const d = await bd.una(
          'SELECT datos FROM blaster_destinatario WHERE blaster_id = ? LIMIT 1', [id]);
        const datos = d?.datos ? (typeof d.datos === 'string' ? JSON.parse(d.datos) : d.datos) : {};
        const { texto: base } = armarTexto(b.guion, datos);
        const texto = conPregunta(b, base);
        const r = await voz.generar(texto, b.voz_id, `blaster-${id}-muestra`);
        if (r.error) return res.status(502).json({ error: r.error });

        /* El audio para escucharlo en la pantalla. Se guarda en formato
           telefónico, que el navegador no reproduce: se convierte solo
           para oírlo. */
        return res.json({ muestra: true, texto, archivo: r.archivo,
                          escuchar: await voz.paraEscuchar(r.archivo) });
      }

      if (b.tipo === 'texto') {
        const r = await voz.generar(conPregunta(b, b.guion), b.voz_id, `blaster-${id}`);
        if (r.error) return res.status(502).json({ error: r.error });

        await bd.consultar('UPDATE blaster SET audio_archivo = ? WHERE id = ?', [r.archivo, id]);
        return res.json({ generados: 1, archivo: r.archivo, texto: conPregunta(b, b.guion),
                          escuchar: await voz.paraEscuchar(r.archivo) });
      }

      /* Con variables: uno por persona */
      const destinos = await bd.consultar(
        'SELECT id, datos FROM blaster_destinatario WHERE blaster_id = ? AND audio_archivo IS NULL', [id]);

      let generados = 0;
      const fallidos = [];

      for (const d of destinos) {
        const datos = d.datos ? (typeof d.datos === 'string' ? JSON.parse(d.datos) : d.datos) : {};
        const { texto: base, faltan } = armarTexto(b.guion, datos);
        const texto = conPregunta(b, base);

        if (faltan.length) { fallidos.push({ id: d.id, error: 'Faltan datos: ' + faltan.join(', ') }); continue; }

        const r = await voz.generar(texto, b.voz_id, `blaster-${id}-${d.id}`);
        if (r.error) { fallidos.push({ id: d.id, error: r.error }); continue; }

        await bd.consultar('UPDATE blaster_destinatario SET audio_archivo = ? WHERE id = ?', [r.archivo, d.id]);
        generados++;
      }

      await auth.auditar(req.usuario.id, 'modificar', 'blaster', id,
        `Generó ${generados} audios`, req.ip);

      res.json({ generados, fallidos, pendientes: destinos.length - generados });
    } catch (e) { next(e); }
  });

/* ═══════════ APROBAR, PAUSAR, REANUDAR ═══════════ */

/* ═══════════ LANZAR, PAUSAR, CANCELAR ═══════════

   Lo hace el supervisor, sin esperar al administrador. La operación lo
   necesita así: quien prepara la campaña es quien sabe cuándo lanzarla.

   Lo que se mantiene es el alcance: un supervisor solo lanza los
   blasters de SUS campañas. Antes esto lo hacía solo el administrador
   y no hacía falta comprobarlo; ahora sí. */
router.put('/blasters/:id/estado', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT * FROM blaster WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'El blaster no existe' });

      const mias = await campanasDe(req.usuario);
      if (mias !== null && !mias.includes(b.campana_id)) {
        return res.status(403).json({ error: 'Ese blaster no es de tus campañas' });
      }

      const nuevo = String(req.body.estado || '');
      /* Los nombres deben coincidir con los que admite la base. Antes
         aquí decía "en_curso", la base solo acepta "activo" y la
         plataforma mandaba "activo": lanzar un blaster se rechazaba
         siempre. */
      const permitidos = ['aprobado', 'activo', 'pausado', 'terminado', 'cancelado'];
      if (!permitidos.includes(nuevo)) {
        return res.status(400).json({ error: 'Estado no válido' });
      }

      /* Antes de aprobar se comprueba que esté listo de verdad */
      if (nuevo === 'aprobado' || nuevo === 'activo') {
        const n = await bd.una(
          'SELECT COUNT(*) AS n FROM blaster_destinatario WHERE blaster_id = ?', [id]);
        if (!n.n) return res.status(400).json({ error: 'El blaster no tiene destinatarios' });

        if (b.tipo === 'audio' && !b.audio_archivo) {
          return res.status(400).json({ error: 'Falta el audio grabado' });
        }
        if (b.tipo === 'texto' && !b.audio_archivo) {
          return res.status(400).json({ error: 'Genera primero el audio del mensaje' });
        }
        if (b.tipo === 'variables') {
          const sin = await bd.una(
            'SELECT COUNT(*) AS n FROM blaster_destinatario WHERE blaster_id = ? AND audio_archivo IS NULL', [id]);
          if (sin.n) {
            return res.status(400).json({ error: `Faltan ${sin.n} audios por generar` });
          }
        }
      }

      /* Al aprobar se marca la casilla `aprobado`. Antes solo cambiaba
         el estado y la casilla seguía en falso, así que el motor —que
         exige las dos cosas— nunca habría tomado el blaster.

         Y la fecha de aprobación se conserva al pasar a activo:
         antes se le asignaba la casilla `aprobado`, un sí/no, y la
         base rechazaba la consulta con un error interno. */
      const aprobando = nuevo === 'aprobado' || nuevo === 'activo';

      /* "Aprobar y lanzar" pasa directo a activo, así que quién y cuándo
         aprobó se guarda también en ese caso. COALESCE conserva el dato
         original al reanudar un blaster pausado. */
      await bd.consultar(
        `UPDATE blaster SET estado = ?,
                aprobado     = CASE WHEN ? THEN TRUE ELSE aprobado END,
                aprobado_por = CASE WHEN ? THEN COALESCE(aprobado_por, ?) ELSE aprobado_por END,
                aprobado_en  = CASE WHEN ? THEN COALESCE(aprobado_en, NOW()) ELSE aprobado_en END
          WHERE id = ?`,
        [nuevo, aprobando, aprobando, req.usuario.id, aprobando, id]);

      await auth.auditar(req.usuario.id, 'modificar', 'blaster', id,
        `Pasó el blaster "${b.nombre}" a ${nuevo}`, req.ip);

      res.json({ ok: true, estado: nuevo });
    } catch (e) { next(e); }
  });

/* ═══════════ RESPUESTAS DEL CLIENTE ═══════════ */

router.get('/blasters/:id/respuestas', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT campana_id, respuesta_tipo FROM blaster WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'El blaster no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      const filas = await bd.consultar(
        `SELECT r.id, r.numero, r.valor AS respuesta, r.creada AS recibida, JSON_UNQUOTE(JSON_EXTRACT(d.datos, '$.nombre')) AS nombre
           FROM blaster_respuesta r
           LEFT JOIN blaster_destinatario d ON d.id = r.destinatario_id
          WHERE r.blaster_id = ?
          ORDER BY r.creada DESC
          LIMIT 5000`, [id]);

      /* Cuántos marcaron cada opción: es lo primero que se mira */
      const conteo = {};
      filas.forEach((f) => { conteo[f.respuesta] = (conteo[f.respuesta] || 0) + 1; });

      res.json({ total: filas.length, tipo: b.respuesta_tipo, conteo, respuestas: filas });
    } catch (e) { next(e); }
  });

/** La graba el proceso que atiende la llamada cuando el cliente marca.
    Se deja lista para cuando exista el canal con Asterisk. */
router.post('/blasters/:id/respuestas', auth.exigirSesion, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = await bd.una(
      'SELECT respuesta_tipo, respuesta_opciones, respuesta_digitos FROM blaster WHERE id = ?', [id]);
    if (!b) return res.status(404).json({ error: 'El blaster no existe' });

    const numero = String(req.body.numero || '').replace(/\D/g, '');
    const respuesta = String(req.body.respuesta || '').trim();

    if (!numero || !respuesta) return res.status(400).json({ error: 'Faltan el número y la respuesta' });

    /* Se comprueba contra lo configurado: si se pidió una tecla, no
       puede llegar un número de diez dígitos. */
    if (b.respuesta_tipo === 'tecla') {
      const teclas = String(b.respuesta_opciones || '').split(',').map((t) => t.trim());
      if (!teclas.includes(respuesta)) {
        return res.status(400).json({ error: `"${respuesta}" no está entre las teclas esperadas` });
      }
    } else if (respuesta.replace(/\D/g, '').length !== Number(b.respuesta_digitos)) {
      return res.status(400).json({
        error: `Se esperaban ${b.respuesta_digitos} dígitos y llegaron ${respuesta.replace(/\D/g, '').length}` });
    }

    const d = await bd.una(
      'SELECT id FROM blaster_destinatario WHERE blaster_id = ? AND numero = ? LIMIT 1', [id, numero]);

    const [r] = await bd.pool.execute(
      'INSERT INTO blaster_respuesta (blaster_id, destinatario_id, numero, valor) VALUES (?, ?, ?, ?)',
      [id, d?.id || null, numero, respuesta.slice(0, 40)]);

    res.status(201).json({ ok: true, id: r.insertId });
  } catch (e) { next(e); }
});

/** El estado del motor: si anda y qué fue lo último que hizo. Sirve
    para saber por qué un blaster no está llamando. */
router.get('/blaster/motor', auth.exigirSesion, auth.exigir('blaster'),
  (req, res) => res.json(require('../blaster-motor').estado()));

/* ═══════════ DEL BLASTER A UNA BASE DE MARCACIÓN ═══════════

   El blaster deja de ser solo un aviso y se vuelve la primera parte de
   una gestión: los que marcaron "1 · Quiere que lo llamen" pasan a una
   base de marcación, y un agente los llama.

   Se puede pasar cualquier grupo: los que marcaron una tecla, los que
   contestaron sin marcar, o los que no contestaron —para intentarlo
   con una persona en vez de una grabación—.                           */

/** Los grupos que se pueden pasar, con cuántos tiene cada uno. */
async function gruposDe(b) {
  let etiquetas = {};
  try { etiquetas = b.respuesta_etiquetas ? JSON.parse(b.respuesta_etiquetas) : {}; }
  catch { etiquetas = {}; }

  /* La última respuesta de cada persona: si marcó dos veces, vale la
     última. */
  const filas = await bd.consultar(
    `SELECT d.id, d.estado,
            (SELECT r.valor FROM blaster_respuesta r
              WHERE r.destinatario_id = d.id ORDER BY r.id DESC LIMIT 1) AS valor
       FROM blaster_destinatario d WHERE d.blaster_id = ?`, [b.id]);

  const grupos = new Map();
  const sumar = (clave, nombre, id) => {
    if (!grupos.has(clave)) grupos.set(clave, { clave, nombre, ids: [] });
    grupos.get(clave).ids.push(id);
  };

  filas.forEach((f) => {
    const valido = f.valor && !/^invalida:/.test(f.valor);

    if (valido && b.respuesta_tipo === 'tecla') {
      sumar(`tecla:${f.valor}`,
        etiquetas[f.valor] ? `Marcaron ${f.valor} · ${etiquetas[f.valor]}` : `Marcaron ${f.valor}`, f.id);
    } else if (valido) {
      sumar('respondio', 'Respondieron', f.id);
    } else if (f.estado === 'contestada') {
      sumar('sin_tecla', 'Contestaron pero no marcaron', f.id);
    } else if (['sin_respuesta', 'fallida', 'buzon'].includes(f.estado)) {
      sumar('no_contesto', 'No contestaron', f.id);
    }
  });

  return [...grupos.values()];
}

router.get('/blasters/:id/grupos', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const b = await bd.una('SELECT * FROM blaster WHERE id = ?', [Number(req.params.id)]);
      if (!b) return res.status(404).json({ error: 'El blaster no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      const grupos = await gruposDe(b);
      res.json(grupos.map(({ clave, nombre, ids }) => ({ clave, nombre, cantidad: ids.length })));
    } catch (e) { next(e); }
  });

router.post('/blasters/:id/a-base', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT * FROM blaster WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'El blaster no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      const grupos = await gruposDe(b);
      const grupo = grupos.find((g) => g.clave === String(req.body.grupo || ''));
      if (!grupo || !grupo.ids.length) {
        return res.status(400).json({ error: 'Ese grupo no tiene a nadie' });
      }

      const nombre = String(req.body.nombre || '').trim() || `${b.nombre} · ${grupo.nombre}`;
      if (nombre.length < 3) return res.status(400).json({ error: 'La base necesita un nombre' });

      const personas = await bd.consultar(
        `SELECT d.id, d.numero, d.nombre, d.datos,
                (SELECT r.valor FROM blaster_respuesta r
                  WHERE r.destinatario_id = d.id ORDER BY r.id DESC LIMIT 1) AS valor
           FROM blaster_destinatario d
          WHERE d.id IN (${grupo.ids.map(() => '?').join(',')})`, grupo.ids);

      /* Los de la lista de no llamar no pasan, aunque estén en el grupo:
         pidieron que no se les contactara. */
      const excluidos = new Set((await bd.consultar(
        `SELECT numero FROM no_llamar WHERE numero IN (${personas.map(() => '?').join(',')})`,
        personas.map((p) => p.numero))).map((x) => x.numero));

      let etiquetas = {};
      try { etiquetas = b.respuesta_etiquetas ? JSON.parse(b.respuesta_etiquetas) : {}; }
      catch { etiquetas = {}; }

      let baseId = 0;
      let cargados = 0;

      await bd.transaccion(async (cx) => {
        /* La base nace en borrador: el supervisor la revisa, ajusta el
           horario si hace falta y la activa él. */
        const [nueva] = await cx.execute(
          `INSERT INTO base (nombre, campana_id, reintentos, intervalo_min,
                             hora_inicio, hora_fin, dias, estado, creado_por)
           VALUES (?, ?, 2, 60, '08:00:00', '18:00:00', 'L,M,X,J,V', 'borrador', ?)`,
          [nombre.slice(0, 120), b.campana_id, req.usuario.id]);
        baseId = nueva.insertId;

        for (const p of personas) {
          if (excluidos.has(p.numero)) continue;

          let datos = {};
          try { datos = typeof p.datos === 'string' ? JSON.parse(p.datos || '{}') : (p.datos || {}); }
          catch { datos = {}; }

          /* El agente ve qué respondió en el blaster: llama sabiendo por
             qué lo llama. */
          if (p.valor && !/^invalida:/.test(p.valor)) {
            datos['respuesta en el blaster'] = etiquetas[p.valor]
              ? `${p.valor} · ${etiquetas[p.valor]}` : p.valor;
          }
          datos['viene del blaster'] = b.nombre;

          await cx.execute(
            `INSERT INTO base_contacto (base_id, telefono_1, nombre, datos)
             VALUES (?, ?, ?, ?)`,
            [baseId, p.numero, p.nombre || null, JSON.stringify(datos)]);
          cargados++;
        }
      });

      await auth.auditar(req.usuario.id, 'crear', 'base', baseId,
        `Creó la base "${nombre}" con ${cargados} contactos del blaster "${b.nombre}"`, req.ip);

      res.status(201).json({ ok: true, base_id: baseId, nombre, cargados, excluidos: excluidos.size });
    } catch (e) { next(e); }
  });

module.exports = router;