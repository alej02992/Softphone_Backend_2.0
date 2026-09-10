# Base de datos — Guía desde cero

Para la plataforma de Contact Center de BPM Consulting.

Está escrita asumiendo que no has trabajado con bases de datos antes.
Si algo ya lo sabes, sáltatelo.

---

## 1. Qué es y por qué la necesitas

Hoy los datos de la plataforma viven en `js/servicio.js`: usuarios,
contactos, campañas. Están escritos a mano dentro del código.

Eso tiene tres problemas:

- **Se pierden.** Al recargar la página, el historial desaparece.
- **No se comparten.** Lo que ve Ana no lo ve Sandra.
- **Hay que tocar código** para agregar un contacto.

Una base de datos es un programa aparte que guarda información de forma
permanente y organizada, y varios programas pueden consultarla a la vez.

**MySQL** y **MariaDB** son ese programa. MariaDB nació como una copia
de MySQL y son prácticamente iguales: lo que funciona en uno funciona en
el otro. VitalPBX ya trae MariaDB instalado.

---

## 2. Vocabulario mínimo

| Término | Qué es | Ejemplo en el proyecto |
|---|---|---|
| **Base de datos** | El contenedor de todo | `bpm_contact` |
| **Tabla** | Una hoja de cálculo con estructura fija | `usuario`, `campana` |
| **Columna** | Un dato de cada fila | `nombre`, `extension` |
| **Fila** | Un registro | Ana Rodríguez, ext. 4021 |
| **Clave primaria** | El identificador único de la fila | `id` |
| **Clave foránea** | Un enlace a otra tabla | `usuario.campana_id` → `campana.id` |
| **Índice** | Un atajo para buscar rápido | por `telefono` en contactos |
| **Consulta** | Una pregunta a la base | «dame los agentes de Ventas» |
| **SQL** | El idioma para hacer preguntas | `SELECT * FROM usuario` |

### Las claves foráneas, con un ejemplo

En la tabla `usuario` hay una columna `campana_id`. Si Ana tiene
`campana_id = 1`, y en la tabla `campana` la fila con `id = 1` es
«Ventas», entonces Ana es de Ventas.

No se repite el texto «Ventas» en cada agente: se guarda una vez y se
apunta a ella. Así, si se renombra la campaña, cambia en un solo sitio.

Además la base **impide** poner un `campana_id` que no existe. Eso evita
datos huérfanos.

---

## 3. Instalar MySQL

### Dónde instalarlo

La reunión definió que la base va en el servidor. Tienes dos opciones:

**En el servidor de VitalPBX** — ya tiene MariaDB. Es lo más rápido,
pero mezcla la base de la plataforma con la de la central. Si algún día
hay que reinstalar VitalPBX, hay que sacar los datos antes.

**En un servidor aparte** — más limpio y es lo recomendable para
producción.

**Para aprender y desarrollar, instálalo en tu equipo.** Así puedes
romper cosas sin consecuencias. Es lo que te recomiendo empezar hoy.

### En Windows

Descarga **MySQL Installer** de `dev.mysql.com/downloads/installer`.
Elige la opción *Developer Default*.

Durante la instalación te pide una contraseña para el usuario `root`.
**Anótala**, la vas a necesitar siempre.

Alternativa más ligera: **XAMPP** (`apachefriends.org`), que trae MariaDB
y phpMyAdmin juntos. Para aprender es más cómodo porque incluye una
interfaz visual.

### Verificar que quedó

Abre la terminal:

```
mysql -u root -p
```

Te pide la contraseña y entras a un intérprete donde escribes SQL.
Para salir: `exit`

---

## 4. Crear la base de datos

Con el archivo `esquema.sql` que acompaña a esta guía:

```
mysql -u root -p < esquema.sql
```

Eso crea la base `bpm_contact`, sus 18 tablas y datos de ejemplo.

Verifica:

```
mysql -u root -p -e "USE bpm_contact; SHOW TABLES;"
```

Deben aparecer 18 tablas.

> **Cuidado:** el script empieza con `DROP DATABASE IF EXISTS`, que borra
> todo si ya existía. Está bien mientras aprendes; **nunca lo ejecutes
> sobre datos reales**.

---

## 5. Las tablas, por grupos

