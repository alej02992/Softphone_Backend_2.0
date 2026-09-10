#!/usr/bin/env node
/* Pruebas del backend contra la base real */
'use strict';

const API = 'http://localhost:3001/api';
const R = [];
const ck = (n, c, x = '') => R.push([c ? 'OK  ' : 'FALLA', n, x]);

async function pedir(metodo, ruta, cuerpo, token) {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let datos = null;
  try { datos = await r.json(); } catch (_) {}
  return { estado: r.status, datos };
}

(async () => {
  // ═══ 1. SALUD ═══
  let r = await pedir('GET', '/salud');
  ck('Responde el chequeo de salud', r.estado === 200, JSON.stringify(r.datos).slice(0, 60));

  // ═══ 2. AUTENTICACIÓN ═══
  r = await pedir('POST', '/sesion', { usuario: 'ana', clave: 'malaclave' });
  ck('Rechaza contraseña incorrecta', r.estado === 401, r.datos?.error);

  r = await pedir('POST', '/sesion', { usuario: 'noexiste', clave: 'x' });
  ck('Rechaza usuario inexistente', r.estado === 401);
  ck('Mismo mensaje en ambos casos', r.datos?.error?.includes('incorrect'), r.datos?.error);

  r = await pedir('POST', '/sesion', { usuario: 'ana', clave: 'demo1234' });
  ck('Inicia sesión con credenciales válidas', r.estado === 200);
  const tokenAna = r.datos?.token;
  ck('Devuelve un token', !!tokenAna);
  ck('Devuelve la extensión del usuario', r.datos?.usuario?.extension === '1001',
     r.datos?.usuario?.extension);
  ck('Devuelve los permisos del rol', Array.isArray(r.datos?.usuario?.permisos) &&
     r.datos.usuario.permisos.length === 5, (r.datos?.usuario?.permisos || []).length + ' permisos');
  ck('NUNCA devuelve el hash de la clave', !JSON.stringify(r.datos).includes('clave_hash'));

  // ═══ 3. CREDENCIAL SIP ═══
  r = await pedir('POST', '/sesion/sip', {}, tokenAna);
  ck('Entrega la credencial SIP', r.estado === 200);
  ck('La credencial trae el servidor', String(r.datos?.wss || '').startsWith('wss://'), r.datos?.wss);
  ck('La extensión coincide con el usuario', r.datos?.extension === '1001', r.datos?.extension);
  ck('La credencial tiene vencimiento', !!r.datos?.vence, r.datos?.vence);
  ck('La credencial trae una clave SIP', (r.datos?.clave || '').length > 0,
     (r.datos?.clave || '').length + ' caracteres');

  // ═══ 4. PERMISOS ═══
  r = await pedir('GET', '/usuarios', null, tokenAna);
  ck('Un agente NO puede listar usuarios', r.estado === 403, r.datos?.error);

  r = await pedir('POST', '/usuarios',
    { usuario: 'pirata', nombre: 'Intruso', clave: 'x', rol_id: 3, extension: '9999' }, tokenAna);
  ck('Un agente NO puede crear usuarios', r.estado === 403);

  r = await pedir('GET', '/usuarios');
  ck('Sin token no se puede entrar', r.estado === 401, r.datos?.error);

  r = await pedir('GET', '/usuarios', null, 'token.falso.inventado');
  ck('Un token inválido se rechaza', r.estado === 401);

  // ═══ 5. ADMINISTRADOR ═══
  r = await pedir('POST', '/sesion', { usuario: 'admin', clave: 'demo1234' });
  const tokenAdmin = r.datos?.token;
  ck('El administrador inicia sesión', !!tokenAdmin);
  ck('El administrador tiene todos los permisos',
     r.datos?.usuario?.permisos?.length === 11, r.datos?.usuario?.permisos?.length + ' permisos');

  r = await pedir('GET', '/usuarios', null, tokenAdmin);
  ck('El administrador SÍ lista usuarios', r.estado === 200 && r.datos?.length === 5,
     (r.datos?.length ?? '?') + ' usuarios');

  // ═══ 6. CREAR UN USUARIO ═══
  r = await pedir('POST', '/usuarios', {
    usuario: 'carlos', nombre: 'Carlos Prueba', correo: 'carlos@bpm.com',
    clave: 'clave-inicial-123', rol_id: 1, campana_id: 1, extension: '4055',
  }, tokenAdmin);
  ck('Crea un usuario nuevo', r.estado === 200 || r.estado === 201, JSON.stringify(r.datos).slice(0, 70));
  const nuevoId = r.datos?.id;

  r = await pedir('POST', '/usuarios', {
    usuario: 'carlos2', nombre: 'Otro', clave: 'x123456', rol_id: 1, extension: '4055',
  }, tokenAdmin);
  ck('Impide repetir la extensión', r.estado >= 400, r.datos?.error);

  r = await pedir('POST', '/usuarios', {
    usuario: 'carlos', nombre: 'Duplicado', clave: 'x123456', rol_id: 1, extension: '4066',
  }, tokenAdmin);
  ck('Impide repetir el usuario', r.estado >= 400, r.datos?.error);

  r = await pedir('POST', '/usuarios', { usuario: 'incompleto' }, tokenAdmin);
  ck('Valida los campos obligatorios', r.estado === 400, r.datos?.error);

  // El usuario nuevo puede entrar
  r = await pedir('POST', '/sesion', { usuario: 'carlos', clave: 'clave-inicial-123' });
  ck('El usuario nuevo puede iniciar sesión', r.estado === 200);
  ck('Y trae su extensión', r.datos?.usuario?.extension === '4055', r.datos?.usuario?.extension);

  // ═══ 7. CAMBIO DE ROL ═══
  r = await pedir('PUT', '/usuarios/' + nuevoId, { rol_id: 2 }, tokenAdmin);
  ck('Cambia el rol de un usuario', r.estado === 200, JSON.stringify(r.datos).slice(0, 50));

  r = await pedir('POST', '/sesion', { usuario: 'carlos', clave: 'clave-inicial-123' });
  ck('El cambio de rol se refleja al entrar', r.datos?.usuario?.rol === 'supervisor',
     r.datos?.usuario?.rol);
  ck('Y con más permisos que antes', r.datos?.usuario?.permisos?.length === 8,
     r.datos?.usuario?.permisos?.length + ' permisos');

  // ═══ 8. OPERACIÓN ═══
  r = await pedir('GET', '/campanas', null, tokenAna);
  ck('Lista las campañas', r.estado === 200 && r.datos?.length === 4,
     (r.datos?.length ?? '?') + ' campañas');

  r = await pedir('GET', '/contactos/telefono/3105558812', null, tokenAna);
  ck('Encuentra el contacto por teléfono',
     r.datos?.nom?.includes('María'), r.datos?.nom);
  ck('Devuelve los campos de la ficha del agente',
     !!r.datos?.tipoDoc && !!r.datos?.cor && !!r.datos?.tel2 && !!r.datos?.desc,
     `${r.datos?.tipoDoc} ${r.datos?.doc} · ${r.datos?.cor} · ${r.datos?.tel2}`);

  r = await pedir('GET', '/contactos/telefono/3000000000', null, tokenAna);
  ck('Informa cuando el número no existe', r.estado === 404 || r.datos === null, r.estado + '');

  r = await pedir('GET', '/tipificacion', null, tokenAna);
  ck('Trae el catálogo de tipificación', Array.isArray(r.datos) && r.datos.length > 0,
     (r.datos?.length ?? '?') + ' opciones');

  r = await pedir('GET', '/pausas/tipos', null, tokenAna);
  ck('Trae los tipos de pausa', r.datos?.length === 4, (r.datos?.length ?? '?') + ' tipos');

  r = await pedir('POST', '/pausas', { tipo_id: 2 }, tokenAna);
  ck('Registra el inicio de una pausa', r.estado === 200 || r.estado === 201,
     JSON.stringify(r.datos).slice(0, 50));

  // ═══ 9. INYECCIÓN SQL ═══
  r = await pedir('POST', '/sesion',
    { usuario: "ana' OR '1'='1", clave: 'cualquiera' });
  ck('Resiste un intento de inyección SQL', r.estado === 401, r.datos?.error);

  r = await pedir('GET', '/usuarios', null, tokenAdmin);
  ck('La tabla sigue intacta tras el intento', r.datos?.length === 6,
     (r.datos?.length ?? '?') + ' usuarios');

  // ═══ 10. CIERRE DE SESIÓN ═══
  r = await pedir('DELETE', '/sesion', null, tokenAna);
  ck('Cierra la sesión', r.estado === 200);

  // ═══ RESULTADO ═══
  console.log('\n' + '='.repeat(72));
  R.forEach(([e, n, x]) => console.log(` ${e} ${n}${x ? '  ·  ' + x : ''}`));
  const f = R.filter((x) => x[0] !== 'OK  ').length;
  console.log('='.repeat(72));
  console.log(`  ${R.length - f}/${R.length} pruebas pasan`);
  process.exit(f ? 1 : 0);
})();
