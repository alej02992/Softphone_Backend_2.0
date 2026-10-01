-- ═══════════════════════════════════════════════════════════════════
-- BPM CONSULTING · Estados de pausa que define el supervisor
--
--   mysql --default-character-set=utf8mb4 -u root -p bpm_contact < estados.sql
--
-- Qué cambia:
--   `activo`      permite encender y apagar un estado sin borrarlo, y
--                 sin perder las pausas ya registradas con él
--   `campana_id`  limita el estado a una campaña. Si queda en NULL, el
--                 estado lo ven todos los agentes
-- ═══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

ALTER TABLE pausa_tipo
  ADD COLUMN activo     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN campana_id INT NULL COMMENT 'NULL = visible para todas las campañas',
  ADD COLUMN creado_por INT NULL,
  ADD CONSTRAINT fk_pausa_tipo_campana FOREIGN KEY (campana_id)
      REFERENCES campana(id) ON DELETE CASCADE;

-- Los estados que ya existían quedan activos y para todas las campañas
UPDATE pausa_tipo SET activo = TRUE, campana_id = NULL;

SELECT id, nombre, activo, campana_id FROM pausa_tipo ORDER BY id;
