/* ═══════════════════════════════════════════════════════════════════
   ARCHIVOS

   Dos cosas que la plataforma no puede hacer por su cuenta:

   LEER EXCEL
   La gente trabaja en Excel, no en CSV. Un .xlsx es un archivo
   comprimido con formato interno: el navegador no puede abrirlo sin
   ayuda. Se manda aquí, se convierte en filas y se devuelve. Sirve
   igual para usuarios, blaster y SMS.

   SUBIR AUDIOS
   Pedirle a un supervisor que deje un archivo en una carpeta del
   servidor no es realista. Aquí se recibe desde su computador, se
   comprueba que sea audio de verdad y se deja donde Asterisk lo busca.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const XLSX = require('xlsx');
const auth = require('../auth');
const CONFIG = require('../config');

const router = express.Router();

/* ═══════════ LEER UNA TABLA ═══════════ */

const TOPE_TABLA = 8 * 1024 * 1024;        // 8 MB

/** Normaliza el título de una columna: minúsculas y sin tildes, para
    que "Número" y "numero" sean lo mismo. */
const normalizar = (t) => String(t || '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

router.post('/archivos/tabla', auth.exigirSesion, async (req, res, next) => {
  try {
    const base64 = String(req.body.contenido || '');
    if (!base64) return res.status(400).json({ error: 'No llegó el archivo' });

    const datos = Buffer.from(base64, 'base64');
    if (!datos.length) return res.status(400).json({ error: 'El archivo está vacío' });
    if (datos.length > TOPE_TABLA) {
      return res.status(413).json({ error: 'El archivo supera los 8 MB' });
    }

    let libro;
    try {
      libro = XLSX.read(datos, { type: 'buffer', cellDates: false, raw: false });
    } catch (e) {
      return res.status(400).json({
        error: 'No se pudo leer el archivo. ¿Es realmente un Excel o un CSV?' });
    }

    const hoja = libro.Sheets[libro.SheetNames[0]];
    if (!hoja) return res.status(400).json({ error: 'El archivo no tiene ninguna hoja con datos' });

    /* defval deja las celdas vacías como texto vacío en lugar de
       omitirlas: así todas las filas tienen las mismas columnas. */
    const crudas = XLSX.utils.sheet_to_json(hoja, { defval: '', raw: false });

    if (!crudas.length) {
      return res.status(400).json({ error: 'La hoja no tiene filas con datos' });
    }
    if (crudas.length > 5000) {
      return res.status(413).json({ error: 'Máximo 5.000 filas por archivo' });
    }

    /* Los títulos se normalizan y los valores se dejan como texto: un
       celular no debe convertirse en número y perder el cero inicial. */
    const filas = crudas.map((f) => {
      const limpia = {};
      Object.entries(f).forEach(([k, v]) => {
        const clave = normalizar(k);
        if (!clave || clave.startsWith('__empty')) return;
        limpia[clave] = String(v ?? '').trim();
      });
      return limpia;
    }).filter((f) => Object.values(f).some((v) => v !== ''));

    res.json({
      filas,
      columnas: Object.keys(filas[0] || {}),
      hoja: libro.SheetNames[0],
      total: filas.length,
    });
  } catch (e) { next(e); }
});

/* ═══════════ AUDIOS ═══════════ */

const CARPETA_AUDIO = CONFIG.tts?.carpeta || '/var/lib/asterisk/sounds/blaster';
const TOPE_AUDIO = 10 * 1024 * 1024;       // 10 MB

/* Qué formatos se aceptan, reconocidos por su contenido y no por el
   nombre: alguien puede renombrar cualquier cosa a .mp3. */
const FIRMAS = [
  { ext: '.mp3', prueba: (b) => b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) },
  { ext: '.wav', prueba: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WAVE' },
  { ext: '.ogg', prueba: (b) => b.slice(0, 4).toString() === 'OggS' },
];

/** Asterisk reproduce mejor un wav de 8 kHz mono. Si hay herramienta
    para convertir, se convierte; si no, se deja como llegó. */
function convertir(origen, destino) {
  return new Promise((resolve) => {
    const intentar = (programa, args) => new Promise((r) => {
      execFile(programa, args, (error) => r(!error));
    });

    (async () => {
      if (await intentar('sox', [origen, '-r', '8000', '-c', '1', '-b', '16', destino])) {
        return resolve({ convertido: true, con: 'sox' });
      }
      if (await intentar('ffmpeg', ['-y', '-i', origen, '-ar', '8000', '-ac', '1', destino])) {
        return resolve({ convertido: true, con: 'ffmpeg' });
      }
      resolve({ convertido: false });
    })();
  });
}

router.post('/archivos/audio', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      const base64 = String(req.body.contenido || '');
      const nombre = String(req.body.nombre || 'audio').trim();
      if (!base64) return res.status(400).json({ error: 'No llegó el archivo' });

      const datos = Buffer.from(base64, 'base64');
      if (datos.length > TOPE_AUDIO) {
        return res.status(413).json({ error: 'El audio supera los 10 MB' });
      }
      if (datos.length < 1000) {
        return res.status(400).json({ error: 'El archivo es demasiado pequeño para ser un audio' });
      }

      const firma = FIRMAS.find((f) => f.prueba(datos));
      if (!firma) {
        return res.status(400).json({
          error: 'Ese archivo no parece un audio. Se aceptan MP3, WAV y OGG.' });
      }

      /* El nombre lo pone el servidor: así nadie puede escribir fuera
         de la carpeta con algo como "../../etc/passwd". */
      const limpio = nombre.replace(/\.[^.]+$/, '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-')
        .slice(0, 40) || 'audio';
      const marca = crypto.randomBytes(4).toString('hex');
      const archivoCrudo = `${limpio}-${marca}${firma.ext}`;

      await fsp.mkdir(CARPETA_AUDIO, { recursive: true });
      const rutaCruda = path.join(CARPETA_AUDIO, archivoCrudo);
      await fsp.writeFile(rutaCruda, datos);

      /* Se intenta dejarlo en el formato que mejor reproduce Asterisk */
      let archivo = archivoCrudo;
      let nota = null;

      if (firma.ext !== '.wav') {
        const convertido = `${limpio}-${marca}.wav`;
        const r = await convertir(rutaCruda, path.join(CARPETA_AUDIO, convertido));
        if (r.convertido) {
          archivo = convertido;
          await fsp.unlink(rutaCruda).catch(() => {});
        } else {
          nota = 'No se pudo convertir a wav: se guardó tal cual. ' +
                 'Instala sox o ffmpeg en el servidor si Asterisk no lo reproduce.';
        }
      }

      await auth.auditar(req.usuario.id, 'crear', 'audio', null,
        `Subió el audio ${archivo}`, req.ip);

      res.status(201).json({ archivo, nota, bytes: datos.length });
    } catch (e) { next(e); }
  });

/** Los audios disponibles, para elegir uno ya subido. */
router.get('/archivos/audios', auth.exigirSesion, auth.exigir('blaster'),
  async (req, res, next) => {
    try {
      let nombres = [];
      try { nombres = await fsp.readdir(CARPETA_AUDIO); } catch { /* no existe aún */ }

      const audios = nombres
        .filter((n) => /\.(mp3|wav|ogg)$/i.test(n))
        /* Los audios que genera la voz sintética empiezan por blaster-
           o piper-: no son grabaciones para elegir. */
        .filter((n) => !/^(blaster|piper)-/.test(n))
        .map((n) => {
          let bytes = 0;
          try { bytes = fs.statSync(path.join(CARPETA_AUDIO, n)).size; } catch { /* ignorar */ }
          return { archivo: n, bytes };
        })
        .sort((a, b) => a.archivo.localeCompare(b.archivo));

      res.json({ carpeta: CARPETA_AUDIO, audios });
    } catch (e) { next(e); }
  });

module.exports = router;
