# Backend — Plataforma de Contact Center

API que conecta la plataforma web con MySQL y con Asterisk.

---

## Arrancar

**1. Instalar las dependencias**

```bash
npm install
```

**2. Crear la base de datos**

```bash
mysql -u root -p --default-character-set=utf8mb4 < ../bd/esquema.sql
```

El `--default-character-set` es importante: sin él los acentos se
guardan corrompidos y «Rodríguez» se convierte en «RodrÃ­guez».

**3. Crear el usuario de la aplicación**

```sql
CREATE USER 'bpm_app'@'localhost' IDENTIFIED BY 'una-clave-larga';
GRANT SELECT, INSERT, UPDATE, DELETE ON bpm_contact.* TO 'bpm_app'@'localhost';
FLUSH PRIVILEGES;
```

Fíjate en lo que **no** se concede: `DROP`, `CREATE`, `ALTER`. Si el
backend tiene un fallo, no puede borrar tablas.

**4. Configurar el entorno**

Copia `.env.ejemplo` a `.env` y complétalo:

```
BD_USUARIO=bpm_app
BD_CLAVE=la-clave-que-pusiste
JWT_CLAVE=genera-una-con-openssl-rand-base64-48
PBX_WSS=wss://vitalpbx.bpmconsulting.com.co:8089/ws
PBX_DOMINIO=vitalpbx.bpmconsulting.com.co
REALTIME=false
```

> El archivo `.env` **nunca** se sube al repositorio. Contiene
> contraseñas. Por eso existe el `.env.ejemplo`, que sí se sube y sirve
> de plantilla.

**5. Arrancar**

```bash
npm start
```

Comprueba que responde:

```bash
curl http://localhost:3001/api/salud
```

---

## Usuarios de prueba

Contraseña de todos: **`demo1234`**

| Usuario | Rol | Extensión |
|---|---|---|
| `ana` | agente | 4021 |
| `pedro` | agente | 4022 |
| `lucia` | agente | 4033 |
| `sandra` | supervisor | 4100 |
| `admin` | superadministrador | 4001 |

---

## Archivos

```
backend/
├── src/
│   ├── servidor.js       arranque y unión de las piezas
│   ├── config.js         lee el .env
│   ├── bd.js             conexión a MySQL
│   ├── auth.js           sesiones y permisos
│   ├── asterisk.js       escritura en las tablas Realtime
│   └── rutas/
│       ├── sesion.js     login, credencial SIP, logout
│       ├── usuarios.js   administración de usuarios
│       └── operacion.js  campañas, contactos, tipificación, pausas
├── .env                  tu configuración (NO se sube)
├── .env.ejemplo          plantilla (sí se sube)
└── package.json
```

---

## Las rutas

### Sesión

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/sesion` | Iniciar sesión. Devuelve token y permisos. |
| `GET` | `/api/sesion` | Quién soy. Para recuperar la sesión al recargar. |
| `POST` | `/api/sesion/sip` | Credencial de telefonía temporal. |
| `DELETE` | `/api/sesion` | Cerrar sesión e invalidar la credencial. |

### Usuarios (requiere permiso `usuarios`)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/usuarios` | Listar |
| `POST` | `/api/usuarios` | Crear, con su extensión |
| `PUT` | `/api/usuarios/:id` | Modificar, incluido el rol |
| `PUT` | `/api/usuarios/:id/clave` | Cambiar contraseña |
| `DELETE` | `/api/usuarios/:id` | Desactivar (no borra) |

### Operación

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/campanas` | Listar campañas |
| `POST` | `/api/campanas` | Crear campaña |
| `PUT` | `/api/campanas/:id/horario` | Abrir o cerrar |
| `GET` | `/api/contactos?buscar=` | Buscar en el directorio |
| `GET` | `/api/contactos/telefono/:numero` | **La ficha del cliente** |
| `GET` | `/api/tipificacion` | Catálogo de la campaña |
| `POST` | `/api/interacciones/:linkedid/tipificar` | Guardar la gestión |
| `GET` | `/api/interacciones/mias` | Historial del turno |
| `GET` | `/api/pausas/tipos` | Motivos de pausa |
| `POST` | `/api/pausas` | Entrar o salir de pausa |

---

## Cómo se usa desde el navegador

**Iniciar sesión y guardar el token:**

```js
const r = await fetch('http://localhost:3001/api/sesion', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ usuario: 'ana', clave: 'demo1234' }),
});
const { token, usuario } = await r.json();
```

**Enviar el token en las siguientes peticiones:**

```js
const r = await fetch('http://localhost:3001/api/contactos/telefono/3105558812', {
  headers: { Authorization: 'Bearer ' + token },
});
```

Eso es lo que va a reemplazar el interior de `js/servicio.js` en el
frontend. El contrato ya coincide.

---

## Realtime

El interruptor `REALTIME` del `.env` decide si el backend crea también
la extensión en Asterisk al crear un usuario.

- **`false`** — solo crea el usuario en la plataforma. La extensión hay
  que crearla a mano en VitalPBX. Es lo correcto mientras Asterisk no
  esté en modo Realtime.
- **`true`** — escribe además en `ps_endpoints`, `ps_auths` y `ps_aors`.
  Requiere que Asterisk esté configurado para leer de MySQL.

**Realtime no se programa, se configura en Asterisk.** Este backend solo
escribe filas en las tablas que Asterisk ya está leyendo. Si Asterisk no
está en ese modo, las filas se quedan ahí sin efecto.

---

## Seguridad

Lo que ya está resuelto:

- **Contraseñas con bcrypt.** Nunca se guardan en texto claro.
- **Consultas parametrizadas.** Los valores nunca se pegan dentro del
  texto SQL, lo que evita la inyección.
- **Permisos validados en el servidor.** Que el menú del navegador
  esconda una opción no es seguridad.
- **Sesiones revocables.** Cerrar sesión invalida el token aunque no
  haya vencido.
- **Mensaje genérico al fallar el login.** No revela si el usuario
  existe.
- **Auditoría.** Cada creación o modificación deja rastro.

Lo que falta antes de producción:

- **HTTPS.** Hoy el token viaja en claro si no hay TLS.
- **Límite de intentos** de inicio de sesión.
- **Rotación de la clave JWT.**
- **Respaldos automáticos** de la base.

---

## Verificación

Este backend fue probado contra MariaDB 10.11 con 23 pruebas que cubren:
inicio de sesión correcto e incorrecto, credencial SIP, búsqueda de
contacto, rechazo por falta de permisos, rechazo sin token y con token
falso, creación de usuarios, validaciones, cambio de rol y cierre de
sesión.
