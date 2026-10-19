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
  const p = PROVEEDORES[proveedor()];
  if (!p) return false;
  return p.necesitaClave ? !!clave() : true;
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
  return { audio: Buffer.from(await r.arrayBuffer()), formato: 'ulaw' };
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
        resolve({ audio, formato: 'contenedor' });
      } catch (e) {
        resolve({ error: 'Piper no dejó el archivo: ' + e.message });
      }
    });

    proc.stdin.write(texto);
    proc.stdin.end();
  });
}

/* ═══════════ GOOGLE CLOUD TEXT-TO-SPEECH ═══════════

   Se pide en LINEAR16 a 8 kHz, que llega como un wav. Después pasa por
   la misma conversión que todos, así que no importa el formato exacto
   que devuelva Google.

   TTS_VOZ es el nombre de la voz, por ejemplo "es-US-Neural2-A".
   TTS_IDIOMA es el idioma, por defecto "es-US".                       */

async function google(texto, vozId) {
  const voz = vozId || CONFIG.tts.vozPorDefecto;
  const idioma = CONFIG.tts.idioma || 'es-US';

  const url = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' +
              encodeURIComponent(clave());

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: texto },
      voice: voz ? { languageCode: idioma, name: voz } : { languageCode: idioma },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
    }),
  });

  if (!r.ok) {
    const detalle = await r.text().catch(() => '');
    return { error: `Google respondió ${r.status}. ${detalle.slice(0, 200)}` };
  }

  const datos = await r.json();
  if (!datos.audioContent) return { error: 'Google no devolvió audio' };

  return { audio: Buffer.from(datos.audioContent, 'base64'), formato: 'contenedor' };
}

/* ═══════════ LOS PROVEEDORES ═══════════

   Para agregar otro servicio: escribir su función —recibe el texto y la
   voz, devuelve { audio, formato }— y añadirlo aquí. Nada más cambia:
   el formato telefónico lo resuelve `aTelefono` para todos.

   formato 'ulaw'        el audio ya viene listo para el teléfono
   formato 'contenedor'  wav, mp3 u otro: se convierte                   */

const PROVEEDORES = {
  elevenlabs: { funcion: (t, v) => elevenlabs(t, v), necesitaClave: true },
  piper:      { funcion: (t, v) => piper(t, v),      necesitaClave: false },
  google:     { funcion: (t, v) => google(t, v),     necesitaClave: true },
};

/**
 * Deja cualquier audio en el formato del teléfono: μ-law a 8 kHz, mono.
 *
 * Es lo que reproduce Asterisk sin convertir. Antes cada proveedor
 * guardaba en su formato, y Piper —que entrega wav a 22 kHz— salía en
 * silencio en la llamada.
 */
function aTelefono(audio) {
  const { execFile } = require('child_process');
  return new Promise((resolver) => {
    const proc = execFile('ffmpeg',
      ['-v', 'error', '-i', 'pipe:0', '-ar', '8000', '-ac', '1', '-f', 'mulaw', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024, timeout: 30000 },
      (err, salida) => resolver(err || !salida?.length
        ? { error: 'No se pudo convertir el audio al formato del teléfono. ¿Está instalado ffmpeg?' }
        : { audio: salida }));
    proc.stdin.end(audio);
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

  const p = PROVEEDORES[proveedor()];
  if (!p) return { error: `Proveedor de voz desconocido: ${proveedor()}` };

  await asegurarCarpeta();

  /* Todos los audios se guardan igual, sea cual sea el proveedor:
     μ-law a 8 kHz, con extensión .ulaw. Asterisk decide cómo leer el
     archivo por la extensión, así que tiene que coincidir. */
  const archivo = nombreDe(base, limpio, `${proveedor()}|${vozId || ''}`).replace(/\.mp3$/, '.ulaw');
  const ruta = path.join(CARPETA, archivo);

  /* Si ya se generó ese mismo texto, se reutiliza: los servicios en la
     nube cobran por carácter. */
  if (fs.existsSync(ruta)) return { archivo, reutilizado: true };

  let r;
  try {
    r = await p.funcion(limpio, vozId);
  } catch (e) {
    return { error: 'No se pudo contactar el servicio de voz: ' + e.message };
  }

  if (r.error) return { error: r.error };

  /* Lo que no venga ya en formato telefónico, se convierte */
  if (r.formato !== 'ulaw') {
    const c = await aTelefono(r.audio);
    if (c.error) return { error: c.error };
    r = { audio: c.audio };
  }

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
