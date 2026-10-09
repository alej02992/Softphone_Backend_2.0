/* ═══════════════════════════════════════════════════════════════════
   REPORTES

   Dos reportes nuevos, junto al de llamadas que ya existía:

   TIPIFICACIÓN  qué resultado tuvo cada gestión y cómo se reparten
   LOGUEO        a qué hora entró cada agente, cuánto estuvo conectado
                 y cuánto tiempo pasó en pausa

   Los tres se pueden descargar en CSV, Excel y PDF. El archivo lo arma
   el servidor y no el navegador: así los tres reportes se descargan
   igual, y el formato no depende de lo que cada computador tenga
   instalado.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const bd = require('../bd');
const auth = require('../auth');

const router = express.Router();

const hoy = () => new Date().toISOString().slice(0, 10);
const fecha = (f) => (f ? new Date(f).toISOString().slice(0, 10) : '');
const hora = (f) => (f ? new Date(f).toTimeString().slice(0, 8) : '');

/** Segundos a algo legible: 1h 05m, 12m 30s, 45s */
function duracion(s) {
  const n = Number(s) || 0;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const seg = n % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(seg).padStart(2, '0')}s`;
  return `${seg}s`;
}

/* ═══════════ A QUIÉN PUEDE VER CADA SUPERVISOR ═══════════ */

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

/* ═══════════ REPORTE DE TIPIFICACIÓN ═══════════ */

router.get('/reportes/tipificaciones', auth.exigirSesion, auth.exigir('reportes'),
  async (req, res, next) => {
    try {
      const { desde, hasta, extension, resultado } = req.query;
      const cond = ['i.resultado IS NOT NULL'];
      const val = [];

      const { desdeHora, hastaHora } = req.query;

      cond.push('i.inicio >= ?'); val.push((desde || hoy()) + ' ' + (desdeHora || '00:00') + ':00');
      cond.push('i.inicio <= ?'); val.push((hasta || desde || hoy()) + ' ' + (hastaHora || '23:59') + ':59');

      /* Con varios días, la hora acota la franja de CADA día: así se
         puede ver "de 8 a 10 de la mañana toda la semana". */
      if ((desdeHora || hastaHora) && hasta && hasta !== desde) {
        cond.push('TIME(i.inicio) BETWEEN ? AND ?');
        val.push((desdeHora || '00:00') + ':00', (hastaHora || '23:59') + ':59');
      }

      if (extension) { cond.push('i.extension = ?'); val.push(extension); }
      if (resultado) { cond.push('i.resultado LIKE ?'); val.push('%' + resultado + '%'); }

      const mias = await campanasDe(req.usuario);
      if (mias !== null) {
        if (!mias.length) return res.json({ resumen: {}, reparto: [], tipificaciones: [] });
        cond.push(`i.campana_id IN (${mias.map(() => '?').join(',')})`);
        val.push(...mias);
      }

      const filas = await bd.consultar(
        `SELECT i.id, i.inicio, i.numero, i.direccion, i.segundos_total,
                i.resultado, i.observaciones, i.extension,
                COALESCE(u.nombre, i.agente_nombre) AS agente, c.nombre AS campana
           FROM interaccion i
           LEFT JOIN usuario u ON u.id = i.usuario_id
           LEFT JOIN campana c ON c.id = i.campana_id
          WHERE ${cond.join(' AND ')}
          ORDER BY i.inicio DESC
          LIMIT 2000`, val);

      /* Cómo se reparten los resultados. Es lo primero que mira un
         supervisor: si el 70% es "no contesta", el problema no está en
         los agentes sino en la base. */
      const cuenta = new Map();
      filas.forEach((f) => {
        const r = f.resultado || 'Sin tipificar';
        cuenta.set(r, (cuenta.get(r) || 0) + 1);
      });

      const reparto = [...cuenta.entries()]
        .map(([resultado_, n]) => ({
          resultado: resultado_,
          cantidad: n,
          porcentaje: filas.length ? Math.round((n / filas.length) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.cantidad - a.cantidad);

      const hablados = filas.reduce((s, f) => s + (f.segundos_total || 0), 0);

      res.json({
        resumen: {
          total: filas.length,
          distintos: reparto.length,
          agentes: new Set(filas.map((f) => f.agente).filter(Boolean)).size,
          segundosHablados: hablados,
          promedio: filas.length ? Math.round(hablados / filas.length) : 0,
        },
        reparto,
        tipificaciones: filas.map((f) => ({
          fecha: fecha(f.inicio),
          hora: hora(f.inicio),
          agente: f.agente || '—',
          extension: f.extension || '—',
          campana: f.campana || '—',
          numero: f.numero,
          direccion: f.direccion,
          duracion: duracion(f.segundos_total),
          resultado: f.resultado,
          observaciones: f.observaciones || '',
        })),
      });
    } catch (e) { next(e); }
  });

/* ═══════════ REPORTE DE LOGUEO ═══════════ */

router.get('/reportes/sesiones', auth.exigirSesion, auth.exigir('reportes'),
  async (req, res, next) => {
    try {
      const { desde, hasta, extension } = req.query;
      const cond = [];
      const val = [];

      const { desdeHora, hastaHora } = req.query;

      cond.push('s.inicio >= ?'); val.push((desde || hoy()) + ' ' + (desdeHora || '00:00') + ':00');
      cond.push('s.inicio <= ?'); val.push((hasta || desde || hoy()) + ' ' + (hastaHora || '23:59') + ':59');

      if ((desdeHora || hastaHora) && hasta && hasta !== desde) {
        cond.push('TIME(s.inicio) BETWEEN ? AND ?');
        val.push((desdeHora || '00:00') + ':00', (hastaHora || '23:59') + ':59');
      }

      if (extension) { cond.push('u.extension = ?'); val.push(extension); }

      const mias = await campanasDe(req.usuario);
      if (mias !== null) {
        if (!mias.length) return res.json({ resumen: {}, sesiones: [] });
        cond.push(`u.campana_id IN (${mias.map(() => '?').join(',')})`);
        val.push(...mias);
      }

      const filas = await bd.consultar(
        `SELECT s.id, s.usuario_id, s.inicio, s.cerrada, s.ip,
                u.nombre AS agente, u.usuario, u.extension, c.nombre AS campana
           FROM sesion s
           JOIN usuario u ON u.id = s.usuario_id
           LEFT JOIN campana c ON c.id = u.campana_id
          WHERE ${cond.join(' AND ')}
          ORDER BY s.inicio DESC
          LIMIT 1000`, val);

      /* Las pausas de cada sesión. Se buscan por usuario y rango de
         horas porque una pausa no guarda a qué sesión pertenece. */
      const sesiones = [];
      for (const s of filas) {
        const fin = s.cerrada || new Date();

        const pausas = await bd.consultar(
          `SELECT p.inicio, p.fin, t.nombre AS motivo
             FROM pausa p LEFT JOIN pausa_tipo t ON t.id = p.pausa_tipo_id
            WHERE p.usuario_id = ? AND p.inicio >= ? AND p.inicio <= ?
            ORDER BY p.inicio`,
          [s.usuario_id, s.inicio, fin]);

        const enPausa = pausas.reduce((suma, p) => {
          const cierre = p.fin ? new Date(p.fin) : new Date();
          return suma + Math.max(0, Math.round((cierre - new Date(p.inicio)) / 1000));
        }, 0);

        const conectado = Math.max(0, Math.round((new Date(fin) - new Date(s.inicio)) / 1000));

        sesiones.push({
          fecha: fecha(s.inicio),
          agente: s.agente,
          usuario: s.usuario,
          extension: s.extension || '—',
          campana: s.campana || '—',
          entrada: hora(s.inicio),
          salida: s.cerrada ? hora(s.cerrada) : 'Sigue conectado',
          conectado: duracion(conectado),
          /* Tiempo productivo: conectado menos lo que estuvo en pausa */
          disponible: duracion(Math.max(0, conectado - enPausa)),
          enPausa: duracion(enPausa),
          pausas: pausas.length,
          /* El detalle de cada break, que es lo que se suele revisar */
          detallePausas: pausas.map((p) => ({
            motivo: p.motivo || 'Sin motivo',
            desde: hora(p.inicio),
            hasta: p.fin ? hora(p.fin) : 'Sin cerrar',
            duracion: duracion(p.fin
              ? Math.round((new Date(p.fin) - new Date(p.inicio)) / 1000)
              : Math.round((Date.now() - new Date(p.inicio)) / 1000)),
          })),
          /* Segundos, para poder sumar en el resumen */
          _conectado: conectado,
          _pausa: enPausa,
        });
      }

      const totalConectado = sesiones.reduce((s, x) => s + x._conectado, 0);
      const totalPausa = sesiones.reduce((s, x) => s + x._pausa, 0);

      res.json({
        resumen: {
          sesiones: sesiones.length,
          agentes: new Set(sesiones.map((s) => s.usuario)).size,
          conectado: duracion(totalConectado),
          enPausa: duracion(totalPausa),
          disponible: duracion(Math.max(0, totalConectado - totalPausa)),
          /* Qué porción del turno se pasó en pausa */
          porcentajePausa: totalConectado
            ? Math.round((totalPausa / totalConectado) * 1000) / 10 : 0,
        },
        sesiones: sesiones.map(({ _conectado, _pausa, ...resto }) => resto),
      });
    } catch (e) { next(e); }
  });

/* ═══════════ REPORTE DE FORMULARIOS ═══════════

   Este reporte no puede tener columnas fijas como los otros: cada
   formulario tiene las suyas. Uno de cobranza pregunta por el motivo
   de no pago; uno de soporte, por el tipo de falla.

   Por eso primero se elige el formulario y después se arma la tabla
   con sus campos. Las columnas vienen del propio formulario, no de una
   lista escrita a mano.                                               */

/** Los formularios que este supervisor puede consultar. */
router.get('/reportes/formularios', auth.exigirSesion, auth.exigir('reportes'),
  async (req, res, next) => {
    try {
      const mias = await campanasDe(req.usuario);
      let sql = `SELECT f.id, f.nombre, c.nombre AS campana,
                        (SELECT COUNT(*) FROM formulario_respuesta x
                          WHERE x.formulario_id = f.id) AS respuestas
                   FROM formulario f LEFT JOIN campana c ON c.id = f.campana_id`;
      const val = [];

      if (mias !== null) {
        if (!mias.length) return res.json([]);
        sql += ` WHERE f.campana_id IN (${mias.map(() => '?').join(',')})`;
        val.push(...mias);
      }
      sql += ' ORDER BY f.nombre';

      res.json(await bd.consultar(sql, val));
    } catch (e) { next(e); }
  });

/** Las respuestas de un formulario, una fila por gestión. */
router.get('/reportes/formularios/:id', auth.exigirSesion, auth.exigir('reportes'),
  async (req, res, next) => {
    try {
      const formularioId = Number(req.params.id);
      const { desde, hasta, desdeHora, hastaHora, extension } = req.query;

      const f = await bd.una(
        'SELECT id, nombre, campana_id FROM formulario WHERE id = ?', [formularioId]);
      if (!f) return res.status(404).json({ error: 'Ese formulario no existe' });

      const mias = await campanasDe(req.usuario);
      if (mias !== null && !mias.includes(f.campana_id)) {
        return res.status(403).json({ error: 'Ese formulario no es de tus campañas' });
      }

      /* Los campos, en el orden en que los ve el agente: así la tabla
         se lee igual que el formulario. */
      const campos = await bd.consultar(
        `SELECT id, etiqueta, tipo, opciones FROM formulario_campo
          WHERE formulario_id = ? ORDER BY orden, id`, [formularioId]);

      const cond = ['r.formulario_id = ?'];
      const val = [formularioId];

      cond.push('r.creada >= ?'); val.push((desde || hoy()) + ' ' + (desdeHora || '00:00') + ':00');
      cond.push('r.creada <= ?'); val.push((hasta || desde || hoy()) + ' ' + (hastaHora || '23:59') + ':59');

      if ((desdeHora || hastaHora) && hasta && hasta !== desde) {
        cond.push('TIME(r.creada) BETWEEN ? AND ?');
        val.push((desdeHora || '00:00') + ':00', (hastaHora || '23:59') + ':59');
      }
      if (extension) { cond.push('u.extension = ?'); val.push(extension); }

      const cabeceras = await bd.consultar(
        `SELECT r.id, r.creada, r.numero, r.interaccion_id,
                COALESCE(u.nombre, r.agente_nombre) AS agente, u.extension,
                i.resultado AS tipificacion
           FROM formulario_respuesta r
           LEFT JOIN usuario u ON u.id = r.usuario_id
           LEFT JOIN interaccion i ON i.id = r.interaccion_id
          WHERE ${cond.join(' AND ')}
          ORDER BY r.creada DESC
          LIMIT 2000`, val);

      /* Los valores de todas esas respuestas en una sola consulta: uno
         por respuesta serían cientos de viajes a la base. */
      const valores = cabeceras.length
        ? await bd.consultar(
            `SELECT respuesta_id, campo_id, valor FROM formulario_valor
              WHERE respuesta_id IN (${cabeceras.map(() => '?').join(',')})`,
            cabeceras.map((c) => c.id))
        : [];

      const porRespuesta = new Map();
      valores.forEach((v) => {
        if (!porRespuesta.has(v.respuesta_id)) porRespuesta.set(v.respuesta_id, {});
        porRespuesta.get(v.respuesta_id)[v.campo_id] = v.valor;
      });

      const filas = cabeceras.map((c) => {
        const vals = porRespuesta.get(c.id) || {};
        const fila = {
          fecha: fecha(c.creada),
          hora: hora(c.creada),
          agente: c.agente || '—',
          extension: c.extension || '—',
          numero: c.numero || '—',
          tipificacion: c.tipificacion || '—',
        };
        campos.forEach((campo) => {
          fila['campo_' + campo.id] = vals[campo.id] ?? '';
        });
        return fila;
      });

      /* Resumen solo de las preguntas con opciones: en esas, saber que
         el 60% respondió lo mismo vale más que leer 300 filas. En las
         de texto libre no diría nada. */
      const resumen = campos
        .filter((campo) => ['lista', 'opciones', 'si_no', 'select', 'radio']
          .includes(String(campo.tipo)))
        .map((campo) => {
          const cuenta = new Map();
          filas.forEach((f2) => {
            const v = String(f2['campo_' + campo.id] || '').trim();
            if (v) cuenta.set(v, (cuenta.get(v) || 0) + 1);
          });
          const total = [...cuenta.values()].reduce((a, b) => a + b, 0);
          return {
            etiqueta: campo.etiqueta,
            total,
            opciones: [...cuenta.entries()]
              .map(([valor, n]) => ({
                valor, cantidad: n,
                porcentaje: total ? Math.round((n / total) * 1000) / 10 : 0,
              }))
              .sort((a, b) => b.cantidad - a.cantidad),
          };
        })
        .filter((x) => x.total);

      res.json({
        formulario: f.nombre,
        /* Las columnas fijas y después una por cada campo */
        columnas: [
          ['fecha', 'Fecha'], ['hora', 'Hora'], ['agente', 'Agente'],
          ['numero', 'Número'], ['tipificacion', 'Tipificación'],
          ...campos.map((c) => ['campo_' + c.id, c.etiqueta]),
        ],
        resumen: { respuestas: filas.length, campos: campos.length },
        reparto: resumen,
        respuestas: filas,
      });
    } catch (e) { next(e); }
  });

/* ═══════════ INDICADORES DEL DÍA ═══════════

   Lo que un supervisor necesita saber de un vistazo: cómo va el día.
   Es distinto del panel de agentes, que dice qué pasa en este segundo.

   Se compara con ayer A LA MISMA HORA, no con el día completo de ayer.
   Comparar las 10 de la mañana de hoy contra un día entero no diría
   nada útil.                                                          */

router.get('/vivo/indicadores', auth.exigirSesion, auth.exigir('supervision'),
  async (req, res, next) => {
    try {
      const mias = await campanasDe(req.usuario);
      const filtro = mias === null ? '' : ` AND i.campana_id IN (${mias.map(() => '?').join(',')})`;
      const val = mias === null ? [] : mias;

      if (mias !== null && !mias.length) {
        return res.json({ hoy: {}, ayer: {}, base: null });
      }

      /* Una sola consulta para todo el día: cuenta, contestadas y
         tiempo hablado. Separarlas sería tres viajes a la base por
         cada refresco. */
      const hoyDatos = await bd.una(
        `SELECT COUNT(*) AS llamadas,
                SUM(i.contestada = TRUE) AS contestadas,
                SUM(IFNULL(i.segundos_total, 0)) AS segundos,
                COUNT(DISTINCT i.usuario_id) AS agentes
           FROM interaccion i
          WHERE DATE(i.inicio) = CURDATE()${filtro}`, val);

      /* Ayer, hasta esta misma hora */
      const ayerDatos = await bd.una(
        `SELECT COUNT(*) AS llamadas,
                SUM(i.contestada = TRUE) AS contestadas
           FROM interaccion i
          WHERE DATE(i.inicio) = SUBDATE(CURDATE(), 1)
            AND TIME(i.inicio) <= CURTIME()${filtro}`, val);

      const llamadas = Number(hoyDatos.llamadas) || 0;
      const contestadas = Number(hoyDatos.contestadas) || 0;
      const segundos = Number(hoyDatos.segundos) || 0;

      /* Lo que queda por llamar en las bases activas. Es lo que le dice
         al supervisor si el día alcanza o se queda sin base a media
         tarde. */
      let base = null;
      try {
        const cond = mias === null ? '' : ` AND b.campana_id IN (${mias.map(() => '?').join(',')})`;
        base = await bd.una(
          `SELECT COUNT(*) AS pendientes,
                  (SELECT COUNT(*) FROM base_contacto x
                    JOIN base y ON y.id = x.base_id
                   WHERE y.estado = 'activa'${mias === null ? '' :
                     ` AND y.campana_id IN (${mias.map(() => '?').join(',')})`}) AS total
             FROM base_contacto c JOIN base b ON b.id = c.base_id
            WHERE b.estado = 'activa' AND c.estado IN ('pendiente','agendado')${cond}`,
          mias === null ? [] : [...val, ...val]);
      } catch { /* sin bases de marcación */ }

      res.json({
        hoy: {
          llamadas,
          contestadas,
          noContestadas: llamadas - contestadas,
          /* Efectiva es toda llamada contestada, sin mirar tipificación */
          efectividad: llamadas ? Math.round((contestadas / llamadas) * 1000) / 10 : 0,
          segundosHablados: segundos,
          promedio: contestadas ? Math.round(segundos / contestadas) : 0,
          agentes: Number(hoyDatos.agentes) || 0,
        },
        ayer: {
          llamadas: Number(ayerDatos.llamadas) || 0,
          contestadas: Number(ayerDatos.contestadas) || 0,
        },
        base: base && Number(base.total) ? {
          pendientes: Number(base.pendientes) || 0,
          total: Number(base.total) || 0,
        } : null,
      });
    } catch (e) { next(e); }
  });

/* ═══════════ DESCARGAS ═══════════

   El archivo lo arma el servidor. Podría hacerse en el navegador, pero
   entonces cada formato dependería de lo que tenga instalado cada
   computador, y el PDF no se podría hacer del todo. */

const COLUMNAS = {
  llamadas: [
    ['fecha', 'Fecha'], ['hora', 'Hora'], ['agente', 'Agente'],
    ['extension', 'Ext.'], ['campana', 'Campaña'], ['direccion', 'Dirección'],
    ['numero', 'Número'], ['estado', 'Estado'], ['duracion', 'Duración'],
    ['tipificacion', 'Tipificación'],
  ],
  tipificaciones: [
    ['fecha', 'Fecha'], ['hora', 'Hora'], ['agente', 'Agente'],
    ['extension', 'Ext.'], ['campana', 'Campaña'], ['numero', 'Número'],
    ['direccion', 'Dirección'], ['duracion', 'Duración'],
    ['resultado', 'Resultado'], ['observaciones', 'Observaciones'],
  ],
  sesiones: [
    ['fecha', 'Fecha'], ['agente', 'Agente'], ['extension', 'Ext.'],
    ['campana', 'Campaña'], ['entrada', 'Entrada'], ['salida', 'Salida'],
    ['conectado', 'Conectado'], ['disponible', 'Disponible'],
    ['enPausa', 'En pausa'], ['pausas', 'Breaks'],
  ],
};

const TITULOS = {
  llamadas: 'Reporte de llamadas',
  tipificaciones: 'Reporte de tipificación',
  sesiones: 'Reporte de inicio de sesión',
  formularios: 'Reporte de formularios',
};

router.post('/reportes/exportar', auth.exigirSesion, auth.exigir('reportes'),
  async (req, res, next) => {
    try {
      const reporte = String(req.body.reporte || '');
      const formato = String(req.body.formato || 'csv');
      const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
      const periodo = String(req.body.periodo || '');

      /* El reporte de formularios trae sus propias columnas, porque
         cada formulario tiene las suyas. Los demás las tienen fijas. */
      const columnas = Array.isArray(req.body.columnas) && req.body.columnas.length
        ? req.body.columnas.slice(0, 40)
        : COLUMNAS[reporte];
      if (!columnas) return res.status(400).json({ error: 'Reporte desconocido' });
      if (!filas.length) return res.status(400).json({ error: 'No hay datos que exportar' });
      if (filas.length > 5000) {
        return res.status(400).json({ error: 'Demasiadas filas. Acota el rango de fechas.' });
      }

      const titulo = TITULOS[reporte] || 'Reporte';
      const nombre = `${reporte}_${new Date().toISOString().slice(0, 10)}`;

      if (formato === 'csv') {
        /* La primera línea le dice a Excel cómo separar: sin ella, según
           la configuración del equipo, todo aparece en una columna. */
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const texto = 'sep=;\r\n' +
          [columnas.map((c) => c[1]), ...filas.map((f) => columnas.map((c) => f[c[0]]))]
            .map((f) => f.map(esc).join(';')).join('\r\n');

        return res.json({
          nombre: nombre + '.csv',
          tipo: 'text/csv;charset=utf-8',
          contenido: Buffer.from('\ufeff' + texto, 'utf8').toString('base64'),
        });
      }

      if (formato === 'excel') {
        const XLSX = require('xlsx');
        const datos = filas.map((f) => {
          const fila = {};
          columnas.forEach(([clave, etiqueta]) => { fila[etiqueta] = f[clave] ?? ''; });
          return fila;
        });

        const hoja = XLSX.utils.json_to_sheet(datos);
        /* Un ancho razonable por columna: sin esto todo sale estrecho */
        hoja['!cols'] = columnas.map(([clave]) =>
          ({ wch: clave === 'observaciones' ? 40 : clave === 'agente' ? 22 : 14 }));

        const libro = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(libro, hoja, titulo.slice(0, 30));

        return res.json({
          nombre: nombre + '.xlsx',
          tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contenido: XLSX.write(libro, { type: 'base64', bookType: 'xlsx' }),
        });
      }

      if (formato === 'pdf') {
        const PDFDocument = require('pdfkit');
        const fs = require('fs');
        const CONFIG = require('../config');
        /* Horizontal: estos reportes tienen muchas columnas */
        const doc = new PDFDocument({
          size: 'LETTER', layout: 'landscape', margin: 30,
          /* Se guardan las páginas en memoria para numerarlas al final,
             cuando ya se sabe cuántas son. */
          bufferPages: true,
          info: { Title: titulo, Author: 'BPM Consulting' },
        });
        const trozos = [];
        doc.on('data', (t) => trozos.push(t));

        const listo = new Promise((resolver) => doc.on('end', resolver));

        const ancho = doc.page.width - 60;
        /* La columna de observaciones necesita más espacio que las demás */
        const pesos = columnas.map(([c]) =>
          c === 'observaciones' ? 2.4 : c === 'agente' ? 1.5 : c === 'resultado' ? 1.8 : 1);
        const suma = pesos.reduce((a, b) => a + b, 0);
        const anchos = pesos.map((p) => (p / suma) * ancho);

        /* El logo de la empresa. Si el archivo no está, el reporte sale
           igual con el nombre escrito: un reporte sin logo sirve, uno
           que no se genera no. */
        const rutaLogo = CONFIG.marca && CONFIG.marca.logo;
        let hayLogo = false;
        try { hayLogo = !!rutaLogo && fs.existsSync(rutaLogo); } catch { hayLogo = false; }

        const cabecera = () => {
          let x = 30;

          if (hayLogo) {
            try {
              doc.image(rutaLogo, 30, 22, { height: 26 });
              x = 30 + 92;                 // el texto arranca tras el logo
            } catch { hayLogo = false; }   // imagen ilegible: se sigue sin ella
          }

          doc.fontSize(13).fillColor('#002E44').text(titulo, x, 25);
          doc.fontSize(8).fillColor('#666')
             .text(`BPM Consulting · ${periodo || 'Sin periodo'} · ${filas.length} registros`, x, 43);

          /* Fecha de generación: un reporte impreso sin fecha no sirve
             de nada dos semanas después. */
          doc.fontSize(7.5).fillColor('#8B979F')
             .text(`Generado el ${new Date().toLocaleString('es-CO', { hour12: false }).slice(0, 16)}`,
                   doc.page.width - 230, 27, { width: 200, align: 'right' });

          doc.moveTo(30, 58).lineTo(doc.page.width - 30, 58)
             .strokeColor('#00BFFC').lineWidth(1.5).stroke();

          let cx = 30;
          doc.fontSize(7.5).fillColor('#002E44');
          columnas.forEach(([, etiqueta], i) => {
            doc.text(etiqueta, cx + 2, 64, { width: anchos[i] - 4, ellipsis: true });
            cx += anchos[i];
          });
          return 78;
        };

        let y = cabecera();

        filas.forEach((f, n) => {
          if (y > doc.page.height - 45) { doc.addPage(); y = cabecera(); }

          if (n % 2) {
            doc.rect(30, y - 2, ancho, 13).fillColor('#f6f8fa').fill();
          }

          let x = 30;
          doc.fontSize(7).fillColor('#1b1f24');
          columnas.forEach(([clave], i) => {
            doc.text(String(f[clave] ?? ''), x + 2, y, { width: anchos[i] - 4, ellipsis: true });
            x += anchos[i];
          });
          y += 13;
        });

        /* El pie con la numeración, al final: hasta aquí no se sabía
           cuántas páginas iba a tener el reporte. */
        const paginas = doc.bufferedPageRange();
        for (let p = 0; p < paginas.count; p++) {
          doc.switchToPage(paginas.start + p);

          /* El margen inferior se anula mientras se escribe el pie: si
             no, pdfkit cree que el texto no cabe y agrega una página
             en blanco por cada pie, duplicando el documento. */
          const margenAbajo = doc.page.margins.bottom;
          doc.page.margins.bottom = 0;

          doc.fontSize(7).fillColor('#8B979F')
             .text(`BPM Consulting · Página ${p + 1} de ${paginas.count}`,
                   30, doc.page.height - 26,
                   { width: doc.page.width - 60, align: 'center', lineBreak: false });

          doc.page.margins.bottom = margenAbajo;
        }

        doc.end();
        await listo;

        return res.json({
          nombre: nombre + '.pdf',
          tipo: 'application/pdf',
          contenido: Buffer.concat(trozos).toString('base64'),
        });
      }

      res.status(400).json({ error: 'Formato desconocido' });
    } catch (e) { next(e); }
  });

module.exports = router;