### Personas y acceso

**`rol`** — los tres perfiles: agente, supervisor, admin.

**`permiso`** — cada acción posible: `softphone`, `reportes`, `usuarios`…

**`rol_permiso`** — qué permisos tiene cada rol.

Esta última es la que hace que cambiar el rol de una persona cambie lo
que ve, sin tocar código. Es exactamente lo que ya hace el menú de la
plataforma, pero leyéndolo de la base.

**`usuario`** — las personas. Cada una con su extensión, **única**: dos
personas no pueden compartirla. Es el requisito de la reunión.

La contraseña se guarda en `clave_hash`, **nunca en texto claro**. Se
guarda el resultado de una función que transforma la contraseña en algo
irreversible. Al iniciar sesión se aplica la misma función y se comparan
los resultados. Si alguien roba la base, no obtiene las contraseñas.

**`sesion`** — las credenciales SIP temporales. Se crea una al iniciar
sesión, con su vencimiento, y se marca cerrada al salir.

### Operación

**`campana`** — la unidad de organización. Aquí está el campo más
importante de todo el esquema:

```sql
cola_asterisk VARCHAR(80) UNIQUE
```

Es el **puente con Asterisk**. Guarda el nombre exacto de la cola. De
ahí sale qué catálogo de tipificación ve el agente y en qué panel de
supervisión aparece la llamada. Sin este campo, la plataforma no sabe a
qué campaña pertenece una llamada.

**`usuario_campana`** — un supervisor puede tener varias campañas.

**`pausa_tipo`** y **`pausa`** — baño, almuerzo, break y
retroalimentación, con su registro histórico.

### Contactos

**`contacto`** — los clientes.

Fíjate en esta línea:

```sql
INDEX idx_contacto_telefono (telefono)
```

Ese índice es **crítico**. En cada llamada entrante hay que buscar el
número y mostrar la ficha **antes** de que el agente conteste. Sin
índice, la base recorre toda la tabla; con índice, va directo. Con mil
contactos no se nota, con un millón sí.

### Telefonía: la parte que más se equivoca

Aquí hay dos tablas y entender la diferencia es lo más importante de
esta guía.

**`interaccion`** es la gestión completa con un cliente.
**`tramo`** es el paso de esa llamada por un agente.

¿Por qué separarlas? Porque **una llamada transferida genera varios
canales en Asterisk**. Si guardas cada canal como una llamada, los
reportes salen inflados y el historial del cliente se ve fragmentado.

La solución es el campo:

```sql
linkedid VARCHAR(64) NOT NULL UNIQUE
```

Asterisk asigna el mismo `linkedid` a todos los canales de una misma
llamada, incluidas las patas de una transferencia. Al ser único, agrupa
los tramos automáticamente.

Ejemplo real, ya probado contra la base:

> Entra una llamada de María Fernanda. La atiende Ana 172 segundos y la
> transfiere a Sandra, que habla 206 segundos más.
>
> **Una** interacción de 390 segundos, con **dos** tramos.
>
> En el historial del cliente sale una gestión, no dos. Y en el reporte
> de productividad, cada agente tiene su tiempo.

### Formularios

Cuatro tablas: **`formulario`**, **`formulario_campo`** (los campos con
su tipo), **`formulario_respuesta`** (una por vez que se llena) y
**`formulario_valor`** (el contenido de cada campo).

En `formulario_respuesta` hay dos fechas distintas:

- `creada` — cuándo lo llenó el agente
- `recibida` — cuándo llegó al servidor

**Pueden diferir mucho.** Si el agente lo llena sin conexión, queda en
la cola del navegador y llega después. Guardar las dos permite saber qué
pasó de verdad.

### Auditoría

**`auditoria`** — quién hizo qué y cuándo. Cada creación, modificación o
eliminación deja rastro.

---

## 6. Aprender a consultar

Entra a la base:

```
mysql -u root -p bpm_contact
```

### Ver una tabla completa

```sql
SELECT * FROM usuario;
```

El `*` significa «todas las columnas». Termina siempre con `;`

### Elegir columnas y filtrar

```sql
SELECT nombre, extension FROM usuario WHERE activo = TRUE;
```

### Unir dos tablas

