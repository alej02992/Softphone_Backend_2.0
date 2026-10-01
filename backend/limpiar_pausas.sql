-- ═══════════════════════════════════════════════════════════════════
-- BPM CONSULTING · Cerrar pausas que quedaron abiertas
--
-- Si alguien cerró sesión estando en pausa, esa fila se quedó sin fin
-- y la persona aparece en ese estado indefinidamente.
--
-- Se les pone como fin el cierre de la sesión correspondiente; si no
-- se encuentra, se cierran con su propia hora de inicio para que no
-- sumen tiempo inventado a los reportes.
-- ═══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

SELECT '── ANTES ──' AS '';
SELECT u.nombre, pt.nombre AS estado, p.inicio,
       ROUND(TIMESTAMPDIFF(HOUR, p.inicio, NOW())) AS horas
  FROM pausa p
  JOIN usuario u ON u.id = p.usuario_id
  JOIN pausa_tipo pt ON pt.id = p.pausa_tipo_id
 WHERE p.fin IS NULL;

UPDATE pausa p
   SET p.fin = COALESCE(
         (SELECT MAX(s.cerrada) FROM sesion s
           WHERE s.usuario_id = p.usuario_id AND s.cerrada IS NOT NULL
             AND s.cerrada > p.inicio),
         p.inicio)
 WHERE p.fin IS NULL
   AND NOT EXISTS (SELECT 1 FROM sesion s
                    WHERE s.usuario_id = p.usuario_id AND s.cerrada IS NULL
                      AND s.vence > NOW() AND s.inicio <= p.inicio);

SELECT '── DESPUÉS: solo deben quedar las de gente conectada ──' AS '';
SELECT u.nombre, pt.nombre AS estado, p.inicio
  FROM pausa p
  JOIN usuario u ON u.id = p.usuario_id
  JOIN pausa_tipo pt ON pt.id = p.pausa_tipo_id
 WHERE p.fin IS NULL;
