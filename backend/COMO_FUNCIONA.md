# Backend y base de datos — Cómo funciona todo

Plataforma de Contact Center · BPM Consulting

Este documento explica qué hace cada pieza y por qué. Está escrito
asumiendo que es tu primer backend.

---

## 1. Las tres capas

```
NAVEGADOR          BACKEND              MySQL
(la plataforma) ──► (Node + Express) ──► (los datos)
```

**El navegador nunca habla con MySQL.** Si lo hiciera, cualquiera podría
abrir las herramientas del desarrollador, ver la contraseña de la base y
borrarla entera.

El backend es el intermediario: recibe la petición, comprueba quién la
hace y si tiene permiso, consulta la base y devuelve solo lo que
corresponde.

### Por qué Node.js

Tu frontend ya está en JavaScript. Con Node el backend usa el mismo
idioma, así que no tienes que aprender un lenguaje nuevo para esta
parte.

---

## 2. Los archivos

```
backend/
├── package.json          las librerías que usa el proyecto
├── .env                  las claves y direcciones (NO se sube al repo)
├── .env.ejemplo          plantilla del anterior
├── probar.js             las pruebas
└── src/
    ├── servidor.js       arranque y montaje de rutas
    ├── config.js         lee el .env en un solo sitio
    ├── bd.js             conexión con MySQL
    ├── auth.js           contraseñas, tokens y permisos
    ├── asterisk.js       creación de extensiones en la central
    └── rutas/
        ├── sesion.js     iniciar sesión y credencial SIP
        ├── usuarios.js   crear, editar y desactivar usuarios
        └── operacion.js  campañas, contactos, tipificación, pausas
```

### `.env` — lo que nunca se sube

Contiene la contraseña de la base, la clave que firma los tokens y las
direcciones de la central. **Nunca se sube al repositorio.** Por eso
existe `.env.ejemplo`: es la misma estructura sin los valores reales,
para que otro sepa qué necesita configurar.

### `config.js` — un solo sitio para la configuración

Lee el `.env` y lo deja disponible ordenado. Sin esto, cada archivo
leería `process.env` por su cuenta y acabarías con nombres distintos
para lo mismo.

> Ese error lo cometí construyendo esto: `bd.js` leía `BD_NOMBRE` y
> `config.js` leía `BD_BASE`. El servidor arrancaba pero todas las
> consultas fallaban con «No database selected». Centralizar la
> configuración evita justo eso.

### `bd.js` — hablar con MySQL

Tres funciones y un concepto.

**El pool.** Un conjunto de conexiones abiertas que se reutilizan. Abrir
una conexión nueva en cada consulta sería lento, y con 60 agentes
saturaría la base.

```js
consultar(sql, parametros)   // devuelve todas las filas
una(sql, parametros)         // devuelve la primera, o null
transaccion(fn)              // varias operaciones como una sola
```

**Los parámetros son obligatorios.** Nunca se pega un valor dentro del
texto de la consulta:

```js
// MAL — así te borran la base
`SELECT * FROM usuario WHERE usuario = '${nombre}'`

// BIEN
bd.una('SELECT * FROM usuario WHERE usuario = ?', [nombre])
```

Si alguien escribe como usuario `' OR '1'='1`, la primera forma lo
ejecuta como código. La segunda lo trata como texto. Se llama inyección
SQL y está probado en la batería de pruebas.

**La transacción.** Cuando una operación implica escribir en dos sitios
—por ejemplo crear un usuario y su extensión— las dos se hacen o
ninguna. Si la segunda falla, se deshace la primera. Si no, quedarían
usuarios sin extensión.

---

## 3. `auth.js` — la parte de seguridad

### Las contraseñas nunca se guardan

Se guarda el resultado de aplicarles **bcrypt**, que es irreversible:

```
demo1234  →  $2a$12$N9qo8uLOickgx2ZMRZoMye...
```

Al iniciar sesión se aplica lo mismo a lo que escribió el usuario y se
comparan los resultados. Si alguien roba la base, no obtiene las
contraseñas.

El `12` es el costo: cuántas veces se repite el cálculo. Más alto es más
seguro y más lento. Doce es el equilibrio habitual.

### El mismo mensaje para los dos errores

Si el usuario no existe y si la contraseña es incorrecta, la respuesta
es idéntica: «Usuario o contraseña incorrectos».

Decir cuál de los dos falló le indicaría a un atacante qué usuarios
existen, y con eso podría concentrarse en adivinar solo sus contraseñas.

Por la misma razón, cuando el usuario no existe se compara igualmente
contra un hash falso: para que la respuesta tarde lo mismo. Si no, el
tiempo revelaría la información que el mensaje oculta.

### El token

