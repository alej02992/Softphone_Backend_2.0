/* ═══════════════════════════════════════════════════════════════════
   CANAL CON ASTERISK (AMI)

   Hasta ahora la plataforma le preguntaba cosas a Asterisk ejecutando
   comandos de consola y leyendo el texto. Sirve para preguntar, no para
   ordenar.

   Esto es distinto: una conexión abierta todo el tiempo al puerto 5038
   por la que llegan EVENTOS —entró una llamada, contestaron, colgaron—
   y por la que se envían ACCIONES, entre ellas `Originate`, que es
   literalmente "marca este número".

   CÓMO HABLA EL AMI
   Es texto plano. Cada mensaje son líneas "Clave: valor" y termina con
   una línea en blanco:

       Action: Login
       Username: bpm
       Secret: ...
       <línea en blanco>

   Por eso aquí se parte lo que llega por doble salto de línea y cada
   bloque se convierte en un objeto.

   LO MÁS IMPORTANTE: QUE NO SE CAIGA EN SILENCIO
   Si esta conexión se pierde y nadie lo nota, la marcación se detiene
   sin avisar. Por eso: reconexión automática con espera creciente, un
   latido periódico para detectar cuelgues silenciosos, y un estado
   consultable desde la plataforma para que el administrador vea si
   está viva.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const CONFIG = require('./config');

/* Cada cuánto se manda un latido para comprobar que sigue viva */
const LATIDO_MS = 30000;
/* Cuánto se espera una respuesta antes de darla por perdida */
const ESPERA_RESPUESTA_MS = 10000;
/* Esperas de reconexión, en segundos. Crecen para no castigar a un
   Asterisk que está reiniciando. */
const ESPERAS = [1, 2, 5, 10, 20, 30, 60];

