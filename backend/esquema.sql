-- ═══════════════════════════════════════════════════════════════════
-- BPM CONSULTING — PLATAFORMA DE CONTACT CENTER
-- Esquema de base de datos · MySQL / MariaDB
-- ═══════════════════════════════════════════════════════════════════
--
-- CÓMO EJECUTARLO
--   mysql -u root -p --default-character-set=utf8mb4 < esquema.sql
--
--   El --default-character-set es importante: sin él, los acentos
--   pueden guardarse corrompidos.
--
-- Crea la base, las tablas y unos datos de ejemplo para poder probar.
-- Si se ejecuta dos veces, borra y vuelve a crear todo: no usarlo en
-- producción una vez que haya datos reales.
-- ═══════════════════════════════════════════════════════════════════

-- Los acentos y las eñes se guardan mal si el cliente de MySQL asume
-- otra codificación al leer este archivo. Esta línea lo evita.
SET NAMES utf8mb4;

DROP DATABASE IF EXISTS bpm_contact;
CREATE DATABASE bpm_contact
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE bpm_contact;


-- ═══════════════════════════════════════════════════════════════════
--  1. PERSONAS Y ACCESO
-- ═══════════════════════════════════════════════════════════════════

-- Los tres perfiles: agente, supervisor y superadministrador.
CREATE TABLE rol (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(40)  NOT NULL UNIQUE,
  descripcion VARCHAR(160)
) ENGINE=InnoDB;

-- Cada acción que se puede permitir o negar.
CREATE TABLE permiso (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  clave  VARCHAR(40) NOT NULL UNIQUE COMMENT 'softphone, reportes, usuarios…',
  nombre VARCHAR(120) NOT NULL
) ENGINE=InnoDB;

