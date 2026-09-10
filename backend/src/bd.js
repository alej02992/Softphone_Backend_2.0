/* ═══════════════════════════════════════════════════════════════════
   CONEXIÓN CON MySQL

   Se usa un "pool": un conjunto de conexiones abiertas que se
   reutilizan. Abrir una conexión nueva en cada consulta sería lento y
   con 60 agentes saturaría la base.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const mysql = require('mysql2/promise');
const CONFIG = require('./config');

const pool = mysql.createPool({
  host: CONFIG.bd.host,
  port: CONFIG.bd.puerto,
  user: CONFIG.bd.usuario,
  password: CONFIG.bd.clave,
  database: CONFIG.bd.base,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: 'local',
});

/* Consulta normal. SIEMPRE con parámetros (?), nunca concatenando
   texto: es lo que impide la inyección SQL. */
async function consultar(sql, parametros = []) {
  const [filas] = await pool.execute(sql, parametros);
  return filas;
}

/* Devuelve solo la primera fila, o null. */
async function una(sql, parametros = []) {
  const filas = await consultar(sql, parametros);
  return filas[0] || null;
}

/* Ejecuta varias operaciones como una sola unidad: o se hacen todas,
   o ninguna. Se usa cuando crear algo implica escribir en dos sitios,
   por ejemplo un usuario y su extensión. */
async function transaccion(fn) {
  const cx = await pool.getConnection();
  try {
    await cx.beginTransaction();
    const resultado = await fn(cx);
    await cx.commit();
    return resultado;
  } catch (e) {
    await cx.rollback();   // deshace todo lo hecho dentro
    throw e;
  } finally {
    cx.release();          // devuelve la conexión al pool
  }
}

async function probar() {
  const r = await una('SELECT VERSION() AS version');
  return r.version;
}

module.exports = { pool, consultar, una, transaccion, probar };
