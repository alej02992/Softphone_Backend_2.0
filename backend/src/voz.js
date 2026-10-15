/* ═══════════════════════════════════════════════════════════════════
   VOZ SINTÉTICA

   Convierte el texto de un blaster en un archivo de audio que Asterisk
   pueda reproducir.

   POR QUÉ ES CONFIGURABLE
   El proveedor se elige en el `.env`. Hoy ElevenLabs, que suena muy
   natural; mañana otro, o una voz instalada en el servidor. Nada del
   resto del código sabe cuál se está usando.

   LO QUE HAY QUE TENER EN CUENTA
   Con un servicio en la nube, el texto sale del servidor. Si dice
   "Señor Juan Pérez, su factura por 250.000 vence mañana", esos datos
   de un cliente viajan a un tercero. Es una decisión de la empresa, no
   técnica: conviene que jurídico la respalde antes de usarlo con datos
   reales.

   Los audios se guardan en disco y se reutilizan: si el texto no
   cambió, no se vuelve a pedir ni a pagar.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const CONFIG = require('./config');

/* Asterisk reproduce mejor los archivos ya convertidos; aquí se guarda
   lo que devuelve el proveedor y la conversión queda para el momento
   de montar la marcación. */
const CARPETA = (CONFIG.tts && CONFIG.tts.carpeta) || '/var/lib/asterisk/sounds/blaster';

const proveedor = () => (CONFIG.tts && CONFIG.tts.proveedor) || 'ninguno';
const clave = () => (CONFIG.tts && CONFIG.tts.clave) || '';

/** Hay servicio de voz configurado. Piper corre en el propio servidor
    y no lleva credencial; los servicios en la nube sí la necesitan. */
const disponible = () => {
  const p = proveedor();
  if (p === 'ninguno') return false;
  if (p === 'piper') return true;
  return !!clave();
};

async function asegurarCarpeta() {
  try { await fsp.mkdir(CARPETA, { recursive: true }); } catch { /* ya existe */ }
}

/* El nombre del archivo incluye un resumen del texto: si el mensaje
   cambia, cambia el archivo, y si no, se reutiliza el que ya está. */
const nombreDe = (base, texto, vozId) =>
  `${base}-${crypto.createHash('sha1').update(`${texto}|${vozId || ''}`).digest('hex').slice(0, 10)}.mp3`;

/* ═══════════ ELEVENLABS ═══════════ */

async function elevenlabs(texto, vozId) {
  const voz = vozId || CONFIG.tts.vozPorDefecto;
  if (!voz) return { error: 'Falta indicar la voz (TTS_VOZ en el servidor)' };

  /* Se pide el audio ya en formato telefónico: μ-law a 8 kHz, que es
     exactamente lo que transporta una llamada.

     Antes se pedía MP3, y una instalación normal de Asterisk NO
     reproduce MP3: el cliente contestaba y escuchaba silencio. Con
     μ-law, Asterisk lo reproduce tal cual, sin convertir nada. */
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voz)}` +
              '?output_format=ulaw_8000';

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': clave(),
      'Content-Type': 'application/json',
      Accept: 'audio/basic',
    },
    body: JSON.stringify({
      text: texto,
      model_id: CONFIG.tts.modelo || 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!r.ok) {
    let detalle = '';
    try { detalle = JSON.stringify(await r.json()).slice(0, 200); } catch { /* sin cuerpo */ }
    return { error: `El servicio de voz respondió ${r.status}. ${detalle}` };
  }
  return { audio: Buffer.from(await r.arrayBuffer()) };
}

/* ═══════════ PIPER ═══════════

   Motor neuronal gratuito (licencia MIT) que corre en el propio
   servidor, sin GPU y sin internet. Suena algo menos natural que un
   servicio de pago, pero tiene una ventaja decisiva: ningún dato del
   cliente sale de la empresa. Para mensajes con nombres o valores de
   factura, eso evita el problema de habeas data.

   Necesita el programa `piper` y un archivo de voz .onnx en el
   servidor. Se configuran con TTS_PIPER y TTS_VOZ. */

function piper(texto, vozId) {
  return new Promise((resolve) => {
    const programa = CONFIG.tts.piper || 'piper';
    const modelo = vozId || CONFIG.tts.vozPorDefecto;
    if (!modelo) return resolve({ error: 'Falta el archivo de voz (TTS_VOZ)' });

    const salida = path.join(CARPETA, `piper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);

    const proc = spawn(programa, ['--model', modelo, '--output_file', salida]);
    let errores = '';

    proc.stderr.on('data', (d) => { errores += d.toString().slice(0, 500); });

    proc.on('error', (e) => resolve({
      error: e.code === 'ENOENT'
        ? `No se encontró el programa "${programa}". Instálalo o ajusta TTS_PIPER.`
        : 'No se pudo ejecutar Piper: ' + e.message,
    }));

    proc.on('close', async (codigo) => {
      if (codigo !== 0) {
        return resolve({ error: `Piper terminó con error ${codigo}. ${errores.slice(0, 160)}` });
      }
      try {
        const audio = await fsp.readFile(salida);
        await fsp.unlink(salida).catch(() => {});
        resolve({ audio, extension: '.wav' });
      } catch (e) {
        resolve({ error: 'Piper no dejó el archivo: ' + e.message });
      }
    });

    proc.stdin.write(texto);
    proc.stdin.end();
  });
}

