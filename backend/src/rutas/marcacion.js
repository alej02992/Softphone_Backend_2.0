/* ═══════════════════════════════════════════════════════════════════
   MOTOR DE MARCACIÓN

   El supervisor carga una base de contactos y la activa. Los agentes de
   esa campaña reciben los contactos uno por uno: gestionan, tipifican, y
   aparece el siguiente.

   EL PUNTO DELICADO: EL REPARTO
   Si dos agentes quedan libres al mismo tiempo, los dos piden el
   siguiente contacto en el mismo instante. Si se hiciera "buscar y
   luego marcar como asignado" en dos pasos, ambos podrían recibir el
   mismo y el cliente recibiría dos llamadas.

   Por eso se hace al revés: primero se MARCA como asignado con un
   UPDATE —que bloquea la fila mientras se ejecuta— y solo después se
   lee. Quien llega segundo ya no encuentra esa fila libre y se lleva la
   siguiente. Es la misma idea de tomar un número en una fila: primero
   agarras el papel, después lees qué número te tocó.

   CONTACTOS ABANDONADOS
   Si un agente recibe un contacto y se desconecta sin gestionarlo, esa
   fila quedaría asignada para siempre. Por eso, antes de cada reparto,
   se devuelven a la cola los que llevan demasiado tiempo asignados sin
   resolverse.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');
const ami = require('../ami');
const motor = require('../motor');
const CONFIG = require('../config');

const router = express.Router();

/* Cuántos minutos puede tener un agente un contacto asignado antes de
   que se considere abandonado y vuelva a la cola. */
const MINUTOS_ABANDONO = 15;

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

async function puedeCon(usuario, campanaId) {
  const mias = await campanasDe(usuario);
  if (mias === null) return null;
  if (!mias.length) return 'No tienes campañas asignadas. Pídeselo al administrador.';
  if (!mias.includes(Number(campanaId))) return 'Esa campaña no está a tu cargo';
  return null;
}

/* ═══════════ BASES ═══════════ */

router.get('/bases', auth.exigirSesion, auth.exigir('marcacion'), async (req, res, next) => {
  try {
    const mias = await campanasDe(req.usuario);

    let sql = `SELECT b.id, b.nombre, b.campana_id, c.nombre AS campana, b.estado,
                      b.reintentos, b.intervalo_min, b.hora_inicio, b.hora_fin, b.dias, b.creado,
                      (SELECT COUNT(*) FROM base_contacto x WHERE x.base_id = b.id) AS total,
                      (SELECT COUNT(*) FROM base_contacto x WHERE x.base_id = b.id AND x.estado = 'pendiente') AS pendientes,
                      (SELECT COUNT(*) FROM base_contacto x WHERE x.base_id = b.id AND x.estado = 'gestionado') AS gestionados,
                      (SELECT COUNT(*) FROM base_contacto x WHERE x.base_id = b.id AND x.estado = 'sin_contacto') AS sin_contacto,
                      (SELECT COUNT(*) FROM base_contacto x WHERE x.base_id = b.id AND x.estado = 'agendado') AS agendados
                 FROM base b LEFT JOIN campana c ON c.id = b.campana_id`;
    const val = [];

    if (mias !== null) {
      if (!mias.length) return res.json([]);
      sql += ` WHERE b.campana_id IN (${mias.map(() => '?').join(',')})`;
      val.push(...mias);
    }
    sql += ' ORDER BY b.creado DESC';

    res.json(await bd.consultar(sql, val));
  } catch (e) { next(e); }
});

router.get('/bases/:id', auth.exigirSesion, auth.exigir('marcacion'), async (req, res, next) => {
  try {
    const b = await bd.una(
      `SELECT b.*, c.nombre AS campana FROM base b
         LEFT JOIN campana c ON c.id = b.campana_id WHERE b.id = ?`, [Number(req.params.id)]);
    if (!b) return res.status(404).json({ error: 'Esa base no existe' });

    const no = await puedeCon(req.usuario, b.campana_id);
    if (no) return res.status(403).json({ error: no });

    res.json(b);
  } catch (e) { next(e); }
});

/* Cuántas llamadas por agente libre. 1 es progresiva: nunca hay un
   cliente esperando. Por encima de 1 es predictiva, y conviene dejar
   un tope para que nadie escriba un número que sature la troncal. */
function simultaneasDe(b) {
  const n = Number(b.simultaneas);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 2);
}

/* Segundos de cierre: de 0 a 5 minutos. Con 0, la siguiente llamada
   entra apenas el agente cuelga. */
function cierreDe(valor, porDefecto) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return porDefecto;
  return Math.min(Math.round(n), 300);
}

