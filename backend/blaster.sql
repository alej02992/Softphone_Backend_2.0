-- ═══════════════════════════════════════════════════════════════════
-- BPM CONSULTING · Blaster de voz
--
--   mysql --default-character-set=utf8mb4 -u root -p bpm_contact < blaster.sql
--
-- Tres formas de mensaje:
--   texto     un texto igual para todos, leído por voz sintética
--   variables el mismo texto personalizado con datos de cada contacto
--   audio     una grabación hecha por una persona
--
-- Todas admiten respuesta del cliente: marcar una tecla o digitar un
-- número. Lo que digite queda guardado.
-- ═══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS blaster (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(120) NOT NULL,
  campana_id  INT NOT NULL COMMENT 'Siempre pertenece a una campaña',

  tipo        ENUM('texto','variables','audio') NOT NULL,

  -- Para texto y variables: el guion. En variables lleva marcas {nombre}
  guion       TEXT NULL,
  -- Para audio: el archivo grabado por una persona
  audio_archivo VARCHAR(255) NULL,
  -- Voz sintética elegida en el proveedor
  voz_id      VARCHAR(80) NULL,

  -- Respuesta del cliente
  respuesta          BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Si se le pide algo al cliente',
  respuesta_tipo     ENUM('tecla','numero') NOT NULL DEFAULT 'tecla',
  respuesta_guion    VARCHAR(500) NULL COMMENT 'Lo que se dice para pedirla',
  respuesta_opciones VARCHAR(60) NULL COMMENT 'Teclas válidas, ej. 1,2,3',
  respuesta_digitos  TINYINT NOT NULL DEFAULT 10 COMMENT 'Cuántos dígitos se esperan',

  -- Cuándo puede llamar
  hora_inicio TIME NOT NULL DEFAULT '08:00:00',
  hora_fin    TIME NOT NULL DEFAULT '19:00:00',
  dias        VARCHAR(20) NOT NULL DEFAULT 'L,M,X,J,V,S',

  reintentos    TINYINT NOT NULL DEFAULT 2,
  intervalo_min INT NOT NULL DEFAULT 60 COMMENT 'Minutos entre reintentos',
  aprobado    BOOLEAN NOT NULL DEFAULT FALSE,

  -- El supervisor prepara; el administrador aprueba y lanza
  estado      ENUM('borrador','listo','aprobado','activo','pausado','terminado','cancelado')
              NOT NULL DEFAULT 'borrador',
  creado_por  INT NULL,
  aprobado_por INT NULL,
  aprobado_en  DATETIME NULL,
  creado      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campana_id)   REFERENCES campana(id) ON DELETE CASCADE,
  FOREIGN KEY (creado_por)   REFERENCES usuario(id) ON DELETE SET NULL,
  FOREIGN KEY (aprobado_por) REFERENCES usuario(id) ON DELETE SET NULL,
  INDEX idx_blaster_estado (estado, campana_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- A quién se llama. `datos` guarda las variables de cada contacto.
CREATE TABLE IF NOT EXISTS blaster_destinatario (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  blaster_id  INT NOT NULL,
  numero      VARCHAR(20) NOT NULL,
  nombre      VARCHAR(120) NULL COMMENT 'Para saber a quién se llamó',
  datos       JSON NULL COMMENT '{"nombre":"Juan","valor":"250000"}',

  -- Audio propio cuando el mensaje lleva variables
  audio_archivo VARCHAR(255) NULL,

  estado      ENUM('pendiente','llamando','contestada','buzon','sin_respuesta','fallida','excluido')
              NOT NULL DEFAULT 'pendiente',
  intentos    TINYINT NOT NULL DEFAULT 0,
  ultimo_intento DATETIME NULL,
  proximo_intento DATETIME NULL,
  segundos_escuchados INT NULL,

  FOREIGN KEY (blaster_id) REFERENCES blaster(id) ON DELETE CASCADE,
  UNIQUE KEY uk_destinatario (blaster_id, numero),
  INDEX idx_destinatario_cola (blaster_id, estado, proximo_intento)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Lo que el cliente marcó o digitó
CREATE TABLE IF NOT EXISTS blaster_respuesta (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  blaster_id     INT NOT NULL,
  destinatario_id BIGINT NULL,
  numero         VARCHAR(20) NOT NULL,
  valor          VARCHAR(40) NOT NULL,
  escuchado_seg  INT NULL COMMENT 'Cuánto alcanzó a oír antes de responder',
  linkedid       VARCHAR(64) NULL COMMENT 'Identificador de la llamada en Asterisk',
  creada         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (blaster_id) REFERENCES blaster(id) ON DELETE CASCADE,
  FOREIGN KEY (destinatario_id) REFERENCES blaster_destinatario(id) ON DELETE SET NULL,
  INDEX idx_respuesta_blaster (blaster_id, creada)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Audios ya generados, para no pagar dos veces por el mismo texto
CREATE TABLE IF NOT EXISTS blaster_audio (
  huella     CHAR(64) NOT NULL PRIMARY KEY COMMENT 'Huella del texto + voz',
  archivo    VARCHAR(255) NOT NULL,
  caracteres INT NOT NULL,
  proveedor  VARCHAR(40) NOT NULL,
  creado     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Números que pidieron no ser llamados. Obligación legal.
CREATE TABLE IF NOT EXISTS no_llamar (
  numero  VARCHAR(20) NOT NULL PRIMARY KEY,
  motivo  VARCHAR(160) NULL,
  creado  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Permisos: supervisores y administradores
INSERT IGNORE INTO permiso (clave, nombre) VALUES
  ('blaster', 'Crear y administrar blasters de voz'),
  ('blaster_aprobar', 'Aprobar y lanzar un blaster');

INSERT IGNORE INTO rol_permiso (rol_id, permiso_id)
  SELECT r.id, p.id FROM rol r, permiso p
   WHERE r.nombre IN ('supervisor','admin') AND p.clave = 'blaster';

INSERT IGNORE INTO rol_permiso (rol_id, permiso_id)
  SELECT r.id, p.id FROM rol r, permiso p
   WHERE r.nombre = 'admin' AND p.clave = 'blaster_aprobar';

SELECT r.nombre AS rol, p.clave AS permiso
  FROM rol_permiso rp JOIN rol r ON r.id = rp.rol_id JOIN permiso p ON p.id = rp.permiso_id
 WHERE p.clave LIKE 'blaster%' ORDER BY r.nombre;
