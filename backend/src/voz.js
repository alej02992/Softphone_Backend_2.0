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
const CONFIG = require('./config');

/* Asterisk reproduce mejor los archivos ya convertidos; aquí se guarda
   lo que devuelve el proveedor y la conversión queda para el momento
   de montar la marcación. */
const CARPETA = (CONFIG.tts && CONFIG.tts.carpeta) || '/var/lib/asterisk/sounds/blaster';

const proveedor = () => (CONFIG.tts && CONFIG.tts.proveedor) || 'ninguno';
const clave = () => (CONFIG.tts && CONFIG.tts.clave) || '';

/** Hay servicio de voz configurado y con credencial. */
const disponible = () => proveedor() !== 'ninguno' && !!clave();

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

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voz)}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': clave(),
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
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
  const archivo = nombreDe(base, limpio, vozId);
  const ruta = path.join(CARPETA, archivo);

  /* Si ya se generó ese mismo texto, se reutiliza */
  if (fs.existsSync(ruta)) return { archivo, reutilizado: true };

  let r;
  try {
    if (proveedor() === 'elevenlabs') r = await elevenlabs(limpio, vozId);
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

module.exports = { generar, disponible, proveedor, armarNombre: nombreDe, CARPETA };