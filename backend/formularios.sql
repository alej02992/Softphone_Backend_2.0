-- ═══════════════════════════════════════════════════════════════════
-- BPM CONSULTING · Formularios en base de datos y catálogo de ubicaciones
--
--   mysql --default-character-set=utf8mb4 -u root -p bpm_contact < formularios.sql
--
-- Qué cambia:
--   1. Los campos admiten más tipos (teléfono, correo, país, ciudad…)
--   2. Cada campo puede ser FIJO: los diez datos del contacto que van
--      obligatoriamente en todo formulario y que nadie puede borrar
--   3. Se agregan las tablas de país, departamento y municipio
-- ═══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;


-- ───────────────────────────────────────────────────────────────────
-- 1. CAMPOS DE FORMULARIO
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE formulario_campo
  MODIFY tipo ENUM('texto','parrafo','numero','fecha','lista','si_no',
                   'telefono','correo','documento','pais','departamento','ciudad')
         NOT NULL DEFAULT 'texto';

-- `clave` identifica los campos fijos del contacto (nombre_contacto,
-- telefono_1…). Los campos que agregue el administrador la dejan NULL.
ALTER TABLE formulario_campo
  ADD COLUMN clave VARCHAR(40) NULL AFTER formulario_id,
  ADD COLUMN fijo  BOOLEAN NOT NULL DEFAULT FALSE AFTER requerido,
  ADD COLUMN ayuda VARCHAR(160) NULL COMMENT 'Texto de apoyo bajo el campo';

-- Un mismo formulario no puede tener dos veces el mismo campo fijo
ALTER TABLE formulario_campo
  ADD UNIQUE KEY uk_campo_clave (formulario_id, clave);


