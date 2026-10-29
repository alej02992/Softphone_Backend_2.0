-- ═══════════════════════════════════════════════════════════════════
-- BPM CONSULTING · Duración de los estados básicos en cada campaña
--
--   mysql --default-character-set=utf8mb4 -u root -p bpm_contact < duracion-campana.sql
--
-- Los estados básicos (break, almuerzo, baño…) son de todas las
-- campañas. Esta tabla guarda la duración que les da cada campaña.
-- Si una campaña no tiene fila, usa la duración general, como hasta hoy.
-- ═══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS pausa_limite_campana (
  pausa_tipo_id  INT NOT NULL,
  campana_id     INT NOT NULL,
  -- Minutos permitidos en esta campaña. NULL = sin límite.
  limite_minutos INT NULL,
  modificado_por INT NULL,
  modificado     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (pausa_tipo_id, campana_id),
  CONSTRAINT fk_plc_tipo    FOREIGN KEY (pausa_tipo_id) REFERENCES pausa_tipo(id) ON DELETE CASCADE,
  CONSTRAINT fk_plc_campana FOREIGN KEY (campana_id)    REFERENCES campana(id)    ON DELETE CASCADE
) ENGINE=InnoDB;

SELECT 'Listo: sin cambios en las duraciones hasta que una campaña ponga la suya' AS estado;