-- Qué permisos tiene cada rol. Una fila por combinación.
-- Cambiar el rol de una persona cambia lo que ve, sin tocar código.
CREATE TABLE rol_permiso (
  rol_id     INT NOT NULL,
  permiso_id INT NOT NULL,
  PRIMARY KEY (rol_id, permiso_id),
  FOREIGN KEY (rol_id)     REFERENCES rol(id)     ON DELETE CASCADE,
  FOREIGN KEY (permiso_id) REFERENCES permiso(id) ON DELETE CASCADE
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  2. OPERACIÓN
-- ═══════════════════════════════════════════════════════════════════

-- La campaña es la unidad de organización: tiene su cola en Asterisk,
-- su catálogo de tipificación y su horario.
CREATE TABLE campana (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(80) NOT NULL UNIQUE,
  tipo        ENUM('entrante','saliente','mixta') NOT NULL DEFAULT 'entrante',

  -- ═══ EL PUENTE CON ASTERISK ═══
  -- Nombre EXACTO de la cola en Asterisk. De aquí sale qué catálogo
  -- ve el agente y en qué panel de supervisión aparece la llamada.
  cola_asterisk VARCHAR(80) UNIQUE,

  hora_apertura TIME NOT NULL DEFAULT '08:00:00',
  hora_cierre   TIME NOT NULL DEFAULT '18:00:00',
  abierta       BOOLEAN NOT NULL DEFAULT TRUE
                COMMENT 'El supervisor puede cerrarla manualmente',
  acw_segundos  INT NOT NULL DEFAULT 60
                COMMENT 'Debe coincidir con el wrapuptime de la cola',
  activa        BOOLEAN NOT NULL DEFAULT TRUE,
  creada        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Una persona = una extensión. Es el requisito de la reunión.
CREATE TABLE usuario (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  usuario      VARCHAR(40)  NOT NULL UNIQUE,
  nombre       VARCHAR(120) NOT NULL,
  correo       VARCHAR(160) UNIQUE,

  -- NUNCA se guarda la contraseña en texto claro.
  -- Se guarda el resultado de una función de resumen con sal.
  clave_hash   VARCHAR(255) NOT NULL,

  rol_id       INT NOT NULL,
  campana_id   INT COMMENT 'Campaña principal del agente',

  -- Extensión SIP. Única: dos personas no pueden compartirla.
  extension    VARCHAR(20) UNIQUE,

  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  creado       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultimo_acceso DATETIME,

  FOREIGN KEY (rol_id)     REFERENCES rol(id),
  FOREIGN KEY (campana_id) REFERENCES campana(id) ON DELETE SET NULL,
  INDEX idx_usuario_rol (rol_id),
  INDEX idx_usuario_campana (campana_id)
) ENGINE=InnoDB;

-- Un supervisor puede tener varias campañas a cargo.
-- Esta tabla resuelve el "cambiar de campaña sin tocar código".
CREATE TABLE usuario_campana (
  usuario_id INT NOT NULL,
  campana_id INT NOT NULL,
  PRIMARY KEY (usuario_id, campana_id),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (campana_id) REFERENCES campana(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Credenciales SIP temporales. Se generan al iniciar sesión y se
-- invalidan al cerrarla. Ver Sección 7 del manual de integración.
CREATE TABLE sesion (
  id          CHAR(36) PRIMARY KEY COMMENT 'UUID',
  usuario_id  INT NOT NULL,
  clave_sip   VARCHAR(64) NOT NULL,
  inicio      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  vence       DATETIME NOT NULL,
  cerrada     DATETIME,
  ip          VARCHAR(45),
  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE,
  INDEX idx_sesion_usuario (usuario_id),
  INDEX idx_sesion_vence (vence)
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  3. ESTADOS Y PAUSAS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE pausa_tipo (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  nombre       VARCHAR(60) NOT NULL UNIQUE,
  productiva   BOOLEAN NOT NULL DEFAULT FALSE
               COMMENT 'Retroalimentación cuenta como productiva; almuerzo no',
  limite_minutos INT COMMENT 'NULL = sin límite'
) ENGINE=InnoDB;

-- Registro histórico. Alimenta el reporte de pausas.
CREATE TABLE pausa (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  usuario_id    INT NOT NULL,
  pausa_tipo_id INT NOT NULL,
  inicio        DATETIME NOT NULL,
  fin           DATETIME COMMENT 'NULL mientras la pausa sigue activa',
  segundos      INT GENERATED ALWAYS AS
                (CASE WHEN fin IS NULL THEN NULL
                      ELSE TIMESTAMPDIFF(SECOND, inicio, fin) END) STORED,
  FOREIGN KEY (usuario_id)    REFERENCES usuario(id) ON DELETE CASCADE,
  FOREIGN KEY (pausa_tipo_id) REFERENCES pausa_tipo(id),
  INDEX idx_pausa_usuario_fecha (usuario_id, inicio)
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  4. CONTACTOS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE contacto (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(160) NOT NULL,
  tipo_documento VARCHAR(10)  COMMENT 'CC, CE, NIT, TI, PA',
  documento      VARCHAR(40),
  telefono       VARCHAR(30) NOT NULL,
  telefono_alt   VARCHAR(30)  COMMENT 'Teléfono secundario de la ficha',
  correo         VARCHAR(160),
  ciudad         VARCHAR(80),
  direccion      VARCHAR(200),
  descripcion    TEXT         COMMENT 'Descripción del requerimiento',
  plan           VARCHAR(120) COMMENT 'Producto o servicio contratado',
  estado_cuenta  VARCHAR(60)  COMMENT 'Al día, mora 12 días…',
  campana_id     INT,
  notas          TEXT,
  creado         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campana_id) REFERENCES campana(id) ON DELETE SET NULL,

  -- El índice por teléfono es CRÍTICO: se consulta en cada llamada
  -- entrante y tiene que responder antes de que el agente conteste.
  INDEX idx_contacto_telefono (telefono),
  INDEX idx_contacto_documento (documento),
  INDEX idx_contacto_campana (campana_id)
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  5. TIPIFICACIÓN
-- ═══════════════════════════════════════════════════════════════════

-- El catálogo lo administra el supervisor, por campaña.
CREATE TABLE tipificacion (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  campana_id INT COMMENT 'NULL = disponible para todas las campañas',
  categoria  VARCHAR(80) NOT NULL COMMENT 'Venta efectiva, No interesado…',
  subcategoria VARCHAR(80) COMMENT 'NULL = la categoría no tiene subniveles',
  efectiva   BOOLEAN NOT NULL DEFAULT FALSE
             COMMENT 'Cuenta como gestión exitosa en los reportes',
  requiere_agenda BOOLEAN NOT NULL DEFAULT FALSE,
  activa     BOOLEAN NOT NULL DEFAULT TRUE,
  orden      INT NOT NULL DEFAULT 0,

  FOREIGN KEY (campana_id) REFERENCES campana(id) ON DELETE CASCADE,
  UNIQUE KEY uk_tipificacion (campana_id, categoria, subcategoria),
  INDEX idx_tipificacion_campana (campana_id)
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  6. TELEFONÍA
-- ═══════════════════════════════════════════════════════════════════

-- La INTERACCIÓN es la gestión completa con un cliente.
-- Una llamada transferida entre tres agentes es UNA interacción
-- con tres tramos. Es lo que evita que los reportes salgan inflados.
CREATE TABLE interaccion (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,

  -- ═══ EL PUENTE CON ASTERISK ═══
  -- Asterisk asigna el mismo linkedid a todos los canales de una
  -- misma llamada, incluidas las patas de una transferencia.
  -- El índice ÚNICO es lo que agrupa los tramos.
  linkedid       VARCHAR(64) NOT NULL UNIQUE,

  canal          ENUM('telefonia','whatsapp','correo','chat')
                 NOT NULL DEFAULT 'telefonia',
  direccion      ENUM('entrante','saliente') NOT NULL,
  numero         VARCHAR(30) NOT NULL,
  contacto_id    BIGINT COMMENT 'NULL si el número no está en la base',
  campana_id     INT,

  inicio         DATETIME NOT NULL,
  fin            DATETIME,
  contestada     BOOLEAN NOT NULL DEFAULT FALSE,
  segundos_total INT,
  segundos_espera INT COMMENT 'Tiempo en cola antes de ser atendida',

  tipificacion_id INT COMMENT 'NULL = quedó sin tipificar',
  observaciones  TEXT,
  agenda         DATETIME COMMENT 'Fecha de seguimiento, si aplica',

  grabacion      VARCHAR(255) COMMENT 'Ruta del archivo en el almacenamiento',

  FOREIGN KEY (contacto_id)     REFERENCES contacto(id)     ON DELETE SET NULL,
  FOREIGN KEY (campana_id)      REFERENCES campana(id)      ON DELETE SET NULL,
  FOREIGN KEY (tipificacion_id) REFERENCES tipificacion(id) ON DELETE SET NULL,

  INDEX idx_interaccion_fecha (inicio),
  INDEX idx_interaccion_campana_fecha (campana_id, inicio),
  INDEX idx_interaccion_contacto (contacto_id),
  INDEX idx_interaccion_numero (numero)
) ENGINE=InnoDB;

-- Cada TRAMO es el paso de la llamada por un agente.
-- Si se transfiere, se crea un tramo nuevo para el mismo linkedid.
CREATE TABLE tramo (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  interaccion_id BIGINT NOT NULL,

  uniqueid      VARCHAR(64) NOT NULL UNIQUE
                COMMENT 'Identificador del canal individual en Asterisk',

  usuario_id    INT COMMENT 'Agente que atendió este tramo',
  extension     VARCHAR(20),

  inicio        DATETIME NOT NULL,
  contestado    DATETIME,
  fin           DATETIME,
  segundos      INT,

  resultado     ENUM('contestada','no_contestada','abandonada',
                     'transferida','fallida') NOT NULL DEFAULT 'contestada',

  FOREIGN KEY (interaccion_id) REFERENCES interaccion(id) ON DELETE CASCADE,
  FOREIGN KEY (usuario_id)     REFERENCES usuario(id)     ON DELETE SET NULL,

  INDEX idx_tramo_interaccion (interaccion_id),
  INDEX idx_tramo_usuario_fecha (usuario_id, inicio)
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  7. FORMULARIOS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE formulario (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  nombre     VARCHAR(120) NOT NULL,
  campana_id INT COMMENT 'NULL = disponible para todas las campañas',
  activo     BOOLEAN NOT NULL DEFAULT TRUE,
  creado     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  creado_por INT,

  FOREIGN KEY (campana_id) REFERENCES campana(id) ON DELETE CASCADE,
  FOREIGN KEY (creado_por) REFERENCES usuario(id) ON DELETE SET NULL,
  INDEX idx_formulario_campana (campana_id)
) ENGINE=InnoDB;

CREATE TABLE formulario_campo (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  formulario_id INT NOT NULL,
  etiqueta      VARCHAR(120) NOT NULL,
  tipo          ENUM('texto','parrafo','numero','fecha','lista','si_no')
                NOT NULL DEFAULT 'texto',
  opciones      TEXT COMMENT 'Separadas por coma, solo para tipo lista',
  requerido     BOOLEAN NOT NULL DEFAULT FALSE,
  orden         INT NOT NULL DEFAULT 0,

  FOREIGN KEY (formulario_id) REFERENCES formulario(id) ON DELETE CASCADE,
  INDEX idx_campo_formulario (formulario_id, orden)
) ENGINE=InnoDB;

-- Una respuesta = un formulario llenado una vez.
CREATE TABLE formulario_respuesta (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  formulario_id  INT NOT NULL,
  usuario_id     INT,
  interaccion_id BIGINT COMMENT 'Llamada durante la cual se llenó',
  contacto_id    BIGINT,
  numero         VARCHAR(30),
  creada         DATETIME NOT NULL COMMENT 'Cuándo la llenó el agente',
  recibida       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                 COMMENT 'Cuándo llegó al servidor: puede ser mucho después',

  FOREIGN KEY (formulario_id)  REFERENCES formulario(id),
  FOREIGN KEY (usuario_id)     REFERENCES usuario(id)     ON DELETE SET NULL,
  FOREIGN KEY (interaccion_id) REFERENCES interaccion(id) ON DELETE SET NULL,
  FOREIGN KEY (contacto_id)    REFERENCES contacto(id)    ON DELETE SET NULL,
  INDEX idx_respuesta_formulario (formulario_id, creada)
) ENGINE=InnoDB;

-- El valor de cada campo. Una fila por campo respondido.
CREATE TABLE formulario_valor (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  respuesta_id  BIGINT NOT NULL,
  campo_id      INT NOT NULL,
  valor         TEXT,

  FOREIGN KEY (respuesta_id) REFERENCES formulario_respuesta(id) ON DELETE CASCADE,
  FOREIGN KEY (campo_id)     REFERENCES formulario_campo(id)     ON DELETE CASCADE,
  INDEX idx_valor_respuesta (respuesta_id)
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  8. AUDITORÍA
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE auditoria (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT,
  accion     VARCHAR(60) NOT NULL COMMENT 'crear, modificar, eliminar…',
  entidad    VARCHAR(60) NOT NULL COMMENT 'usuario, campana, formulario…',
  entidad_id VARCHAR(40),
  detalle    TEXT,
  ip         VARCHAR(45),
  fecha      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE SET NULL,
  INDEX idx_auditoria_fecha (fecha),
  INDEX idx_auditoria_entidad (entidad, entidad_id)
) ENGINE=InnoDB;


-- ═══════════════════════════════════════════════════════════════════
--  DATOS INICIALES
--  Coinciden con los que hoy están en js/servicio.js, para poder
--  comparar antes y después de conectar el backend.
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO rol (nombre, descripcion) VALUES
  ('agente',      'Atiende llamadas. Solo ve su propia operación.'),
  ('supervisor',  'Monitorea agentes, genera reportes y diseña formularios.'),
  ('admin',       'Superadministrador y soporte. Configura la plataforma.');

INSERT INTO permiso (clave, nombre) VALUES
  ('softphone',            'Usar el softphone'),
  ('tipificar',            'Tipificar interacciones'),
  ('contactos',            'Consultar el directorio'),
  ('historial',            'Ver su historial'),
  ('formularios',          'Llenar formularios'),
  ('supervision',          'Ver el panel de supervisión'),
  ('reportes',             'Generar y descargar reportes'),
  ('disenar_formularios',  'Crear y editar formularios'),
  ('usuarios',             'Administrar usuarios y roles'),
  ('campanas',             'Administrar campañas'),
  ('telefonia',            'Diagnóstico y traza SIP');

-- Agente: los cinco permisos básicos
INSERT INTO rol_permiso (rol_id, permiso_id)
SELECT r.id, p.id FROM rol r, permiso p
WHERE r.nombre = 'agente'
  AND p.clave IN ('softphone','tipificar','contactos','historial','formularios');

-- Supervisor: lo del agente más supervisión
INSERT INTO rol_permiso (rol_id, permiso_id)
SELECT r.id, p.id FROM rol r, permiso p
WHERE r.nombre = 'supervisor'
  AND p.clave IN ('softphone','tipificar','contactos','historial','formularios',
                  'supervision','reportes','disenar_formularios');

-- Administrador: todo
INSERT INTO rol_permiso (rol_id, permiso_id)
SELECT r.id, p.id FROM rol r, permiso p WHERE r.nombre = 'admin';

INSERT INTO campana (nombre, tipo, cola_asterisk, hora_apertura, hora_cierre, acw_segundos) VALUES
  ('Ventas',    'mixta',    'ventas',    '08:00:00', '18:00:00', 60),
  ('Soporte',   'entrante', 'soporte',   '07:00:00', '20:00:00', 45),
  ('Cobranza',  'saliente', 'cobranza',  '08:00:00', '17:00:00', 90),
  ('Retención', 'mixta',    'retencion', '08:00:00', '18:00:00', 60);

-- Contraseña de todos los usuarios de ejemplo: demo1234
-- En producción la genera el backend al crear el usuario.
INSERT INTO usuario (usuario, nombre, correo, clave_hash, rol_id, campana_id, extension) VALUES
  ('ana',    'Ana Rodríguez',  'ana@bpm.com',    '$2b$12$n2OLycqnEagyEodOFP9at.yT5NlQbLIUTsue0i2YgYGSlTfQ22NFi', 1, 1, '1001'),
  ('pedro',  'Pedro Martínez', 'pedro@bpm.com',  '$2b$12$n2OLycqnEagyEodOFP9at.yT5NlQbLIUTsue0i2YgYGSlTfQ22NFi', 1, 2, '1002'),
  ('lucia',  'Lucía Herrera',  'lucia@bpm.com',  '$2b$12$n2OLycqnEagyEodOFP9at.yT5NlQbLIUTsue0i2YgYGSlTfQ22NFi', 1, 3, NULL),
  ('sandra', 'Sandra López',   'sandra@bpm.com', '$2b$12$n2OLycqnEagyEodOFP9at.yT5NlQbLIUTsue0i2YgYGSlTfQ22NFi', 2, 1, NULL),
  ('admin',  'Jorge Betancur', 'admin@bpm.com',  '$2b$12$n2OLycqnEagyEodOFP9at.yT5NlQbLIUTsue0i2YgYGSlTfQ22NFi', 3, NULL, NULL);

-- Sandra supervisa Ventas y Retención
INSERT INTO usuario_campana (usuario_id, campana_id) VALUES (4, 1), (4, 4);

INSERT INTO pausa_tipo (nombre, productiva, limite_minutos) VALUES
  ('Baño',              FALSE, 10),
  ('Almuerzo',          FALSE, 60),
  ('Break',             FALSE, 15),
  ('Retroalimentación', TRUE,  NULL);

INSERT INTO tipificacion (campana_id, categoria, subcategoria, efectiva, orden) VALUES
  -- Las cinco categorías base que definió la operación
  (NULL, 'Efectiva',        'Venta cerrada',        TRUE,  1),
  (NULL, 'Efectiva',        'Información entregada', TRUE,  2),
  (NULL, 'Efectiva',        'Gestión completada',   TRUE,  3),
  (NULL, 'Se cayó',         'Corte de línea',       FALSE, 10),
  (NULL, 'Se cayó',         'El cliente colgó',     FALSE, 11),
  (NULL, 'Entró muda',      NULL,                   FALSE, 20),
  (NULL, 'Entró con falla', 'Sin audio',            FALSE, 30),
  (NULL, 'Entró con falla', 'Audio entrecortado',   FALSE, 31),
  (NULL, 'Entró con falla', 'Eco',                  FALSE, 32),
  (NULL, 'Prueba técnica',  NULL,                   FALSE, 40);

INSERT INTO contacto (nombre, tipo_documento, documento, telefono, telefono_alt,
                      correo, ciudad, descripcion, campana_id) VALUES
  ('María Fernanda Gómez',  'CC', '52.984.112', '3105558812', '601 742 1180',
   'mf.gomez@correo.com',  'Bogotá',       'Cliente Plan Hogar 200MB. Solicita ampliación de canales.', 1),
  ('Carlos Andrés Ruiz',    'CC', '80.112.443', '3216674590', '604 311 5522',
   'caruiz@correo.com',    'Medellín',     'Plan Móvil 20GB. Mora de 12 días. Acuerdo de pago vigente.', 3),
  ('Luisa Fernanda Pardo',  'CC', '1.020.554',  '3004432187', '602 889 4410',
   'lf.pardo@correo.com',  'Cali',         'Plan Full TV. Sin novedades.', 1),
  ('Jorge Enrique Salazar', 'CC', '79.554.221', '3159982204', '605 220 7781',
   'je.salazar@correo.com','Barranquilla', 'Plan Hogar 100MB. Primer contacto.', 2),
  ('Diana Carolina Mesa',   'CC', '1.098.223',  '3187765430', '607 645 3390',
   'dc.mesa@correo.com',   'Bucaramanga',  'Plan Móvil 8GB. Reporta intermitencia en el servicio.', 3);
