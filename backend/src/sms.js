/* ═══════════════════════════════════════════════════════════════════
   ENVÍO DE SMS

   Habla con el proveedor de mensajería. Hoy está implementado Háblame,
   que es el que usa la empresa, pero el proveedor se elige por
   configuración: si mañana cambian, se agrega otro aquí y nada más se
   toca.

   DOS COSAS IMPORTANTES

   1. Se envía POR LOTES. El servicio acepta varios mensajes en una
      sola petición, cada uno con su texto propio. Mandar 300 mensajes
      de a uno sería 300 peticiones y mucho más lento.

   2. La clave vive en el .env y solo la usa el servidor. Nunca viaja
      al navegador: quien la tuviera podría mandar mensajes a cuenta de
      la empresa.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const CONFIG = require('./config');

/* Cuántos mensajes por petición. Un número alto va más rápido, pero si
   falla la petición se cae todo el lote; 100 es un término prudente. */
const POR_LOTE = 100;

const proveedor = () => CONFIG.sms?.proveedor || 'ninguno';
const clave = () => CONFIG.sms?.clave || '';

/** Hay proveedor configurado y con credencial. */
const disponible = () => proveedor() !== 'ninguno' && !!clave();

/** Reemplaza {nombre} por los datos del contacto. Lo que no venga se
    deja en blanco, nunca "undefined" delante de un cliente. */
function armarTexto(plantilla, datos = {}) {
  const faltan = [];
  const texto = String(plantilla || '').replace(/\{(\w+)\}/g, (_, clave_) => {
    const v = datos[clave_.toLowerCase()] ?? datos[clave_];
    if (v === undefined || v === null || String(v).trim() === '') {
      faltan.push(clave_);
      return '';
    }
    return String(v);
  }).replace(/[ \t]{2,}/g, ' ').trim();

  return { texto, faltan: [...new Set(faltan)] };
}

/** Las variables que usa una plantilla. */
const variablesDe = (plantilla) =>
  [...new Set([...String(plantilla || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];

/** Cuántos SMS se cobran por un texto.
    Un mensaje son 160 caracteres; con tildes o eñes, 70. */
function partes(texto) {
  const t = String(texto || '');
  const especial = /[^\x00-\x7F]/.test(t);
  const tope = especial ? 70 : 160;
  const porParte = especial ? 67 : 153;      // los concatenados pierden espacio
  return t.length <= tope ? 1 : Math.ceil(t.length / porParte);
}


/* ═══════════ HÁBLAME ═══════════ */

async function hablame(mensajes, opciones) {
  const url = CONFIG.sms.url || 'https://www.hablame.co/api/sms/v5/send';

  const cuerpo = {
    priority: !!opciones.prioritario,
    certificate: !!opciones.certificado,
    flash: !!opciones.flash,
    sendDate: opciones.fecha || 'Now',
    campaignName: String(opciones.campana || 'BPM').slice(0, 60),
    messages: mensajes.map((m) => ({
      to: m.numero,
      text: m.texto,
      costCenter: opciones.centroCosto || 0,
      /* Nuestro identificador vuelve en el aviso de entrega: así se
         sabe a qué destinatario corresponde sin adivinar por número. */
      reference01: String(m.id),
    })),
  };
  if (opciones.remitente) cuerpo.from = opciones.remitente;

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        [CONFIG.sms.cabecera || 'X-Hablame-Key']: clave(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(cuerpo),
    });
  } catch (e) {
    return { error: 'No se pudo contactar al proveedor de SMS: ' + e.message };
  }

  let datos = null;
  try { datos = await r.json(); } catch { /* puede no traer cuerpo */ }

  if (!r.ok) {
    const detalle = datos ? JSON.stringify(datos).slice(0, 200) : '';
    return {
      error: r.status === 401 || r.status === 403
        ? 'El proveedor rechazó la credencial. Revisa la clave en el servidor.'
        : `El proveedor respondió ${r.status}. ${detalle}`,
    };
  }

  /* La respuesta trae un identificador por mensaje. La forma exacta
     puede variar, así que se busca con tolerancia y, si no aparece, el
     envío igual se da por hecho: el proveedor respondió bien. */
  const lista = datos?.payload?.messages || datos?.messages || datos?.payload || [];
  const referencias = {};
  if (Array.isArray(lista)) {
    lista.forEach((m, i) => {
      const id = m?.reference01 ?? m?.reference ?? mensajes[i]?.id;
      const ref = m?.messageId ?? m?.id ?? m?.smsId ?? null;
      if (id !== undefined && ref !== null) referencias[String(id)] = String(ref);
    });
  }

  return { enviados: mensajes.length, referencias, respuesta: datos };
}


/* ═══════════ PUNTO DE ENTRADA ═══════════ */

/**
 * Envía una lista de mensajes por lotes.
 * Nunca lanza: devuelve el detalle de qué lote falló para que quien
 * llame decida. Un fallo en el lote 3 no borra lo enviado en el 1 y 2.
 */
async function enviar(mensajes, opciones = {}) {
  if (!disponible()) {
    return { error: 'No hay proveedor de SMS configurado. Revisa SMS_PROVEEDOR y SMS_CLAVE.' };
  }
  if (!mensajes.length) return { error: 'No hay mensajes que enviar' };

  const motor = { hablame }[proveedor()];
  if (!motor) return { error: `Proveedor de SMS desconocido: ${proveedor()}` };

  let enviados = 0;
  const referencias = {};
  const fallos = [];

  for (let i = 0; i < mensajes.length; i += POR_LOTE) {
    const lote = mensajes.slice(i, i + POR_LOTE);
    const r = await motor(lote, opciones);

    if (r.error) {
      fallos.push({ desde: i + 1, hasta: i + lote.length, error: r.error });
      continue;
    }
    enviados += r.enviados;
    Object.assign(referencias, r.referencias || {});
  }

  return { enviados, referencias, fallos, total: mensajes.length };
}

module.exports = { enviar, disponible, proveedor, armarTexto, variablesDe, partes, POR_LOTE };
