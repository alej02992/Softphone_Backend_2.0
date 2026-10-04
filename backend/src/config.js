/* ═══════════════════════════════════════════════════════════════════
   CONFIGURACIÓN

   Todo lo que cambia entre tu equipo y el servidor vive aquí, y se
   lee de variables de entorno (el archivo .env).

   NUNCA se escriben contraseñas dentro del código: el código se sube
   al repositorio, el .env no.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

require('dotenv').config();

const CONFIG = {
  puerto: Number(process.env.PUERTO) || 3001,

  /* ── Base de datos ── */
  bd: {
    host: process.env.BD_HOST || 'localhost',
    puerto: Number(process.env.BD_PUERTO) || 3306,
    usuario: process.env.BD_USUARIO || 'bpm_app',
    clave: process.env.BD_CLAVE || '',
    base: process.env.BD_BASE || 'bpm_contact',
  },

  /* ── Sesiones ──
     La clave firma los tokens. Si alguien la conoce puede fabricar
     sesiones falsas, así que en el servidor debe ser larga y aleatoria:
     openssl rand -base64 48                                            */
  claveTemporal: process.env.CLAVE_TEMPORAL || 'BpmTemp2026',

  jwt: {
    clave: process.env.JWT_CLAVE || 'cambiar-esta-clave-en-produccion',
    duracion: process.env.JWT_DURACION || '8h',   // un turno
  },

  /* ── Central telefónica ──
     Estos datos los entrega el backend al navegador junto con la
     credencial. El agente nunca los escribe.                          */
  pbx: {
    wss: process.env.PBX_WSS || '',
    dominio: process.env.PBX_DOMINIO || '',
    claveFija: process.env.PBX_CLAVE_FIJA || '',
    ice: process.env.PBX_ICE || 'stun:stun.l.google.com:19302',
  },

  /* ── Asterisk Realtime ──
     true  → el backend crea las extensiones escribiendo en las tablas
             ps_endpoints, ps_auths y ps_aors de Asterisk.
     false → solo se crea el usuario en la plataforma; la extensión hay
             que crearla a mano en VitalPBX.                            */
  /* ── Voz sintética para los blasters ──
     El proveedor se elige aquí: si mañana cambia, no se toca el código.
     Con un servicio en la nube, el texto del mensaje sale del servidor,
     así que conviene revisarlo con jurídico antes de usar datos reales. */

     grabaciones: {
      ruta: process.env.GRABACIONES_RUTA || '/var/spool/asterisk/monitor',
      minimoBytes: Number(process.env.GRABACIONES_MINIMO) || 10240,
     },

  tts: {
    proveedor:     process.env.TTS_PROVEEDOR || 'ninguno',
    clave:         process.env.TTS_CLAVE || '',
    vozPorDefecto: process.env.TTS_VOZ || '',
    modelo:        process.env.TTS_MODELO || 'eleven_multilingual_v2',
    carpeta:       process.env.TTS_CARPETA || '/var/lib/asterisk/sounds/blaster',
    /* Ruta del programa Piper cuando TTS_PROVEEDOR=piper */
    piper:         process.env.TTS_PIPER || 'piper',
  },

  /* ── Envío de SMS ──
     El proveedor entrega los mensajes; la plataforma los prepara y los
     registra. La clave solo vive aquí, nunca viaja al navegador. */
  sms: {
    proveedor:    process.env.SMS_PROVEEDOR || 'ninguno',
    clave:        process.env.SMS_CLAVE || '',
    cabecera:     process.env.SMS_CABECERA || 'X-Hablame-Key',
    url:          process.env.SMS_URL || 'https://www.hablame.co/api/sms/v5/send',
    remitente:    process.env.SMS_REMITENTE || '',
    /* Los mensajes certificados tienen validez jurídica y cuestan
       más. Apagados por defecto: se encienden a propósito. */
    certificados: process.env.SMS_CERTIFICADOS === 'true',
    /* Clave propia para que el proveedor nos avise de las entregas */
    claveEntrega: process.env.SMS_CLAVE_ENTREGA || '',
  },

/* ── Canal con Asterisk ──
     Conexión permanente para originar llamadas y recibir eventos. Es
     la llave completa de la central: debe escuchar solo en 127.0.0.1
     y con una clave larga. */
  ami: {
    activo:  process.env.AMI_ACTIVO === 'true',
    host:    process.env.AMI_HOST || '127.0.0.1',
    puerto:  Number(process.env.AMI_PUERTO) || 5038,
    usuario: process.env.AMI_USUARIO || '',
    clave:   process.env.AMI_CLAVE || '',
  },

  realtime: process.env.REALTIME === 'true',
};

module.exports = CONFIG;