Esta es la operación que más vas a usar. Los agentes tienen
`campana_id`, pero tú quieres ver el nombre de la campaña:

```sql
SELECT u.nombre, u.extension, c.nombre AS campana
FROM usuario u
JOIN campana c ON c.id = u.campana_id;
```

Lo que dice: «trae usuarios, y para cada uno busca en `campana` la fila
cuyo `id` coincida con su `campana_id`».

Las letras `u` y `c` son apodos para no repetir el nombre completo.

### Contar y agrupar

```sql
SELECT c.nombre AS campana, COUNT(u.id) AS agentes
FROM campana c
LEFT JOIN usuario u ON u.campana_id = c.id
GROUP BY c.id;
```

`GROUP BY` agrupa las filas y `COUNT` cuenta cuántas hay en cada grupo.

El `LEFT JOIN` incluye las campañas aunque no tengan agentes. Con `JOIN`
normal esas campañas no aparecerían.

### Una consulta de verdad: el reporte de productividad

```sql
SELECT u.nombre AS agente,
       COUNT(t.id) AS llamadas,
       SUM(t.segundos) AS segundos_hablados,
       ROUND(AVG(t.segundos)) AS promedio
FROM tramo t
JOIN usuario u ON u.id = t.usuario_id
WHERE DATE(t.inicio) = CURDATE()
GROUP BY u.id
ORDER BY llamadas DESC;
```

Eso es exactamente el reporte que hoy la plataforma genera con datos
inventados.

---

## 7. Cómo se conecta con la plataforma

**El navegador nunca habla directamente con la base de datos.** Sería un
agujero de seguridad enorme: cualquiera podría leerla o borrarla.

En el medio va el **backend**:

```
Navegador  ──HTTPS──►  Backend  ──►  MySQL
```

El backend recibe la petición, valida quién la hace, consulta la base y
devuelve solo lo que corresponda.

En la plataforma actual, `js/servicio.js` ya está escrito con esa forma:

```js
async function autenticar(usuario, clave) { ... }
async function credencialSip(sesion) { ... }
```

Hoy devuelven datos escritos a mano. Cuando exista el backend se
reemplazan por llamadas HTTP y **nada más cambia**. El contrato está en
la cabecera de ese archivo.

---

## 8. Cosas que conviene hacer desde el principio

**Un usuario propio para la aplicación.** No uses `root` desde el
backend:

```sql
CREATE USER 'bpm_app'@'localhost' IDENTIFIED BY 'una-clave-larga';
GRANT SELECT, INSERT, UPDATE, DELETE ON bpm_contact.* TO 'bpm_app'@'localhost';
FLUSH PRIVILEGES;
```

Ese usuario puede leer y escribir datos, pero **no puede borrar tablas**.
Si el backend tiene un fallo, el daño posible es mucho menor.

**Respaldos.** Un comando:

```
mysqldump -u root -p bpm_contact > respaldo_2026-09-01.sql
```

Y para restaurar:

```
mysql -u root -p bpm_contact < respaldo_2026-09-01.sql
```

Hazlo antes de cada cambio grande. Y en producción, programado a diario.

**Nunca ejecutes el esquema sobre datos reales.** Empieza con
`DROP DATABASE`.

---

## 9. Lo que sigue

1. **Instalar MySQL** en tu equipo y ejecutar `esquema.sql`.
2. **Practicar consultas** con los datos de ejemplo. Prueba las de la
   sección 6 y modifícalas.
3. **Decidir dónde vivirá en el servidor** y pedirlo a infraestructura.
4. **Empezar el backend**, que es lo que conecta las dos partes.

Sobre el punto 4: la reunión dejó el backend para el final, pero pedir
conexión SIP automática lo adelanta. Alguien tiene que autenticar al
agente y generar la credencial temporal, y eso no se puede hacer desde
el navegador.

---

## Anexo: verificación de este esquema

El archivo `esquema.sql` fue ejecutado contra MariaDB 10.11 sin errores.
Se verificó que:

- Las 18 tablas se crean con sus claves e índices.
- Los datos de ejemplo cargan correctamente.
- Una llamada transferida se registra como **una** interacción con
  **dos** tramos.
- Los permisos por rol devuelven el conjunto correcto.
- La búsqueda de contacto por teléfono usa el índice.