/* ═══════════ PUNTO DE ENTRADA ═══════════ */

/**
 * Genera el audio de un texto y devuelve el nombre del archivo.
 * Nunca lanza: devuelve `{ error }` para que quien llame decida.
 */
async function generar(texto, vozId, base = 'blaster') {
  const limpio = String(texto || '').trim();
  if (limpio.length < 3) return { error: 'El texto es demasiado corto' };
  if (limpio.length > 2500) {
    return { error: 'El texto supera los 2.500 caracteres. Divídelo en mensajes más cortos.' };
  }
  if (!disponible()) {
    return { error: 'No hay servicio de voz configurado' };
  }

  await asegurarCarpeta();
  /* Cada proveedor entrega un formato distinto: ElevenLabs μ-law y
     Piper wav. Asterisk reproduce los dos sin convertir. La extensión
     importa: Asterisk decide cómo leer el archivo por ella. */
  const extension = proveedor() === 'piper' ? '.wav' : '.ulaw';
  const archivo = nombreDe(base, limpio, vozId).replace(/\.mp3$/, extension);
  const ruta = path.join(CARPETA, archivo);

  /* Si ya se generó ese mismo texto, se reutiliza */
  if (fs.existsSync(ruta)) return { archivo, reutilizado: true };

  let r;
  try {
    if (proveedor() === 'elevenlabs') r = await elevenlabs(limpio, vozId);
    else if (proveedor() === 'piper') r = await piper(limpio, vozId);
    else r = { error: `Proveedor de voz desconocido: ${proveedor()}` };
  } catch (e) {
    return { error: 'No se pudo contactar el servicio de voz: ' + e.message };
  }

  if (r.error) return { error: r.error };

  try {
    await fsp.writeFile(ruta, r.audio);
  } catch (e) {
    return { error: 'No se pudo guardar el audio: ' + e.message };
  }

  return { archivo, bytes: r.audio.length };
}

/**
 * El audio en un formato que el navegador sepa reproducir, para que el
 * supervisor lo escuche antes de lanzar el blaster.
 *
 * Los audios se guardan en formato telefónico —μ-law a 8 kHz—, que es
 * lo que reproduce Asterisk, pero un navegador no lo entiende. Aquí se
 * convierte a wav al vuelo, sin guardar nada: solo se usa para oírlo.
 */
function paraEscuchar(archivo) {
  const { execFile } = require('child_process');
  const ruta = path.isAbsolute(archivo) ? archivo : path.join(CARPETA, archivo);

  return new Promise((resolver) => {
    const esUlaw = /\.ulaw$/i.test(ruta);
    const args = esUlaw
      ? ['-f', 'mulaw', '-ar', '8000', '-ac', '1', '-i', ruta, '-f', 'wav', 'pipe:1']
      : ['-i', ruta, '-f', 'wav', 'pipe:1'];

    execFile('ffmpeg', ['-v', 'error', ...args],
      { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 15000 },
      (err, salida) => resolver(err || !salida?.length ? null : salida.toString('base64')));
  });
}

module.exports = {
  paraEscuchar, generar, disponible, proveedor, armarNombre: nombreDe, CARPETA };
