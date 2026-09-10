/* Prueba de integración: el servicio.js real del frontend contra el
   backend real, con MySQL detrás. Sin nada simulado. */
import fs from 'node:fs';

const FRONT = '/home/claude/bpm-plataforma/js/servicio.js';
const API = 'http://localhost:3001/api';

const R = [];
const ck = (n, c, x = '') => R.push([c ? 'OK  ' : 'FALLA', n, x]);

/* Entorno mínimo de navegador para cargar servicio.js tal cual */
global.CONFIG = { api: API, pbx: { wss:'', dominio:'', clave:'', ice:[] }, simulador: false };
global.sessionStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const src = fs.readFileSync(FRONT, 'utf8');
const servicio = eval(src + '; servicio');

(async () => {
  ck('El frontend detecta el backend', servicio.hayApi() === true);

  /* ── Autenticación ── */
  try {
    await servicio.autenticar('ana', 'clave-mala');
    ck('Rechaza contraseña incorrecta', false);
  } catch (e) {
    ck('Rechaza contraseña incorrecta', e.message.includes('incorrect'), e.message);
  }

  const ses = await servicio.autenticar('ana', 'demo1234');
  ck('Autentica contra MySQL', ses.nombre === 'Ana Rodríguez', ses.nombre);
  ck('Trae el rol de la base', ses.rol === 'agente', ses.rol);
  ck('Trae la extensión real', ses.extension === '1001', ses.extension);
  ck('Trae los permisos del rol', Array.isArray(ses.permisos) && ses.permisos.length > 0,
     ses.permisos.length + ' permisos');
  ck('Guardó el token', !!sessionStorage.getItem('bpm.token'));

  /* ── Credencial SIP ── */
  const cred = await servicio.credencialSip(ses);
  ck('El servidor emite la credencial SIP', !!cred.wss, cred.wss);
  ck('La credencial trae la extensión', cred.ext === '1001', cred.ext);
  ck('La credencial trae la clave', !!cred.clave);
  ck('La credencial tiene vencimiento', !!cred.vence || !!cred.venceEn);

  /* ── Ficha del contacto ── */
  const c = await servicio.contactoPorTelefono('3105558812');
  ck('Encuentra el contacto en MySQL', c?.nom?.includes('María'), c?.nom);
  ck('La ficha trae tipo de documento', !!c?.tipoDoc, c?.tipoDoc + ' ' + c?.doc);
  ck('La ficha trae correo', !!c?.cor, c?.cor);
  ck('La ficha trae teléfono secundario', !!c?.tel2, c?.tel2);
  ck('La ficha trae la descripción', !!c?.desc, String(c?.desc).slice(0, 40) + '…');

  const nada = await servicio.contactoPorTelefono('3000000000');
  ck('Devuelve null si el número no existe', nada === null);

  /* ── Catálogo de tipificación ── */
  const cat = await servicio.catalogoTipificacion('Ventas');
  const cats = Object.keys(cat);
  ck('Trae el catálogo desde MySQL', cats.length === 5, cats.join(', '));
  ck('Incluye Efectiva', cats.includes('Efectiva'));
  ck('Incluye Se cayó', cats.includes('Se cayó'));
  ck('Incluye Entró muda', cats.includes('Entró muda'));
  ck('Incluye Entró con falla', cats.includes('Entró con falla'));
  ck('Incluye Prueba técnica', cats.includes('Prueba técnica'));
  ck('Efectiva trae subcategorías', (cat['Efectiva'] || []).length === 3,
     (cat['Efectiva'] || []).join(', '));

  /* ── Pausas ── */
  const p1 = await servicio.registrarPausa('Almuerzo', true);
  ck('Registra el inicio de la pausa', p1.ok === true);
  const p2 = await servicio.registrarPausa(null, false);
  ck('Registra el fin de la pausa', p2.ok === true);

  /* ── Cierre de sesión ── */
  await servicio.cerrar();
  ck('Cierra sesión y borra el token', sessionStorage.getItem('bpm.token') === null);

  try {
    await servicio.contactoPorTelefono('3105558812');
    ck('Sin token, el backend ya no responde datos', true, '(devolvió null)');
  } catch (e) {
    ck('Sin token, el backend rechaza', true, e.message);
  }

  /* ── Supervisor y admin ── */
  const sup = await servicio.autenticar('sandra', 'demo1234');
  ck('El supervisor entra', sup.rol === 'supervisor', sup.rol);
  ck('El supervisor tiene más permisos', sup.permisos.length > ses.permisos.length,
     sup.permisos.length + ' vs ' + ses.permisos.length);
  await servicio.cerrar();

  const adm = await servicio.autenticar('admin', 'demo1234');
  ck('El administrador entra', adm.rol === 'admin', adm.rol);
  ck('El administrador tiene todos los permisos', adm.permisos.length >= sup.permisos.length,
     adm.permisos.length + ' permisos');

  console.log('\n' + '='.repeat(72));
  R.forEach(([e, n, x]) => console.log(` ${e} ${n}${x ? '  ·  ' + x : ''}`));
  const f = R.filter((x) => x[0] !== 'OK  ').length;
  console.log('='.repeat(72));
  console.log(`  ${R.length - f}/${R.length} pruebas de integración pasan`);
  process.exit(f ? 1 : 0);
})();
