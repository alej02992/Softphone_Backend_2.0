/* ═══════════════════════════════════════════════════════════════════
   SMS

   Mismo planteamiento que el blaster de voz: el supervisor prepara el
   mensaje y la lista, y el administrador aprueba y envía. Un SMS a
   miles de clientes no se puede deshacer.

   El texto admite variables entre llaves: {nombre}, {valor}. Cada
   destinatario recibe el suyo, y se guarda el texto final enviado para
   saber exactamente qué se le dijo a cada quien.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');
const sms = require('../sms');

const router = express.Router();

/* ═══════════ A QUÉ CAMPAÑAS ALCANZA CADA QUIEN ═══════════ */

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
  if (!mias.length) return 'No tienes campañas asignadas. Pídeselo al administrador.';
  if (!mias.includes(Number(campanaId))) return 'Esa campaña no está a tu cargo';
  return null;
}

const esAdmin = (u) => (u.permisos || []).includes('sms_aprobar');

/* ── Mensajes certificados ──
   Tienen validez jurídica y cuestan más que uno normal. Quedan
   apagados hasta que la empresa decida usarlos: así nadie los activa
   por error y dispara el costo. Para habilitarlos, basta poner
   SMS_CERTIFICADOS=true en el servidor. */
const CERTIFICADOS = require('../config').sms?.certificados === true;

const certificadoPermitido = (pedido) => (CERTIFICADOS ? !!pedido : false);

/* ═══════════ LISTAR ═══════════ */

router.get('/sms', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const mias = await campanasDe(req.usuario);

    let sql = `SELECT s.id, s.nombre, s.campana_id, c.nombre AS campana, s.estado,
                      s.remitente, s.certificado, s.creado, s.fecha_envio,
                      (SELECT COUNT(*) FROM sms_destinatario d WHERE d.sms_id = s.id) AS destinos,
                      (SELECT COUNT(*) FROM sms_destinatario d WHERE d.sms_id = s.id AND d.estado IN ('enviado','entregado')) AS enviados,
                      (SELECT COUNT(*) FROM sms_destinatario d WHERE d.sms_id = s.id AND d.estado = 'entregado') AS entregados
                 FROM sms s
                 LEFT JOIN campana c ON c.id = s.campana_id`;
    const val = [];

    if (mias !== null) {
      if (!mias.length) return res.json([]);
      sql += ` WHERE s.campana_id IN (${mias.map(() => '?').join(',')})`;
      val.push(...mias);
    }
    sql += ' ORDER BY s.creado DESC';

    res.json(await bd.consultar(sql, val));
  } catch (e) { next(e); }
});

router.get('/sms/:id', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const s = await bd.una(
      `SELECT s.*, c.nombre AS campana FROM sms s
         LEFT JOIN campana c ON c.id = s.campana_id WHERE s.id = ?`, [Number(req.params.id)]);
    if (!s) return res.status(404).json({ error: 'Ese envío no existe' });

    const no = await puedeCon(req.usuario, s.campana_id);
    if (no) return res.status(403).json({ error: no });

    s.variables = sms.variablesDe(s.texto);
    s.partes = sms.partes(s.texto);
    res.json(s);
  } catch (e) { next(e); }
});

/* ═══════════ CREAR Y MODIFICAR ═══════════ */

function revisar(b) {
  if (!b.nombre || String(b.nombre).trim().length < 3) {
    return 'El envío necesita un nombre de al menos tres caracteres';
  }
  if (!b.campana_id) return 'Falta la campaña';
  const texto = String(b.texto || '').trim();
  if (texto.length < 5) return 'El mensaje está vacío';
  if (texto.length > 900) {
    return 'El mensaje supera los 900 caracteres. Son demasiados SMS por persona.';
  }
  if (b.remitente && !/^[A-Za-z0-9]{3,11}$/.test(String(b.remitente).trim())) {
    return 'El remitente debe tener de 3 a 11 letras o números, sin espacios';
  }
  return null;
}

