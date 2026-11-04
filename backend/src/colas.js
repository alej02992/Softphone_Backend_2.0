/* ═══════════════════════════════════════════════════════════════════
   BPM CONSULTING · SINCRONIZADOR DE COLAS

   Mantiene a cada agente dentro de la cola de su campaña, para que le
   lleguen las llamadas que entran (desde un flujo IVR o un DID).

   No escucha eventos: cada pocos segundos compara

     lo que DEBERÍA haber   agentes con sesión abierta, en la cola de su
                            campaña, en pausa si tienen una pausa abierta
     lo que HAY             los miembros de cada cola, según Asterisk

   y corrige la diferencia: agrega, quita o pausa. Así se arregla solo:
   si se reinicia la central o este servidor, en la vuelta siguiente todo
   queda en su sitio, sin tocar el inicio de sesión ni las pausas.

   Solo toca a los miembros que agregó él mismo (los "dinámicos"). Si
   alguien configuró a mano un miembro fijo en una cola, no lo quita.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const bd = require('./bd');
const ami = require('./ami');

const CADA_MS = 10 * 1000;

let temporizador = null;
let trabajando = false;
let ultima = { momento: null, cambios: 0, error: null };

/** Quién debería estar en qué cola, y si en pausa. */
async function deseado() {
  /* Solo agentes: los supervisores tienen extensión para escuchar, pero
     no atienden llamadas. Igual que la marcación progresiva. */
  const filas = await bd.consultar(
    `SELECT u.id, u.nombre, u.extension, c.cola_asterisk AS cola,
            EXISTS(SELECT 1 FROM pausa p WHERE p.usuario_id = u.id AND p.fin IS NULL) AS en_pausa
       FROM sesion s
       JOIN usuario u ON u.id = s.usuario_id
       JOIN campana c ON c.id = u.campana_id
      WHERE s.cerrada IS NULL AND s.vence > NOW()
        AND u.activo = TRUE AND u.rol = 'agente'
        AND u.extension IS NOT NULL AND u.extension <> ''
        AND c.activa = TRUE AND c.cola_asterisk IS NOT NULL AND c.cola_asterisk <> ''
      GROUP BY u.id`);

  /* Clave: cola + interfaz. Un agente está en una sola cola, la suya. */
  const mapa = new Map();
  filas.forEach((f) => {
    const interfaz = `PJSIP/${f.extension}`;
    mapa.set(`${f.cola}|${interfaz}`, {
      cola: String(f.cola), interfaz, nombre: f.nombre, pausa: !!Number(f.en_pausa),
    });
  });
  return mapa;
}

/** Quién está de verdad, según la central. */
async function actual() {
  const miembros = await ami.listar({ Action: 'QueueStatus' }, 'QueueMember', 'QueueStatusComplete');
  const mapa = new Map();
  miembros.forEach((m) => {
    const interfaz = m.StateInterface || m.Location || m.Interface || '';
    if (!/^PJSIP\//.test(interfaz)) return;
    mapa.set(`${m.Queue}|${interfaz}`, {
      cola: String(m.Queue), interfaz,
      pausa: String(m.Paused) === '1',
      /* Solo los dinámicos son nuestros: los fijos y los de la base no se tocan */
      nuestro: String(m.Membership || '').toLowerCase() === 'dynamic',
    });
  });
  return mapa;
}

const ok = (r) => r && String(r.Response).toLowerCase() === 'success';

/** Una vuelta: compara y corrige. Devuelve cuántos cambios hizo. */
async function sincronizar() {
  if (trabajando) return 0;
  if (!ami.estado().conectado) return 0;
  trabajando = true;
  let cambios = 0;
  try {
    const quiero = await deseado();
    const hay = await actual();

    /* Los que faltan, o están pero con la pausa equivocada */
    for (const [clave, q] of quiero) {
      const h = hay.get(clave);
      if (!h) {
        const r = await ami.enviar({
          Action: 'QueueAdd', Queue: q.cola, Interface: q.interfaz, StateInterface: q.interfaz,
          MemberName: String(q.nombre || q.interfaz).replace(/[\r\n,]/g, ' ').slice(0, 60),
          Paused: q.pausa ? 'true' : 'false',
        });
        if (ok(r)) { cambios++; console.log(`  Colas            ${q.nombre} entra a ${q.cola}${q.pausa ? ' (en pausa)' : ''}`); }
      } else if (h.pausa !== q.pausa) {
        const r = await ami.enviar({
          Action: 'QueuePause', Queue: q.cola, Interface: q.interfaz,
          Paused: q.pausa ? 'true' : 'false', Reason: q.pausa ? 'Pausa en la plataforma' : '',
        });
        if (ok(r)) cambios++;
      }
    }

    /* Los que sobran: salieron, vencieron o cambiaron de campaña */
    for (const [clave, h] of hay) {
      if (quiero.has(clave) || !h.nuestro) continue;
      const r = await ami.enviar({ Action: 'QueueRemove', Queue: h.cola, Interface: h.interfaz });
      if (ok(r)) { cambios++; console.log(`  Colas            ${h.interfaz} sale de ${h.cola}`); }
    }

    ultima = { momento: new Date(), cambios, error: null };
  } catch (e) {
    ultima = { momento: new Date(), cambios, error: e.message };
  } finally {
    trabajando = false;
  }
  return cambios;
}

function arrancar() {
  if (temporizador) return;
  setTimeout(sincronizar, 3000);           // primera vuelta, ya con la central conectada
  temporizador = setInterval(sincronizar, CADA_MS);
  console.log('  Colas            sincronizador activo');
}

function detener() { clearInterval(temporizador); temporizador = null; }

module.exports = { arrancar, detener, sincronizar, estado: () => ({ ...ultima }) };