function revisarBase(b) {
  if (!b.nombre || String(b.nombre).trim().length < 3) {
    return 'La base necesita un nombre de al menos tres caracteres';
  }
  if (!b.campana_id) return 'Falta la campaña';
  const r = Number(b.reintentos);
  if (b.reintentos !== undefined && (!Number.isInteger(r) || r < 0 || r > 5)) {
    return 'Los reintentos deben ser un número de 0 a 5';
  }
  const i = Number(b.intervalo_min);
  if (b.intervalo_min !== undefined && (!Number.isInteger(i) || i < 5 || i > 1440)) {
    return 'El intervalo debe estar entre 5 minutos y 24 horas';
  }
  return null;
}

router.post('/bases', auth.exigirSesion, auth.exigir('marcacion'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const error = revisarBase(b);
    if (error) return res.status(400).json({ error });

    const no = await puedeCon(req.usuario, b.campana_id);
    if (no) return res.status(403).json({ error: no });

    const [r] = await bd.pool.execute(
      `INSERT INTO base (nombre, campana_id, reintentos, intervalo_min,
                         hora_inicio, hora_fin, dias, marcacion_auto, simultaneas,
                         cierre_seg, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(b.nombre).trim(), b.campana_id, b.reintentos ?? 2, b.intervalo_min ?? 60,
       b.hora_inicio || '08:00:00', b.hora_fin || '19:00:00',
       b.dias || 'L,M,X,J,V', !!b.marcacion_auto, simultaneasDe(b),
       cierreDe(b.cierre_seg, 30), req.usuario.id]);

    await auth.auditar(req.usuario.id, 'crear', 'base', r.insertId,
      `Creó la base ${b.nombre}`, req.ip);

    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

router.put('/bases/:id', auth.exigirSesion, auth.exigir('marcacion'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const actual = await bd.una('SELECT * FROM base WHERE id = ?', [id]);
    if (!actual) return res.status(404).json({ error: 'Esa base no existe' });

    const no = await puedeCon(req.usuario, actual.campana_id);
    if (no) return res.status(403).json({ error: no });

    /* Lo que no llega se conserva. Antes se reemplazaba por el valor
       por defecto, así que una petición con un solo campo apagaba la
       marcación automática o cambiaba los horarios sin que nadie lo
       pidiera. */
    const b = { ...req.body };
    const tomar = (clave, porDefecto) =>
      (b[clave] === undefined || b[clave] === null || b[clave] === '' ? porDefecto : b[clave]);

    const datos = {
      nombre: String(tomar('nombre', actual.nombre)).trim(),
      reintentos: tomar('reintentos', actual.reintentos),
      intervalo_min: tomar('intervalo_min', actual.intervalo_min),
      hora_inicio: tomar('hora_inicio', actual.hora_inicio),
      hora_fin: tomar('hora_fin', actual.hora_fin),
      dias: tomar('dias', actual.dias),
      marcacion_auto: b.marcacion_auto === undefined ? !!actual.marcacion_auto : !!b.marcacion_auto,
      simultaneas: b.simultaneas === undefined ? actual.simultaneas : simultaneasDe(b),
      cierre_seg: b.cierre_seg === undefined ? actual.cierre_seg : cierreDe(b.cierre_seg, actual.cierre_seg),
    };

    const error = revisarBase({ ...datos, campana_id: actual.campana_id });
    if (error) return res.status(400).json({ error });

    await bd.consultar(
      `UPDATE base SET nombre = ?, reintentos = ?, intervalo_min = ?,
              hora_inicio = ?, hora_fin = ?, dias = ?, marcacion_auto = ?, simultaneas = ?,
              cierre_seg = ?
        WHERE id = ?`,
      [datos.nombre, datos.reintentos, datos.intervalo_min, datos.hora_inicio,
       datos.hora_fin, datos.dias, datos.marcacion_auto, datos.simultaneas,
       datos.cierre_seg, id]);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Activar, pausar o terminar. Mientras está pausada no se reparte. */
router.put('/bases/:id/estado', auth.exigirSesion, auth.exigir('marcacion'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT nombre, campana_id FROM base WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'Esa base no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      const destino = String(req.body.estado || '');
      if (!['borrador', 'activa', 'pausada', 'terminada'].includes(destino)) {
        return res.status(400).json({ error: 'Estado no válido' });
      }

      if (destino === 'activa') {
        const n = await bd.una(
          "SELECT COUNT(*) AS n FROM base_contacto WHERE base_id = ? AND estado = 'pendiente'", [id]);
        if (!n.n) {
          return res.status(400).json({ error: 'La base no tiene contactos pendientes por llamar' });
        }

        /* Con marcación automática y el canal caído, la base quedaría
           activa sin marcar a nadie. Mejor decirlo ahora. */
        const auto = await bd.una('SELECT marcacion_auto FROM base WHERE id = ?', [id]);
        if (auto.marcacion_auto && !ami.estado().conectado) {
          return res.status(503).json({
            error: 'No hay conexión con la central: la marcación automática no podría llamar. ' +
                   'Revisa el estado del canal antes de activar la base.',
          });
        }
      }

      /* Al pausar, las llamadas en curso vuelven a la cola */
      if (destino !== 'activa') {
        await bd.consultar(
          `UPDATE base_contacto SET estado = 'pendiente', agente_id = NULL,
                  asignado_en = NULL, canal = NULL
            WHERE base_id = ? AND estado = 'llamando'`, [id]);
      }

      /* Al pausar, lo que estaba asignado vuelve a la cola: nadie se
         queda con un contacto en la mano cuando la base se detiene. */
      if (destino !== 'activa') {
        await bd.consultar(
          `UPDATE base_contacto SET estado = 'pendiente', agente_id = NULL, asignado_en = NULL
            WHERE base_id = ? AND estado = 'asignado'`, [id]);
      }

      await bd.consultar('UPDATE base SET estado = ? WHERE id = ?', [destino, id]);
      await auth.auditar(req.usuario.id, 'modificar', 'base', id,
        `Pasó la base ${b.nombre} a ${destino}`, req.ip);

      res.json({ ok: true, estado: destino });
    } catch (e) { next(e); }
  });

router.delete('/bases/:id', auth.exigirSesion, auth.exigir('marcacion'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = await bd.una('SELECT nombre, campana_id, estado FROM base WHERE id = ?', [id]);
    if (!b) return res.status(404).json({ error: 'Esa base no existe' });

    const no = await puedeCon(req.usuario, b.campana_id);
    if (no) return res.status(403).json({ error: no });
    if (b.estado === 'activa') {
      return res.status(409).json({ error: 'Pausa la base antes de eliminarla' });
    }

    await bd.consultar('DELETE FROM base WHERE id = ?', [id]);
    await auth.auditar(req.usuario.id, 'eliminar', 'base', id, `Eliminó la base ${b.nombre}`, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════ CARGAR CONTACTOS ═══════════ */

const CELULAR = /^3\d{9}$/;
const FIJO = /^(60\d{8}|\d{7})$/;
const valido = (n) => CELULAR.test(n) || FIJO.test(n);

router.post('/bases/:id/contactos', auth.exigirSesion, auth.exigir('marcacion'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT campana_id, estado FROM base WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'Esa base no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
      const soloRevisar = req.body.revisar !== false;

      if (!filas.length) return res.status(400).json({ error: 'El archivo no trae filas' });
      if (filas.length > 10000) {
        return res.status(400).json({ error: 'Máximo 10.000 contactos por archivo' });
      }

      /* Números que pidieron no ser llamados */
      const excluidos = new Set(
        (await bd.consultar('SELECT numero FROM no_llamar')).map((x) => x.numero));

      /* Los que ya están en esta base, para no cargarlos dos veces */
      const yaEstan = new Set(
        (await bd.consultar('SELECT telefono_1 FROM base_contacto WHERE base_id = ?', [id]))
          .map((x) => x.telefono_1));

      const vistos = new Set();

      const revisadas = filas.map((f, i) => {
        const limpiar = (v) => String(v ?? '').replace(/\D/g, '');
        const t1 = limpiar(f.telefono_1 || f.telefono || f.numero || f.celular);
        const t2 = limpiar(f.telefono_2 || f.telefono2 || f.celular_2 || f.otro_telefono);
        const nombre = String(f.nombre || '').trim();
        const documento = String(f.documento || f.cedula || '').trim();
        const correo = String(f.correo || f.email || '').trim();
        const errores = [];

        /* Toda columna que no sea de las conocidas queda como dato
           extra: el agente la ve en pantalla al atender. */
        const datos = {};
        Object.entries(f).forEach(([k, v]) => {
          const clave = k.trim().toLowerCase();
          if (['telefono_1', 'telefono', 'numero', 'celular', 'telefono_2', 'telefono2',
               'celular_2', 'otro_telefono', 'nombre', 'documento', 'cedula',
               'correo', 'email'].includes(clave)) return;
          if (String(v ?? '').trim()) datos[clave] = String(v).trim();
        });

        if (!t1) errores.push('Falta el teléfono');
        else if (!valido(t1)) errores.push('El teléfono no parece válido');
        if (t2 && !valido(t2)) errores.push('El segundo teléfono no parece válido');
        if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(correo)) {
          errores.push('El correo no parece válido');
        }
        if (t1 && vistos.has(t1)) errores.push('Ese teléfono está repetido en el archivo');
        if (t1) vistos.add(t1);
        if (t1 && yaEstan.has(t1)) errores.push('Ese teléfono ya está en la base');
        if (t1 && excluidos.has(t1)) errores.push('Ese número pidió no ser llamado');

        return { linea: i + 2, telefono_1: t1, telefono_2: t2 || null,
                 nombre, documento, correo, datos, errores };
      });

      const validas = revisadas.filter((r) => !r.errores.length);

      if (soloRevisar) {
        return res.json({
          revisado: true,
          total: revisadas.length,
          correctas: validas.length,
          conError: revisadas.length - validas.length,
          conSegundo: validas.filter((r) => r.telefono_2).length,
          columnas: [...new Set(validas.flatMap((r) => Object.keys(r.datos)))],
          filas: revisadas.map(({ linea, telefono_1, telefono_2, nombre, correo, errores }) =>
            ({ linea, telefono_1, telefono_2, nombre, correo, errores })),
        });
      }

      let cargados = 0;
      for (const r of validas) {
        try {
          await bd.consultar(
            `INSERT INTO base_contacto (base_id, telefono_1, telefono_2, nombre,
                                        documento, correo, datos)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, r.telefono_1, r.telefono_2, r.nombre || null, r.documento || null,
             r.correo || null, JSON.stringify(r.datos)]);
          cargados++;

          /* ── También a la agenda ──
             La ficha que ve el agente al entrar una llamada sale de la
             tabla de contactos, no de la base de marcación. Sin esto,
             el agente llama a alguien de su propia base y la ficha dice
             "contacto no encontrado".

             Se busca antes de insertar porque la tabla no tiene el
             teléfono como clave única: un "insertar o actualizar"
             crearía un contacto repetido en cada carga. */
          const extra = Object.keys(r.datos).length
            ? Object.entries(r.datos).map(([k, v]) => `${k}: ${v}`).join(' · ')
            : null;

          const yaEsta = await bd.una(
            'SELECT id FROM contacto WHERE telefono = ? LIMIT 1', [r.telefono_1]);

          if (yaEsta) {
            /* Se completa lo que falte, sin pisar lo que ya había: el
               dato viejo puede estar más curado que el del archivo. */
            await bd.consultar(
              `UPDATE contacto
                  SET nombre       = COALESCE(nombre, ?),
                      documento    = COALESCE(documento, ?),
                      telefono_alt = COALESCE(telefono_alt, ?),
                      correo       = COALESCE(correo, ?),
                      descripcion  = COALESCE(descripcion, ?)
                WHERE id = ?`,
              [r.nombre || null, r.documento || null, r.telefono_2 || null,
               r.correo || null, extra, yaEsta.id]);
          } else {
            await bd.consultar(
              `INSERT INTO contacto (nombre, tipo_documento, documento, telefono,
                                     telefono_alt, correo, campana_id, descripcion)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [r.nombre || 'Sin nombre', r.documento ? 'CC' : null, r.documento || null,
               r.telefono_1, r.telefono_2 || null, r.correo || null,
               b.campana_id, extra]);
          }
        } catch { /* una fila mala no detiene las demás */ }
      }

      await auth.auditar(req.usuario.id, 'modificar', 'base', id,
        `Cargó ${cargados} contactos`, req.ip);

      res.json({ cargados, omitidos: revisadas.length - cargados });
    } catch (e) { next(e); }
  });

/* ═══════════ EL REPARTO ═══════════ */

/** Devuelve a la cola los contactos que un agente tomó y no gestionó.
    Sin esto, un agente que cierra el navegador se lleva contactos que
    nadie volvería a llamar. */
async function soltarAbandonados(baseId) {
  await bd.consultar(
    `UPDATE base_contacto
        SET estado = 'pendiente', agente_id = NULL, asignado_en = NULL
      WHERE base_id = ? AND estado = 'asignado'
        AND asignado_en < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [baseId, MINUTOS_ABANDONO]);
}

/**
 * Entrega el siguiente contacto al agente que lo pide.
 *
 * Primero se marca como suyo con un UPDATE y después se lee. Hacerlo en
 * ese orden es lo que impide que dos agentes reciban el mismo contacto:
 * el UPDATE bloquea la fila mientras se ejecuta, así que el segundo
 * agente ya no la encuentra libre.
 */
router.get('/marcacion/siguiente', auth.exigirSesion, async (req, res, next) => {
  try {
    const yo = await bd.una(
      'SELECT campana_id FROM usuario WHERE id = ?', [req.usuario.id]);
    if (!yo?.campana_id) {
      return res.status(400).json({ error: 'No tienes campaña asignada' });
    }

    /* La base activa de su campaña. Si hay varias, la más antigua. */
    const base = await bd.una(
      `SELECT id, reintentos, intervalo_min, hora_inicio, hora_fin, dias,
              marcacion_auto, cierre_seg
         FROM base WHERE campana_id = ? AND estado = 'activa'
        ORDER BY creado LIMIT 1`, [yo.campana_id]);

    if (!base) return res.json({ hay: false, motivo: 'No hay ninguna base activa' });

    /* Fuera del horario no se llama a nadie */
    const ahora = new Date();
    const dia = ['D', 'L', 'M', 'X', 'J', 'V', 'S'][ahora.getDay()];
    const hora = ahora.toTimeString().slice(0, 8);

    if (!String(base.dias).split(',').map((d) => d.trim()).includes(dia)) {
      return res.json({ hay: false, motivo: 'Hoy no es un día de marcación para esta base' });
    }
    if (hora < base.hora_inicio || hora > base.hora_fin) {
      return res.json({
        hay: false,
        motivo: `Fuera del horario de la base (${base.hora_inicio.slice(0, 5)} a ${base.hora_fin.slice(0, 5)})`,
      });
    }

    await soltarAbandonados(base.id);

    /* Un agente solo puede tener UN contacto a la vez. Si ya tiene uno
       asignado —porque recargó la página o pidió dos veces seguidas— se
       le devuelve ese mismo, no otro. Sin esta regla se iría quedando
       con contactos que nadie más podría llamar. */
    const yaTiene = await bd.una(
      `SELECT id FROM base_contacto
        WHERE agente_id = ? AND estado = 'asignado' LIMIT 1`, [req.usuario.id]);

    /* ── El reparto ──
       Se toma primero y se lee después. El orden pone adelante lo
       agendado que ya venció, y después lo que lleva más tiempo
       esperando. */
    let idContacto = yaTiene?.id;

    if (!idContacto) {
      const [tomado] = await bd.pool.execute(
        `UPDATE base_contacto
            SET estado = 'asignado', agente_id = ?, asignado_en = NOW()
          WHERE base_id = ?
            AND estado IN ('pendiente', 'agendado')
            AND (proximo_intento IS NULL OR proximo_intento <= NOW())
            AND (agendado_para IS NULL OR agendado_para <= NOW())
          ORDER BY (agendado_para IS NOT NULL) DESC, agendado_para ASC, id ASC
          LIMIT 1`,
        [req.usuario.id, base.id]);

      /* Se lee la fila que acaba de quedar marcada como suya. Como el
         agente no tenía ninguna, esta es necesariamente la que tomó. */
      if (tomado.affectedRows) {
        const reciente = await bd.una(
          `SELECT id FROM base_contacto
            WHERE agente_id = ? AND estado = 'asignado'
            ORDER BY asignado_en DESC, id DESC LIMIT 1`, [req.usuario.id]);
        idContacto = reciente?.id;
      }
    }

    if (!idContacto) {
      const quedan = await bd.una(
        `SELECT COUNT(*) AS n FROM base_contacto
          WHERE base_id = ? AND estado IN ('pendiente','agendado')`, [base.id]);
      return res.json({
        hay: false,
        motivo: quedan.n
          ? 'Los contactos que quedan están esperando su reintento o su hora agendada'
          : 'No quedan contactos por llamar en esta base',
      });
    }

    const c = await bd.una(
      `SELECT id, telefono_1, telefono_2, nombre, documento, datos,
              intentos, ultimo_intento, agendado_para
         FROM base_contacto WHERE id = ?`, [idContacto]);

    /* Si ya se intentó con el primer teléfono y hay segundo, se marca
       cuál usar para que el agente no repita el mismo número. */
    const telefono = (c.intentos > 0 && c.telefono_2) ? c.telefono_2 : c.telefono_1;

    res.json({
      hay: true,
      base: {
        id: base.id,
        reintentos: base.reintentos,
        /* En automático la plataforma no ofrece marcar a mano: la
           llamada entra sola y marcar por su cuenta cruzaría las dos. */
        automatica: !!base.marcacion_auto,
        cierre_seg: base.cierre_seg,
      },
      contacto: {
        ...c,
        datos: typeof c.datos === 'string' ? JSON.parse(c.datos || '{}') : (c.datos || {}),
        telefono,
        usandoSegundo: telefono === c.telefono_2,
      },
    });
  } catch (e) { next(e); }
});

/** Devuelve el contacto a la cola sin gestionarlo: el agente se va a
    pausa o cierra sesión. */
router.post('/marcacion/soltar', auth.exigirSesion, async (req, res, next) => {
  try {
    await bd.consultar(
      `UPDATE base_contacto SET estado = 'pendiente', agente_id = NULL, asignado_en = NULL
        WHERE agente_id = ? AND estado = 'asignado'`, [req.usuario.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════ RESULTADO DE LA GESTIÓN ═══════════ */

router.post('/marcacion/contactos/:id/resultado', auth.exigirSesion,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const c = await bd.una(
        `SELECT c.*, b.reintentos, b.intervalo_min
           FROM base_contacto c JOIN base b ON b.id = c.base_id
          WHERE c.id = ?`, [id]);
      if (!c) return res.status(404).json({ error: 'Ese contacto no existe' });

      /* Solo quien lo tiene asignado puede cerrarlo */
      if (c.agente_id !== req.usuario.id) {
        return res.status(403).json({ error: 'Ese contacto no está asignado a ti' });
      }

      const tipo = String(req.body.tipo || '');
      const resultado = String(req.body.resultado || '').slice(0, 160) || null;
      const observaciones = String(req.body.observaciones || '').slice(0, 2000) || null;

      /* ── Gestionado: se habló con la persona ── */
      if (tipo === 'gestionado') {
        await bd.consultar(
          `UPDATE base_contacto
              SET estado = 'gestionado', resultado = ?, observaciones = ?,
                  intentos = intentos + 1, ultimo_intento = NOW(), gestionado_en = NOW()
            WHERE id = ?`, [resultado, observaciones, id]);
        return res.json({ ok: true, estado: 'gestionado' });
      }

      /* ── Agendado: el cliente pidió que lo llamen después ── */
      if (tipo === 'agendado') {
        const cuando = new Date(req.body.agendado_para);
        if (isNaN(cuando)) return res.status(400).json({ error: 'Falta la fecha del agendamiento' });
        if (cuando <= new Date()) {
          return res.status(400).json({ error: 'La fecha agendada debe ser posterior a ahora' });
        }

        await bd.consultar(
          `UPDATE base_contacto
              SET estado = 'agendado', agendado_para = ?, resultado = ?, observaciones = ?,
                  intentos = intentos + 1, ultimo_intento = NOW(),
                  agente_id = NULL, asignado_en = NULL, proximo_intento = NULL
            WHERE id = ?`,
          [cuando, resultado || 'Agendado', observaciones, id]);
        return res.json({ ok: true, estado: 'agendado', agendado_para: cuando });
      }

      /* ── No contestó ──
         Se cuenta el intento. Si quedan reintentos, vuelve a la cola
         con una hora futura; si se agotaron, se cierra sin contacto. */
      if (tipo === 'no_contesta') {
        const intentos = c.intentos + 1;
        const quedan = intentos <= c.reintentos;

        await bd.consultar(
          `UPDATE base_contacto
              SET estado = ?, intentos = ?, ultimo_intento = NOW(),
                  proximo_intento = ?, resultado = ?, observaciones = ?,
                  agente_id = NULL, asignado_en = NULL
            WHERE id = ?`,
          [quedan ? 'pendiente' : 'sin_contacto', intentos,
           quedan ? new Date(Date.now() + c.intervalo_min * 60000) : null,
           resultado || 'No contesta', observaciones, id]);

        return res.json({
          ok: true,
          estado: quedan ? 'pendiente' : 'sin_contacto',
          intentos,
          /* Si hay segundo teléfono, el próximo intento irá a ese */
          proximoTelefono: quedan && c.telefono_2 ? c.telefono_2 : null,
        });
      }

      /* ── Excluir: número equivocado o pidió no ser llamado ── */
      if (tipo === 'excluir') {
        await bd.transaccion(async (cx) => {
          await cx.execute(
            `UPDATE base_contacto SET estado = 'excluido', resultado = ?, observaciones = ?,
                    agente_id = NULL, asignado_en = NULL WHERE id = ?`,
            [resultado || 'Excluido', observaciones, id]);

          /* Si pidió no ser llamado, queda en la lista general */
          if (req.body.no_llamar) {
            await cx.execute(
              'INSERT IGNORE INTO no_llamar (numero, motivo) VALUES (?, ?)',
              [c.telefono_1, (observaciones || 'Lo pidió el cliente').slice(0, 160)]);
          }
        });
        return res.json({ ok: true, estado: 'excluido' });
      }

      res.status(400).json({ error: 'Tipo de resultado no válido' });
    } catch (e) { next(e); }
  });

/* ═══════════ SEGUIMIENTO ═══════════ */

router.get('/bases/:id/contactos', auth.exigirSesion, auth.exigir('marcacion'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const b = await bd.una('SELECT campana_id FROM base WHERE id = ?', [id]);
      if (!b) return res.status(404).json({ error: 'Esa base no existe' });

      const no = await puedeCon(req.usuario, b.campana_id);
      if (no) return res.status(403).json({ error: no });

      const cond = ['c.base_id = ?'];
      const val = [id];
      if (req.query.estado) { cond.push('c.estado = ?'); val.push(req.query.estado); }

      const contactos = await bd.consultar(
        `SELECT c.id, c.telefono_1, c.telefono_2, c.nombre, c.documento, c.estado,
                c.intentos, c.ultimo_intento, c.proximo_intento, c.agendado_para,
                c.resultado, c.observaciones, COALESCE(u.nombre, c.agente_nombre) AS agente
           FROM base_contacto c LEFT JOIN usuario u ON u.id = c.agente_id
          WHERE ${cond.join(' AND ')}
          ORDER BY c.id LIMIT 2000`, val);

      const resumen = await bd.una(
        `SELECT COUNT(*) AS total,
                SUM(estado = 'pendiente')    AS pendientes,
                SUM(estado = 'asignado')     AS en_gestion,
                SUM(estado = 'gestionado')   AS gestionados,
                SUM(estado = 'sin_contacto') AS sin_contacto,
                SUM(estado = 'agendado')     AS agendados,
                SUM(estado = 'excluido')     AS excluidos
           FROM base_contacto WHERE base_id = ?`, [id]);

      res.json({ resumen, contactos });
    } catch (e) { next(e); }
  });

/* ═══════════ CANAL CON ASTERISK ═══════════

   Permite ver desde la plataforma si la conexión con la central está
   viva. Si se cae, la marcación automática se detiene, así que el
   administrador necesita enterarse sin entrar al servidor. */

router.get('/ami/estado', auth.exigirSesion, auth.exigir('marcacion'),
  (req, res) => res.json(ami.estado()));

/** Qué está haciendo el motor: si anda, cómo está el canal y las
    últimas decisiones que tomó. Sirve para entender por qué una base
    no está marcando sin entrar al servidor. */
router.get('/marcacion/motor', auth.exigirSesion, auth.exigir('marcacion'),
  (req, res) => res.json(motor.estado()));

/** Llamada de prueba: marca un número y lo conecta con una extensión.
    Sirve para comprobar que el canal funciona antes de lanzar una base
    completa. Solo administradores. */
router.post('/ami/probar', auth.exigirSesion, auth.exigir('usuarios'),
  async (req, res, next) => {
    try {
      const numero = String(req.body.numero || '').replace(/\D/g, '');
      const extension = String(req.body.extension || '').replace(/\D/g, '');

      if (!numero || !extension) {
        return res.status(400).json({ error: 'Hacen falta el número y la extensión' });
      }
      if (!ami.estado().conectado) {
        return res.status(503).json({
          error: 'No hay conexión con la central',
          detalle: ami.estado().ultimoError,
        });
      }

      await ami.originar({ numero, extension, identificador: 'prueba' });

      await auth.auditar(req.usuario.id, 'crear', 'llamada', null,
        `Llamada de prueba a ${numero} desde la extensión ${extension}`, req.ip);

      res.json({ ok: true, aviso: 'La llamada se está originando. Revisa el teléfono.' });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

/* ═══════════ ESCUCHA EN VIVO ═══════════

   El supervisor entra a oír una llamada en curso. Asterisk lo hace con
   ChanSpy, y la plataforma solo tiene que conectar la extensión del
   supervisor con esa función.

   TRES MODOS
   escuchar   solo oye; ni el agente ni el cliente lo notan
   susurrar   le habla al agente sin que el cliente lo oiga
   entrar     los tres hablan

   DOS REGLAS QUE NO SE NEGOCIAN
   Un supervisor solo puede escuchar a los agentes de sus campañas, y
   cada escucha queda registrada: quién oyó a quién y cuándo. Escuchar
   conversaciones ajenas es delicado, y si alguien pregunta, tiene que
   haber respuesta.                                                     */

/* Cada modo tiene su propio código interno. Así no hace falta mandar
   variables por el canal: el número ya dice qué hacer.

   El supervisor nunca ve ni escribe estos códigos: los marca la
   plataforma por detrás cuando él pulsa el botón. */
const MODOS = {
  escuchar: { codigo: '*55', texto: 'escuchó a' },
  susurrar: { codigo: '*56', texto: 'susurró a' },
  entrar:   { codigo: '*57', texto: 'entró a la llamada de' },
};

/**
 * Autoriza una escucha y devuelve el código que la plataforma marcará.
 *
 * No se origina la llamada desde aquí a propósito. Si la central
 * llamara al supervisor, él tendría que contestar su teléfono para
 * poder oír. Marcando desde su navegador, la escucha empieza al
 * instante: pulsa el botón y ya está oyendo.
 */
router.post('/escucha', auth.exigirSesion, auth.exigir('escucha'), async (req, res, next) => {
  try {
    const modo = MODOS[req.body.modo] ? req.body.modo : 'escuchar';
    const objetivo = String(req.body.extension || '').replace(/\D/g, '');
    if (!objetivo) return res.status(400).json({ error: 'Falta la extensión del agente' });

    const yo = await bd.una('SELECT extension FROM usuario WHERE id = ?', [req.usuario.id]);
    if (!yo?.extension) {
      return res.status(400).json({
        error: 'No tienes extensión asignada: pídesela al administrador para poder escuchar' });
    }
    if (yo.extension === objetivo) {
      return res.status(400).json({ error: 'No puedes escucharte a ti mismo' });
    }

    /* Solo agentes de sus campañas. Esto se comprueba aquí y no en la
       pantalla: ocultar un botón no protege nada. */
    const agente = await bd.una(
      `SELECT u.id, u.nombre, u.campana_id FROM usuario u
        WHERE u.extension = ? AND u.activo = TRUE`, [objetivo]);
    if (!agente) return res.status(404).json({ error: 'Esa extensión no es de ningún agente activo' });

    const no = await puedeCon(req.usuario, agente.campana_id);
    if (no) return res.status(403).json({ error: 'Ese agente no está en tus campañas' });

    /* Queda registrado antes de empezar: si alguien pregunta quién oyó
       una llamada, tiene que haber respuesta. */
    await auth.auditar(req.usuario.id, 'consultar', 'escucha', agente.id,
      `${MODOS[modo].texto} ${agente.nombre} (extensión ${objetivo})`, req.ip);

    res.json({
      ok: true,
      modo,
      agente: agente.nombre,
      numero: MODOS[modo].codigo + objetivo,
    });
  } catch (e) { next(e); }
});

/* ═══════════ LLAMADAS EN COLA ═══════════

   Lo que el agente ve en su escritorio: cuántas personas están
   esperando en sus colas y desde hace cuánto.

   Es solo informativo. No se puede tomar una llamada de aquí ni
   saltarse el orden: de eso se encarga Asterisk, que reparte por
   antigüedad. Sirve para saber si viene trabajo o si la cosa está
   tranquila.

   Los datos salen de la central en vivo, no de la base: una cola
   cambia cada pocos segundos y un dato guardado no serviría. */

router.get('/cola/mias', auth.exigirSesion, async (req, res, next) => {
  try {
    const yo = await bd.una(
      'SELECT extension FROM usuario WHERE id = ?', [req.usuario.id]);

    if (!yo?.extension) return res.json({ hay: false, motivo: 'Sin extensión asignada' });

    if (!ami.estado().conectado) {
      return res.json({ hay: false, motivo: 'Sin conexión con la central' });
    }

    /* En qué colas está este agente */
    const mias = await bd.consultar(
      'SELECT queue_name FROM queue_members WHERE interface = ?',
      ['PJSIP/' + yo.extension]);

    const nombres = new Set(mias.map((m) => m.queue_name));

    /* Quién está esperando ahora mismo. QueueStatus devuelve un evento
       por cada persona en espera. */
    const esperando = await ami.listar(
      { Action: 'QueueStatus' }, 'QueueEntry', 'QueueStatusComplete');

    const llamadas = esperando
      .filter((e) => nombres.has(e.Queue))
      .map((e) => ({
        cola: e.Queue,
        posicion: Number(e.Position) || 0,
        numero: e.CallerIDNum || e.CallerID || 'Desconocido',
        nombre: e.CallerIDName && e.CallerIDName !== e.CallerIDNum ? e.CallerIDName : null,
        esperando: Number(e.Wait) || 0,
      }))
      .sort((a, b) => a.posicion - b.posicion);

    /* ── Si no hay nadie esperando en colas ──

       En una campaña saliente no existen colas: las llamadas las crea
       el motor. Entonces se muestran los próximos contactos de la base
       activa, que es lo que el agente quiere saber: qué viene ahora y
       cuánto falta.

       Siguen siendo informativos: no se puede adelantar ni elegir. */
    if (!llamadas.length) {
      const yoCampana = await bd.una(
        'SELECT campana_id FROM usuario WHERE id = ?', [req.usuario.id]);

      if (yoCampana?.campana_id) {
        const base = await bd.una(
          `SELECT id, nombre FROM base
            WHERE campana_id = ? AND estado = 'activa'
            ORDER BY creado LIMIT 1`, [yoCampana.campana_id]);

        if (base) {
          const quedan = await bd.una(
            `SELECT COUNT(*) AS n FROM base_contacto
              WHERE base_id = ? AND estado IN ('pendiente','agendado')`, [base.id]);

          const proximos = await bd.consultar(
            `SELECT telefono_1, telefono_2, nombre, intentos, agendado_para
               FROM base_contacto
              WHERE base_id = ? AND estado IN ('pendiente','agendado')
              ORDER BY (agendado_para IS NOT NULL) DESC, agendado_para ASC, id ASC
              LIMIT 10`, [base.id]);

          return res.json({
            hay: true,
            origen: 'base',
            base: base.nombre,
            total: Number(quedan.n) || 0,
            llamadas: proximos.map((c, i) => ({
              cola: base.nombre,
              posicion: i + 1,
              numero: c.telefono_1,
              nombre: c.nombre || null,
              esperando: 0,
              intentos: c.intentos || 0,
              agendado: c.agendado_para || null,
            })),
          });
        }
      }

      if (!nombres.size) {
        return res.json({ hay: false, motivo: 'No hay base activa ni colas asignadas' });
      }
    }

    res.json({
      hay: true,
      origen: 'cola',
      colas: [...nombres],
      total: llamadas.length,
      llamadas: llamadas.slice(0, 20),
    });
  } catch (e) {
    /* Un fallo consultando la cola no puede romperle el escritorio al
       agente: se informa y ya. */
    res.json({ hay: false, motivo: 'No se pudo consultar la cola' });
  }
});

module.exports = router;
