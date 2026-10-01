-- ═══════════════════════════════════════════════════════════════════
-- BPM CONSULTING · Envío de SMS
--
--   mysql --default-character-set=utf8mb4 -u root -p bpm_contact < sms.sql
--
-- Misma idea que el blaster de voz: una lista de contactos y un
-- mensaje, que puede ser igual para todos o personalizado con los
-- datos de cada quien.
--
-- El envío lo hace un proveedor externo (Háblame). La plataforma
-- prepara, aprueba y registra; el proveedor entrega.
-- ═══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS sms (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nombre      VARCHAR(120) NOT NULL,
  campana_id  INT NOT NULL,

  -- El texto. Con marcas {nombre} queda personalizado por persona.
  texto       TEXT NOT NULL,
  remitente   VARCHAR(20) NULL COMMENT 'Debe estar aprobado ante los operadores',

  -- Opciones del proveedor
  certificado BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Con validez jurídica; cuesta más',
  flash       BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Aparece en pantalla y no se guarda',
  centro_costo INT NULL COMMENT 'Para separar el gasto por área',

  -- Cuándo sale
  envio       ENUM('ahora','programado') NOT NULL DEFAULT 'ahora',
  fecha_envio DATETIME NULL,

  estado      ENUM('borrador','listo','aprobado','enviando','enviado','cancelado')
              NOT NULL DEFAULT 'borrador',
  creado_por  INT NULL,
  aprobado_por INT NULL,
  aprobado_en  DATETIME NULL,
  creado      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campana_id)   REFERENCES campana(id) ON DELETE CASCADE,
  FOREIGN KEY (creado_por)   REFERENCES usuario(id) ON DELETE SET NULL,
  FOREIGN KEY (aprobado_por) REFERENCES usuario(id) ON DELETE SET NULL,
  INDEX idx_sms_estado (estado, campana_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS sms_destinatario (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  sms_id      INT NOT NULL,
  numero      VARCHAR(20) NOT NULL,
  nombre      VARCHAR(120) NULL,
  datos       JSON NULL COMMENT 'Las variables del mensaje',

  -- El texto final, ya con los datos reemplazados. Se guarda para
  -- saber exactamente qué se le dijo a cada quien.
  texto_final TEXT NULL,

  estado      ENUM('pendiente','enviado','entregado','fallido','excluido')
              NOT NULL DEFAULT 'pendiente',
  -- Identificador que devuelve el proveedor, para cruzar la entrega
  referencia  VARCHAR(80) NULL,
  error       VARCHAR(200) NULL,
  enviado_en  DATETIME NULL,
  entregado_en DATETIME NULL,

  FOREIGN KEY (sms_id) REFERENCES sms(id) ON DELETE CASCADE,
  UNIQUE KEY uk_sms_destinatario (sms_id, numero),
  INDEX idx_sms_destinatario_estado (sms_id, estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Permisos: los mismos que el blaster de voz
INSERT IGNORE INTO permiso (clave, nombre) VALUES
  ('sms', 'Crear y administrar envíos de SMS'),
  ('sms_aprobar', 'Aprobar y enviar SMS');

INSERT IGNORE INTO rol_permiso (rol_id, permiso_id)
  SELECT r.id, p.id FROM rol r, permiso p
   WHERE r.nombre IN ('supervisor','admin') AND p.clave = 'sms';

INSERT IGNORE INTO rol_permiso (rol_id, permiso_id)
  SELECT r.id, p.id FROM rol r, permiso p
   WHERE r.nombre = 'admin' AND p.clave = 'sms_aprobar';

SELECT r.nombre AS rol, p.clave AS permiso
  FROM rol_permiso rp JOIN rol r ON r.id = rp.rol_id JOIN permiso p ON p.id = rp.permiso_id
 WHERE p.clave LIKE 'sms%' ORDER BY r.nombre;
