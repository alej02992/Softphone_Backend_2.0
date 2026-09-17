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

  /* ── Contraseña temporal ──
     La que se asigna al crear un usuario y al restablecer. La persona
     la cambia obligatoriamente en su primer acceso, así que no hace
     falta que sea secreta, pero sí que no sea adivinable.           */
  claveTemporal: process.env.CLAVE_TEMPORAL || 'BpmTemp2026#',

  /* ── Sesiones ──
     La clave firma los tokens. Si alguien la conoce puede fabricar
     sesiones falsas, así que en el servidor debe ser larga y aleatoria:
     openssl rand -base64 48                                            */
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
  realtime: process.env.REALTIME === 'true',
};

module.exports = CONFIG;