class Ami extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.conectado = false;
    this.autenticado = false;
    this.buffer = '';
    this.pendientes = new Map();     // ActionID → quién espera respuesta
    this.contador = 0;
    this.intentos = 0;
    this.latido = null;
    this.reconexion = null;
    this.ultimoError = null;
    this.ultimaConexion = null;
    this.cerrandoAposta = false;
  }

  get habilitado() {
    return !!(CONFIG.ami?.activo && CONFIG.ami?.usuario && CONFIG.ami?.clave);
  }

  /** Cómo está la conexión. Lo usa la plataforma para avisar si se cayó. */
  estado() {
    return {
      habilitado: this.habilitado,
      conectado: this.conectado && this.autenticado,
      ultimaConexion: this.ultimaConexion,
      ultimoError: this.ultimoError,
      intentos: this.intentos,
    };
  }

  /* ═══════════ CONEXIÓN ═══════════ */

  conectar() {
    if (!this.habilitado || this.socket) return;

    this.cerrandoAposta = false;
    const { host = '127.0.0.1', puerto = 5038 } = CONFIG.ami;

    this.socket = net.createConnection({ host, port: puerto });
    this.socket.setEncoding('utf8');
    this.socket.setKeepAlive(true, 15000);

    this.socket.on('connect', () => {
      this.conectado = true;
      this.intentos = 0;
      this.ultimoError = null;
      this.identificarse();
    });

    this.socket.on('data', (trozo) => this.recibir(trozo));

    this.socket.on('error', (e) => {
      this.ultimoError = e.code === 'ECONNREFUSED'
        ? 'Asterisk no acepta la conexión en el puerto 5038. ¿Está habilitado el AMI?'
        : e.message;
    });

    this.socket.on('close', () => {
      this.conectado = false;
      this.autenticado = false;
      this.socket = null;
      clearInterval(this.latido);

      /* Quien estuviera esperando respuesta no se queda colgado */
      this.pendientes.forEach(({ fallar }) => fallar(new Error('Se perdió la conexión con Asterisk')));
      this.pendientes.clear();

      this.emit('desconectado', this.ultimoError);
      if (!this.cerrandoAposta) this.reintentar();
    });
  }

  reintentar() {
    if (this.reconexion) return;
    const espera = ESPERAS[Math.min(this.intentos, ESPERAS.length - 1)];
    this.intentos++;

    this.reconexion = setTimeout(() => {
      this.reconexion = null;
      this.conectar();
    }, espera * 1000);
  }

  async identificarse() {
    try {
      await this.enviar({
        Action: 'Login',
        Username: CONFIG.ami.usuario,
        Secret: CONFIG.ami.clave,
        Events: 'on',
      });
      this.autenticado = true;
      this.ultimaConexion = new Date();
      this.emit('listo');

      /* El latido detecta la conexión muerta que el sistema todavía da
         por viva: si no responde, se cierra y se reconecta. */
      clearInterval(this.latido);
      this.latido = setInterval(() => {
        this.enviar({ Action: 'Ping' }).catch(() => {
          this.ultimoError = 'Asterisk dejó de responder al latido';
          this.socket?.destroy();
        });
      }, LATIDO_MS);
    } catch (e) {
      this.ultimoError = 'Asterisk rechazó la credencial: ' + e.message;
      this.autenticado = false;
      this.socket?.destroy();
    }
  }

  cerrar() {
    this.cerrandoAposta = true;
    clearInterval(this.latido);
    clearTimeout(this.reconexion);
    this.reconexion = null;
    this.socket?.destroy();
    this.socket = null;
  }

  /* ═══════════ LO QUE LLEGA ═══════════ */

  recibir(trozo) {
    this.buffer += trozo;

    /* Los mensajes se separan por una línea en blanco. Lo que queda
       después del último separador es un mensaje incompleto: se guarda
       para unirlo con lo que llegue luego. */
    const partes = this.buffer.split('\r\n\r\n');
    this.buffer = partes.pop();

    partes.forEach((bloque) => {
      const mensaje = {};
      bloque.split('\r\n').forEach((linea) => {
        const corte = linea.indexOf(':');
        if (corte > 0) {
          mensaje[linea.slice(0, corte).trim()] = linea.slice(corte + 1).trim();
        }
      });
      if (Object.keys(mensaje).length) this.procesar(mensaje);
    });
  }

  procesar(m) {
    /* ¿Es la respuesta a algo que pedimos? */
    const id = m.ActionID;
    if (id && this.pendientes.has(id)) {
      const { listo, fallar, temporizador } = this.pendientes.get(id);
      clearTimeout(temporizador);
      this.pendientes.delete(id);

      if (String(m.Response).toLowerCase() === 'error') {
        fallar(new Error(m.Message || 'Asterisk rechazó la petición'));
      } else listo(m);
      return;
    }

    /* Si no, es un evento de la central */
    if (m.Event) this.emit('evento', m);
  }

  /* ═══════════ LO QUE SE ENVÍA ═══════════ */

  /** Manda una acción y espera su respuesta. Cada una lleva un
      identificador propio para saber cuál respuesta corresponde a cuál
      petición, porque llegan mezcladas con los eventos. */
  enviar(accion) {
    return new Promise((listo, fallar) => {
      if (!this.socket || !this.conectado) {
        return fallar(new Error('No hay conexión con Asterisk'));
      }

      const id = `bpm-${Date.now()}-${++this.contador}`;
      const temporizador = setTimeout(() => {
        this.pendientes.delete(id);
        fallar(new Error('Asterisk no respondió a tiempo'));
      }, ESPERA_RESPUESTA_MS);

      this.pendientes.set(id, { listo, fallar, temporizador });

      const texto = Object.entries({ ...accion, ActionID: id })
        .map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';

      this.socket.write(texto);
    });
  }

  /**
   * Marca un número y, cuando contesten, conecta la llamada con la
   * extensión del agente.
   *
   * Async: Asterisk responde "ya empecé" de inmediato y avisa el
   * resultado por eventos. Si fuera síncrono, la conexión quedaría
   * bloqueada durante todo el timbrado.
   */
  originar({ numero, extension, contexto = 'from-internal', identificador,
             espera = 30, datos = {} }) {
    const variables = Object.entries({ ...datos, BPM_ID: identificador || '' })
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, ' ')}`)
      .join(',');

    return this.enviar({
      Action: 'Originate',
      /* Primero se llama al agente y después al cliente: así el cliente
         no escucha silencio mientras el agente contesta. */
      Channel: `PJSIP/${extension}`,
      Context: contexto,
      Exten: numero,
      Priority: 1,
      Timeout: espera * 1000,
      CallerID: `${numero} <${numero}>`,
      Async: 'true',
      Variable: variables,
    });
  }

  /**
   * Acciones que responden con una lista. Asterisk contesta primero
   * "Success" y después va mandando un evento por cada elemento, hasta
   * uno final que avisa que terminó. Hay que juntarlos todos.
   *
   * Se usa para preguntar qué llamadas hay en curso.
   */
  listar(accion, eventoElemento, eventoFinal) {
    return new Promise((listo, fallar) => {
      if (!this.socket || !this.conectado) {
        return fallar(new Error('No hay conexión con Asterisk'));
      }

      const id = `bpm-${Date.now()}-${++this.contador}`;
      const elementos = [];

      const recoger = (m) => {
        if (m.ActionID !== id) return;
        if (m.Event === eventoElemento) elementos.push(m);
        if (m.Event === eventoFinal) {
          clearTimeout(temporizador);
          this.off('evento', recoger);
          this.pendientes.delete(id);
          listo(elementos);
        }
      };

      const temporizador = setTimeout(() => {
        this.off('evento', recoger);
        this.pendientes.delete(id);
        /* Si no llegó el final, se devuelve lo que se alcanzó a juntar:
           una lista incompleta es mejor que un error. */
        listo(elementos);
      }, ESPERA_RESPUESTA_MS);

      this.on('evento', recoger);
      /* La respuesta inicial no interesa; los datos vienen en eventos */
      this.pendientes.set(id, { listo: () => {}, fallar: () => {}, temporizador: setTimeout(() => {}, 0) });

      this.socket.write(
        Object.entries({ ...accion, ActionID: id })
          .map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    });
  }

  /** Extensiones que están ahora mismo en una llamada.
      Se le pregunta a la central, no al navegador: así da igual si el
      agente marcó desde la plataforma o desde otro teléfono. */
  async extensionesEnLlamada() {
    const canales = await this.listar(
      { Action: 'CoreShowChannels' }, 'CoreShowChannel', 'CoreShowChannelsComplete');

    const ocupadas = new Set();
    canales.forEach((c) => {
      /* Los canales se llaman PJSIP/1011-00000042 */
      const m = /^PJSIP\/(\w+)-/.exec(c.Channel || '');
      if (m) ocupadas.add(m[1]);
    });
    return ocupadas;
  }

  /** Cuelga un canal. */
  colgar(canal) {
    return this.enviar({ Action: 'Hangup', Channel: canal });
  }
}

/* Una sola conexión para toda la aplicación */
const ami = new Ami();

module.exports = ami;