Al iniciar sesión se emite un **JWT**: un texto firmado que contiene
quién eres, tu rol y tus permisos. El navegador lo guarda y lo envía en
cada petición:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

Está **firmado**, no cifrado. Cualquiera puede leer su contenido, pero
nadie puede modificarlo sin la clave del servidor. Por eso nunca se
mete información secreta dentro.

Vence a las 8 horas: un turno.

### Los permisos se validan en el servidor

Esta es la regla que más se rompe.

Tu plataforma esconde las opciones según el rol. Eso está bien para la
experiencia del usuario, **pero no es seguridad**: cualquiera puede
abrir la consola y enviar la petición a mano.

Por eso cada ruta lleva su guarda:

```js
router.post('/', auth.exigir('usuarios'), async (req, res) => { ... })
```

Si un agente intenta crear un usuario, recibe un `403` aunque el botón
no exista en su pantalla. Está probado.

---

## 4. `rutas/` — lo que la plataforma puede pedir

Cada archivo agrupa operaciones relacionadas. La convención es la
misma en todas:

| Método | Significa | Ejemplo |
|---|---|---|
| `GET` | consultar | `GET /api/usuarios` |
| `POST` | crear | `POST /api/usuarios` |
| `PUT` | modificar | `PUT /api/usuarios/6` |
| `DELETE` | eliminar | `DELETE /api/usuarios/6` |

### `sesion.js`

```
POST   /api/sesion        iniciar sesión → token
POST   /api/sesion/sip    pedir la credencial de la central
GET    /api/sesion        ¿quién soy?
DELETE /api/sesion        cerrar sesión
```

La credencial SIP se pide **aparte** del inicio de sesión, a propósito:
así el token de sesión y la credencial de telefonía tienen ciclos de
vida independientes.

### `usuarios.js`

```
GET    /api/usuarios          listar
POST   /api/usuarios          crear
PUT    /api/usuarios/:id      modificar (incluye cambiar el rol)
PUT    /api/usuarios/:id/clave  cambiar contraseña
DELETE /api/usuarios/:id      desactivar
```

Fíjate en que `DELETE` **desactiva**, no borra. Si borraras al usuario,
perderías el historial de sus llamadas. Se marca `activo = FALSE` y deja
de poder entrar.

### `operacion.js`

```
GET  /api/campanas                     listar
POST /api/campanas                     crear
PUT  /api/campanas/:id/horario         abrir o cerrar
GET  /api/contactos/telefono/:numero   ← la ficha del cliente
GET  /api/contactos                    buscar
GET  /api/tipificacion                 catálogo de la campaña
POST /api/interacciones/:linkedid/tipificar
GET  /api/interacciones/mias           historial del agente
GET  /api/pausas/tipos
POST /api/pausas                       entrar o salir de pausa
```

La ruta de contacto por teléfono es la que se llama en **cada llamada
entrante**, y tiene que responder antes de que el agente conteste. Por
eso la tabla `contacto` tiene índice por `telefono`.

---

## 5. Cómo se conecta con la plataforma

Hoy `js/servicio.js` del frontend devuelve datos escritos a mano:

```js
async function autenticar(usuario, clave) {
  await demora(350);
  const u = USUARIOS.find(...);
  return { id: u.usuario, nombre: u.nombre, ... };
}
```

Con el backend, se reemplaza por:

```js
async function autenticar(usuario, clave) {
  const r = await fetch(API + '/sesion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  });
  if (!r.ok) throw new Error((await r.json()).error);
  const datos = await r.json();
  guardarToken(datos.token);
  return datos.usuario;
}
```

**Y nada más cambia.** Ni `telefonia.js`, ni `pantalla.js`, ni las
pantallas. El contrato ya estaba escrito en la cabecera de
`servicio.js`; el backend lo cumple.

---

## 6. El flujo completo de una operación

Crear un usuario, paso a paso:

1. El administrador llena el formulario y pulsa Guardar.
2. El navegador envía `POST /api/usuarios` con el token en la cabecera.
3. El backend verifica el token: ¿es válido? ¿no venció?
4. Comprueba el permiso `usuarios`. Si no lo tiene, `403`.
5. Valida los datos: campos obligatorios, longitud de la contraseña.
6. Comprueba que el usuario y la extensión no existan ya.
7. Cifra la contraseña con bcrypt.
8. Abre una transacción.
9. Inserta en `usuario`.
10. Crea la extensión en la central (ver sección 7).
11. Registra la acción en `auditoria`.
12. Confirma la transacción y responde con el `id`.

Si algo falla entre el 8 y el 12, se deshace todo.

---

## 7. Realtime y VitalPBX — la respuesta a tu pregunta