-- ───────────────────────────────────────────────────────────────────
-- 2. UBICACIONES
--
-- Para Colombia, la fuente oficial es la DIVIPOLA del DANE. Aquí se
-- cargan los 32 departamentos más Bogotá y sus capitales; el archivo
-- completo de municipios se carga aparte (ver el final).
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pais (
  codigo  CHAR(2) NOT NULL PRIMARY KEY COMMENT 'ISO 3166-1',
  nombre  VARCHAR(80) NOT NULL,
  -- Con `tiene_divisiones` la plataforma sabe si desplegar la lista de
  -- departamentos y ciudades o pedirlos escritos a mano.
  tiene_divisiones BOOLEAN NOT NULL DEFAULT FALSE,
  orden   INT NOT NULL DEFAULT 100,
  UNIQUE KEY uk_pais_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS departamento (
  codigo      CHAR(2) NOT NULL PRIMARY KEY COMMENT 'DIVIPOLA',
  pais_codigo CHAR(2) NOT NULL DEFAULT 'CO',
  nombre      VARCHAR(80) NOT NULL,
  FOREIGN KEY (pais_codigo) REFERENCES pais(codigo),
  INDEX idx_departamento_pais (pais_codigo, nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS municipio (
  codigo              CHAR(5) NOT NULL PRIMARY KEY COMMENT 'DIVIPOLA',
  departamento_codigo CHAR(2) NOT NULL,
  nombre              VARCHAR(120) NOT NULL,
  FOREIGN KEY (departamento_codigo) REFERENCES departamento(codigo),
  INDEX idx_municipio_departamento (departamento_codigo, nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ── Países ──────────────────────────────────────────────────────────
INSERT IGNORE INTO pais (codigo, nombre, tiene_divisiones, orden) VALUES
  ('CO','Colombia',TRUE,1),
  ('AR','Argentina',FALSE,10), ('BO','Bolivia',FALSE,10), ('BR','Brasil',FALSE,10),
  ('CL','Chile',FALSE,10),     ('CR','Costa Rica',FALSE,10), ('CU','Cuba',FALSE,10),
  ('DO','República Dominicana',FALSE,10), ('EC','Ecuador',FALSE,10),
  ('SV','El Salvador',FALSE,10), ('GT','Guatemala',FALSE,10), ('HN','Honduras',FALSE,10),
  ('MX','México',FALSE,10),    ('NI','Nicaragua',FALSE,10), ('PA','Panamá',FALSE,10),
  ('PY','Paraguay',FALSE,10),  ('PE','Perú',FALSE,10), ('PR','Puerto Rico',FALSE,10),
  ('UY','Uruguay',FALSE,10),   ('VE','Venezuela',FALSE,10),
  ('US','Estados Unidos',FALSE,20), ('CA','Canadá',FALSE,20),
  ('ES','España',FALSE,20),    ('PT','Portugal',FALSE,20), ('FR','Francia',FALSE,20),
  ('IT','Italia',FALSE,20),    ('DE','Alemania',FALSE,20), ('GB','Reino Unido',FALSE,20),
  ('NL','Países Bajos',FALSE,20), ('CH','Suiza',FALSE,20),
  ('AU','Australia',FALSE,30), ('CN','China',FALSE,30), ('JP','Japón',FALSE,30),
  ('IN','India',FALSE,30),     ('ZA','Sudáfrica',FALSE,30);


-- ── Departamentos de Colombia (DIVIPOLA) ────────────────────────────
INSERT IGNORE INTO departamento (codigo, nombre) VALUES
  ('05','Antioquia'),        ('08','Atlántico'),      ('11','Bogotá D.C.'),
  ('13','Bolívar'),          ('15','Boyacá'),         ('17','Caldas'),
  ('18','Caquetá'),          ('19','Cauca'),          ('20','Cesar'),
  ('23','Córdoba'),          ('25','Cundinamarca'),   ('27','Chocó'),
  ('41','Huila'),            ('44','La Guajira'),     ('47','Magdalena'),
  ('50','Meta'),             ('52','Nariño'),         ('54','Norte de Santander'),
  ('63','Quindío'),          ('66','Risaralda'),      ('68','Santander'),
  ('70','Sucre'),            ('73','Tolima'),         ('76','Valle del Cauca'),
  ('81','Arauca'),           ('85','Casanare'),       ('86','Putumayo'),
  ('88','Archipiélago de San Andrés, Providencia y Santa Catalina'),
  ('91','Amazonas'),         ('94','Guainía'),        ('95','Guaviare'),
  ('97','Vaupés'),           ('99','Vichada');


-- ── Capitales ───────────────────────────────────────────────────────
-- Basta para empezar a operar. El listado completo de municipios se
-- carga con el archivo oficial (instrucciones al final).
INSERT IGNORE INTO municipio (codigo, departamento_codigo, nombre) VALUES
  ('05001','05','Medellín'),      ('08001','08','Barranquilla'),
  ('11001','11','Bogotá D.C.'),   ('13001','13','Cartagena de Indias'),
  ('15001','15','Tunja'),         ('17001','17','Manizales'),
  ('18001','18','Florencia'),     ('19001','19','Popayán'),
  ('20001','20','Valledupar'),    ('23001','23','Montería'),
  ('25290','25','Fusagasugá'),    ('27001','27','Quibdó'),
  ('41001','41','Neiva'),         ('44001','44','Riohacha'),
  ('47001','47','Santa Marta'),   ('50001','50','Villavicencio'),
  ('52001','52','Pasto'),         ('54001','54','Cúcuta'),
  ('63001','63','Armenia'),       ('66001','66','Pereira'),
  ('68001','68','Bucaramanga'),   ('70001','70','Sincelejo'),
  ('73001','73','Ibagué'),        ('76001','76','Cali'),
  ('81001','81','Arauca'),        ('85001','85','Yopal'),
  ('86001','86','Mocoa'),         ('88001','88','San Andrés'),
  ('91001','91','Leticia'),       ('94001','94','Inírida'),
  ('95001','95','San José del Guaviare'), ('97001','97','Mitú'),
  ('99001','99','Puerto Carreño'),
  -- Municipios grandes que no son capital y se usan a diario
  ('05266','05','Envigado'),      ('05360','05','Itagüí'),
  ('05088','05','Bello'),         ('05631','05','Sabaneta'),
  ('08758','08','Soledad'),       ('08433','08','Malambo'),
  ('13430','13','Magangué'),      ('15238','15','Duitama'),
  ('15759','15','Sogamoso'),      ('17380','17','La Dorada'),
  ('25754','25','Soacha'),        ('25473','25','Mosquera'),
  ('25286','25','Funza'),         ('25126','25','Cajicá'),
  ('25175','25','Chía'),          ('25269','25','Facatativá'),
  ('25799','25','Zipaquirá'),     ('25430','25','Madrid'),
  ('54001','54','Cúcuta'),        ('54261','54','El Zulia'),
  ('68276','68','Floridablanca'), ('68307','68','Girón'),
  ('68547','68','Piedecuesta'),   ('76520','76','Palmira'),
  ('76109','76','Buenaventura'),  ('76834','76','Tuluá'),
  ('76892','76','Yumbo'),         ('76364','76','Jamundí'),
  ('73268','73','Espinal'),       ('66170','66','Dosquebradas'),
  ('52356','52','Ipiales'),       ('47189','47','Ciénaga'),
  ('23417','23','Lorica'),        ('20011','20','Aguachica'),
  ('13836','13','Turbaco'),       ('19698','19','Santander de Quilichao');


-- ───────────────────────────────────────────────────────────────────
-- 3. VERIFICACIÓN
-- ───────────────────────────────────────────────────────────────────
SELECT (SELECT COUNT(*) FROM pais)         AS paises,
       (SELECT COUNT(*) FROM departamento) AS departamentos,
       (SELECT COUNT(*) FROM municipio)    AS municipios;

SHOW COLUMNS FROM formulario_campo LIKE 'clave';
SHOW COLUMNS FROM formulario_campo LIKE 'fijo';


-- ═══════════════════════════════════════════════════════════════════
-- CARGAR TODOS LOS MUNICIPIOS (opcional, recomendado)
--
-- Descarga de datos.gov.co el archivo de la DIVIPOLA del DANE en CSV,
-- con las columnas de código y nombre de departamento y municipio.
-- Déjalo en /tmp/divipola.csv y ejecuta:
--
--   LOAD DATA LOCAL INFILE '/tmp/divipola.csv'
--     INTO TABLE municipio
--     FIELDS TERMINATED BY ',' ENCLOSED BY '"'
--     LINES TERMINATED BY '\n' IGNORE 1 LINES
--     (@dep_cod, @dep_nom, @mun_cod, @mun_nom)
--     SET codigo = LPAD(@mun_cod, 5, '0'),
--         departamento_codigo = LPAD(@dep_cod, 2, '0'),
--         nombre = @mun_nom;
--
-- Ajusta el orden de las columnas al del archivo que descargues.
-- ═══════════════════════════════════════════════════════════════════