router.post('/sms', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const error = revisar(b);
    if (error) return res.status(400).json({ error });

    const no = await puedeCon(req.usuario, b.campana_id);
    if (no) return res.status(403).json({ error: no });

    const [r] = await bd.pool.execute(
      `INSERT INTO sms (nombre, campana_id, texto, remitente, certificado, flash,
                        centro_costo, envio, fecha_envio, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(b.nombre).trim(), b.campana_id, String(b.texto).trim(),
       b.remitente || null, certificadoPermitido(b.certificado), !!b.flash, b.centro_costo || null,
       b.envio === 'programado' ? 'programado' : 'ahora',
       b.envio === 'programado' && b.fecha_envio ? new Date(b.fecha_envio) : null,
       req.usuario.id]);

    await auth.auditar(req.usuario.id, 'crear', 'sms', r.insertId,
      `Creó el envío de SMS ${b.nombre}`, req.ip);

    res.status(201).json({
      id: r.insertId,
      variables: sms.variablesDe(b.texto),
      partes: sms.partes(b.texto),
    });
  } catch (e) { next(e); }
});

router.put('/sms/:id', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const actual = await bd.una('SELECT campana_id, estado FROM sms WHERE id = ?', [id]);
    if (!actual) return res.status(404).json({ error: 'Ese envío no existe' });

    const no = await puedeCon(req.usuario, actual.campana_id);
    if (no) return res.status(403).json({ error: no });

    if (['aprobado', 'enviando', 'enviado'].includes(actual.estado)) {
      return res.status(409).json({ error: 'Un envío aprobado ya no se puede modificar' });
    }

    const b = req.body || {};
    const error = revisar({ ...b, campana_id: b.campana_id || actual.campana_id });
    if (error) return res.status(400).json({ error });

    await bd.consultar(
      `UPDATE sms SET nombre = ?, campana_id = ?, texto = ?, remitente = ?,
              certificado = ?, flash = ?, centro_costo = ?, envio = ?, fecha_envio = ?
       WHERE id = ?`,
      [String(b.nombre).trim(), b.campana_id || actual.campana_id, String(b.texto).trim(),
       b.remitente || null, certificadoPermitido(b.certificado), !!b.flash, b.centro_costo || null,
       b.envio === 'programado' ? 'programado' : 'ahora',
       b.envio === 'programado' && b.fecha_envio ? new Date(b.fecha_envio) : null, id]);

    await auth.auditar(req.usuario.id, 'modificar', 'sms', id, 'Modificó un envío de SMS', req.ip);
    res.json({ ok: true, variables: sms.variablesDe(b.texto), partes: sms.partes(b.texto) });
  } catch (e) { next(e); }
});

router.delete('/sms/:id', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const s = await bd.una('SELECT nombre, campana_id, estado FROM sms WHERE id = ?', [id]);
    if (!s) return res.status(404).json({ error: 'Ese envío no existe' });

    const no = await puedeCon(req.usuario, s.campana_id);
    if (no) return res.status(403).json({ error: no });
    if (['enviando', 'enviado'].includes(s.estado)) {
      return res.status(409).json({ error: 'Un envío ya realizado no se borra: queda como registro' });
    }

    await bd.consultar('DELETE FROM sms WHERE id = ?', [id]);
    await auth.auditar(req.usuario.id, 'eliminar', 'sms', id, `Eliminó el envío ${s.nombre}`, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════ DESTINATARIOS ═══════════ */

const NUMERO = /^3\d{9}$/;      // celular colombiano

router.post('/sms/:id/destinos', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const s = await bd.una('SELECT campana_id, estado, texto FROM sms WHERE id = ?', [id]);
    if (!s) return res.status(404).json({ error: 'Ese envío no existe' });

    const no = await puedeCon(req.usuario, s.campana_id);
    if (no) return res.status(403).json({ error: no });
    if (['aprobado', 'enviando', 'enviado'].includes(s.estado)) {
      return res.status(409).json({ error: 'Un envío aprobado ya no admite cambios en la lista' });
    }

    const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
    const soloRevisar = req.body.revisar !== false;

    if (!filas.length) return res.status(400).json({ error: 'El archivo no trae filas' });
    if (filas.length > 5000) {
      return res.status(400).json({ error: 'Máximo 5.000 destinatarios por archivo' });
    }

    /* Números que pidieron no ser contactados. Obligación legal. */
    const excluidos = new Set(
      (await bd.consultar('SELECT numero FROM no_llamar')).map((x) => x.numero));

    const vistos = new Set();
    const revisadas = filas.map((f, i) => {
      const numero = String(f.numero || f.telefono || '').replace(/\D/g, '');
      const nombre = String(f.nombre || '').trim();
      const errores = [];

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

      if (!NUMERO.test(numero)) errores.push('El celular debe tener 10 dígitos y empezar por 3');
      if (vistos.has(numero)) errores.push('Ese número está repetido en el archivo');
      vistos.add(numero);
      if (excluidos.has(numero)) errores.push('Ese número pidió no ser contactado');

      const { texto, faltan } = sms.armarTexto(s.texto, datos);
      if (faltan.length) errores.push('Sin datos para: ' + faltan.join(', '));

      return { linea: i + 2, numero, nombre, datos, texto, errores };
    });

    const validas = revisadas.filter((r) => !r.errores.length);

    if (soloRevisar) {
      return res.json({
        revisado: true,
        total: revisadas.length,
        correctas: validas.length,
        conError: revisadas.length - validas.length,
        /* Cómo quedará el mensaje de los primeros: se lee antes de enviar */
        muestra: validas.slice(0, 3).map((r) => ({
          numero: r.numero, texto: r.texto, partes: sms.partes(r.texto),
        })),
        filas: revisadas.map(({ linea, numero, nombre, errores }) =>
          ({ linea, numero, nombre, errores })),
      });
    }

    let cargados = 0;
    for (const r of validas) {
      try {
        await bd.consultar(
          `INSERT INTO sms_destinatario (sms_id, numero, nombre, datos, texto_final)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), datos = VALUES(datos),
                                   texto_final = VALUES(texto_final)`,
          [id, r.numero, r.nombre || null, JSON.stringify(r.datos), r.texto]);
        cargados++;
      } catch { /* una fila mala no detiene las demás */ }
    }

    await auth.auditar(req.usuario.id, 'modificar', 'sms', id,
      `Cargó ${cargados} destinatarios`, req.ip);

    res.json({ cargados, omitidos: revisadas.length - cargados });
  } catch (e) { next(e); }
});

router.get('/sms/:id/destinos', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const s = await bd.una('SELECT campana_id FROM sms WHERE id = ?', [id]);
    if (!s) return res.status(404).json({ error: 'Ese envío no existe' });

    const no = await puedeCon(req.usuario, s.campana_id);
    if (no) return res.status(403).json({ error: no });

    res.json(await bd.consultar(
      `SELECT id, numero, nombre, texto_final, estado, error, enviado_en, entregado_en
         FROM sms_destinatario WHERE sms_id = ? ORDER BY id LIMIT 1000`, [id]));
  } catch (e) { next(e); }
});

/* ═══════════ APROBAR Y ENVIAR ═══════════ */

router.put('/sms/:id/estado', auth.exigirSesion, auth.exigir('sms'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const s = await bd.una('SELECT * FROM sms WHERE id = ?', [id]);
    if (!s) return res.status(404).json({ error: 'Ese envío no existe' });

    const no = await puedeCon(req.usuario, s.campana_id);
    if (no) return res.status(403).json({ error: no });

    const destino = String(req.body.estado || '');

    /* Aprobar y cancelar son del administrador: son cientos de mensajes
       en nombre de la empresa y no se pueden deshacer. */
    if (['aprobado', 'cancelado'].includes(destino) && !esAdmin(req.usuario)) {
      return res.status(403).json({ error: 'Solo el administrador puede aprobar o cancelar un envío' });
    }
    if (!['listo', 'aprobado', 'cancelado'].includes(destino)) {
      return res.status(400).json({ error: 'Estado no válido' });
    }

    if (destino === 'aprobado') {
      const n = await bd.una(
        'SELECT COUNT(*) AS n FROM sms_destinatario WHERE sms_id = ?', [id]);
      if (!n.n) return res.status(400).json({ error: 'El envío no tiene destinatarios' });
      /* El remitente es opcional: si la cuenta del proveedor ya tiene
         uno configurado, se usa ese. Solo se manda cuando se escribe
         aquí a propósito. */
    }

    await bd.consultar(
      `UPDATE sms SET estado = ?, aprobado_por = ?, aprobado_en = ? WHERE id = ?`,
      [destino,
       destino === 'aprobado' ? req.usuario.id : s.aprobado_por,
       destino === 'aprobado' ? new Date() : s.aprobado_en, id]);

    await auth.auditar(req.usuario.id, 'modificar', 'sms', id,
      `Pasó el envío a ${destino}`, req.ip);

    res.json({ ok: true, estado: destino });
  } catch (e) { next(e); }
});

/** Envía de verdad. Solo el administrador, y solo si está aprobado. */
router.post('/sms/:id/enviar', auth.exigirSesion, auth.exigir('sms_aprobar'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const s = await bd.una('SELECT * FROM sms WHERE id = ?', [id]);
      if (!s) return res.status(404).json({ error: 'Ese envío no existe' });

      if (s.estado !== 'aprobado') {
        return res.status(409).json({ error: 'El envío debe estar aprobado antes de salir' });
      }
      if (!sms.disponible()) {
        return res.status(503).json({
          error: 'No hay proveedor de SMS configurado. Revisa SMS_PROVEEDOR y SMS_CLAVE en el servidor.',
          proveedor: sms.proveedor(),
        });
      }

      const pendientes = await bd.consultar(
        `SELECT id, numero, texto_final FROM sms_destinatario
          WHERE sms_id = ? AND estado = 'pendiente'`, [id]);

      if (!pendientes.length) {
        return res.status(400).json({ error: 'No quedan mensajes pendientes por enviar' });
      }

      await bd.consultar("UPDATE sms SET estado = 'enviando' WHERE id = ?", [id]);

      const r = await sms.enviar(
        pendientes.map((d) => ({ id: d.id, numero: d.numero, texto: d.texto_final })),
        {
          remitente: s.remitente,
          certificado: !!s.certificado,
          flash: !!s.flash,
          centroCosto: s.centro_costo,
          campana: s.nombre,
          fecha: s.envio === 'programado' && s.fecha_envio ? s.fecha_envio : 'Now',
        });

      if (r.error) {
        await bd.consultar("UPDATE sms SET estado = 'aprobado' WHERE id = ?", [id]);
        return res.status(502).json({ error: r.error });
      }

      /* Se marca uno por uno: los de un lote fallido quedan pendientes
         y se pueden reintentar sin volver a mandar los que sí salieron. */
      const fallidos = new Set();
      (r.fallos || []).forEach((f) => {
        for (let i = f.desde - 1; i < f.hasta; i++) {
          if (pendientes[i]) fallidos.add(pendientes[i].id);
        }
      });

      for (const d of pendientes) {
        if (fallidos.has(d.id)) {
          await bd.consultar(
            "UPDATE sms_destinatario SET estado = 'fallido', error = ? WHERE id = ?",
            [(r.fallos[0]?.error || 'Error del proveedor').slice(0, 200), d.id]);
          continue;
        }
        await bd.consultar(
          `UPDATE sms_destinatario SET estado = 'enviado', enviado_en = NOW(), referencia = ?
            WHERE id = ?`,
          [r.referencias?.[String(d.id)] || null, d.id]);
      }

      const quedan = await bd.una(
        "SELECT COUNT(*) AS n FROM sms_destinatario WHERE sms_id = ? AND estado = 'pendiente'", [id]);
      await bd.consultar('UPDATE sms SET estado = ? WHERE id = ?',
        [quedan.n ? 'aprobado' : 'enviado', id]);

      await auth.auditar(req.usuario.id, 'crear', 'sms', id,
        `Envió ${r.enviados} mensajes de ${r.total}`, req.ip);

      res.json({ enviados: r.enviados, total: r.total, fallos: r.fallos || [], pendientes: quedan.n });
    } catch (e) { next(e); }
  });

/* ═══════════ AVISO DE ENTREGA ═══════════

   El proveedor llama a esta ruta cuando sabe si el mensaje llegó. No
   lleva sesión —quien llama es un servidor externo—, así que se protege
   con una clave propia que viaja en la dirección y que solo conoce el
   proveedor. Sin esa clave, no se acepta nada. */

router.post('/sms/entrega', async (req, res, next) => {
  try {
    const clave = require('../config').sms?.claveEntrega;
    if (!clave || req.query.clave !== clave) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const avisos = Array.isArray(req.body) ? req.body : [req.body];
    let aplicados = 0;

    for (const a of avisos) {
      const destinatario = a?.reference01 || a?.reference;
      if (!destinatario) continue;

      const entregado = /deliver|entregad|^1$|^true$/i.test(String(a.status ?? a.estado ?? ''));
      await bd.consultar(
        `UPDATE sms_destinatario
            SET estado = ?, entregado_en = ?, error = ?
          WHERE id = ? AND sms_id IS NOT NULL`,
        [entregado ? 'entregado' : 'fallido',
         entregado ? new Date() : null,
         entregado ? null : String(a.error || a.status || '').slice(0, 200),
         Number(destinatario)]);
      aplicados++;
    }

    res.json({ ok: true, aplicados });
  } catch (e) { next(e); }
});

module.exports = router;