Preguntaste dónde se implementa Realtime: si se programa en el backend,
si viene con MySQL o si se configura en VitalPBX.

**La respuesta corta: se configura en Asterisk, no se programa. Pero con
VitalPBX no deberías usarlo.**

### Qué es Realtime

Asterisk normalmente lee su configuración de archivos de texto
(`pjsip.conf`). Con Realtime, la lee de **tablas de MySQL**
(`ps_endpoints`, `ps_auths`, `ps_aors`).

Eso permitiría que tu backend cree una extensión con un `INSERT`, y
Asterisk la vería de inmediato sin recargar nada.

No se programa: se activa en la configuración de Asterisk, al
instalarlo.

### Por qué con VitalPBX es problemático

**VitalPBX ya tiene su propia base de datos y su propia capa de
gestión.** Cuando creas una extensión desde su interfaz, VitalPBX
escribe en sus tablas y genera la configuración de Asterisk.

Si tu backend escribiera directamente en las tablas de Asterisk:

- VitalPBX no se enteraría, y su interfaz mostraría algo distinto de lo
  que hay realmente.
- Al aplicar cualquier cambio desde su interfaz, VitalPBX regeneraría la
  configuración y **borraría lo que tú escribiste**.
- Podrías romper el soporte y las actualizaciones.

### La vía correcta: la API de VitalPBX

VitalPBX 4 expone una **API REST**. Tu backend le pide que cree la
extensión, y VitalPBX la crea por los medios que él controla.

```
Tu backend  ──►  API de VitalPBX  ──►  Asterisk
```

Eso mantiene una sola fuente de verdad. Está en la documentación de
VitalPBX, en la sección **API and AMI**.

El archivo `src/asterisk.js` ya está preparado para esto: tiene el punto
donde va esa llamada. Mientras `VITALPBX_URL` esté vacío en el `.env`,
no intenta crear nada y devuelve `extensionCreada: false`. Se ve en la
salida de las pruebas.

### Qué hacer entonces

**Ahora, para desarrollar:** crea las extensiones a mano en la interfaz
de VitalPBX, y en tu base pon el mismo número en `usuario.extension`.
Funciona perfectamente para probar.

**Después:** pide en VitalPBX una **API Key** (`Admin → API`) y
complétala en el `.env`. Ahí `asterisk.js` empieza a crear las
extensiones solo.

**Realtime crudo solo tendría sentido** si algún día montaran un
Asterisk limpio sin VitalPBX, que es justamente lo que se planteó en una
reunión. Si eso ocurre, se activa al instalarlo.

---

## 8. Cómo ponerlo a funcionar

### Instalar

```bash
cd backend
npm install
copy .env.ejemplo .env      # en Linux: cp
```

Edita `.env` con los datos de tu MySQL.

### Crear el usuario de la aplicación

No uses `root` desde el backend:

```sql
CREATE USER 'bpm_app'@'localhost' IDENTIFIED BY 'una-clave-larga';
GRANT SELECT, INSERT, UPDATE, DELETE ON bpm_contact.* TO 'bpm_app'@'localhost';
FLUSH PRIVILEGES;
```

Ese usuario puede leer y escribir datos pero **no puede borrar tablas**.
Si el backend tiene un fallo, el daño posible es mucho menor.

### Arrancar

```bash
npm start
```

Debe mostrar la versión de la base, la central configurada y el puerto.

### Comprobar

```bash
node probar.js
```

Ejecuta 39 pruebas contra la base real: autenticación, permisos,
creación de usuarios, cambio de rol, inyección SQL y las rutas de
operación.

---

## 9. Lo que falta

**Contraseñas SIP por extensión.** Hoy la credencial usa una clave
generada o la fija del `.env`. Con la API de VitalPBX, cada extensión
tendrá la suya.

**Eventos en vivo.** El panel de supervisión necesita saber qué pasa en
la central en tiempo real. Eso se hace escuchando el **AMI** de Asterisk
y reenviando por WebSocket al navegador. Es el siguiente módulo.

**Registro de llamadas.** Falta el proceso que escucha el AMI y guarda
cada llamada en `interaccion` y `tramo`, agrupando por `linkedid`.

**HTTPS.** En producción el backend debe ir detrás de un proxy con
certificado. En desarrollo, HTTP local es suficiente.

---

## Anexo: verificación

Todo lo descrito fue ejecutado contra MariaDB 10.11 real:

- El esquema crea 18 tablas sin errores.
- El backend arranca y se conecta.
- 39 pruebas pasan: autenticación, permisos por rol, creación y
  modificación de usuarios, cambio de rol reflejado en los permisos,
  credencial SIP con vencimiento, resistencia a inyección SQL, y las
  rutas de campañas, contactos, tipificación y pausas.
