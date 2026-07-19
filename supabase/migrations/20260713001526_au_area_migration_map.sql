-- Old area_id -> canonical mapping used to retire the 86 legacy areas across all modules.
-- 78 area rows (70 high-confidence + 8 ambiguous best-guess), 6 regions, 2 offices (kept, not collapsed).
-- SAFE: drops/recreates only the au-schema mapping table this migration owns; public.* is untouched.
-- NOTE: the old_area_id values below are STAGING ids and are illustrative only (see
-- docs/area-unification/PHASE8-migration-packaging.md). The real production remap is a separate
-- Phase-9 cutover migration built against production area ids.
drop table if exists au.area_migration_map;
create table au.area_migration_map (
  old_area_id bigint primary key,
  -- Not an FK: au.canonical_areas is only populated by the reference-data seed (20260713040000),
  -- which sorts AFTER this migration. Constraining it here caused an FK-violation hard-fail on a
  -- fresh production apply. These codes are illustrative staging data, so a plain text column is
  -- correct and makes this migration order-independent.
  canonical_code text,
  kind text not null check (kind in ('area','region','office')),
  confidence text,  -- high | ambiguous | null
  note text
);
-- 70 high-confidence variant/duplicate mappings
insert into au.area_migration_map(old_area_id, canonical_code, kind, confidence) values
(57,'AB2','area','high'),(27,'AB2','area','high'),(56,'AB2','area','high'),(55,'AB1','area','high'),(26,'AB1','area','high'),(28,'AB3','area','high'),(74,'AB3','area','high'),
(18,'UE3','area','high'),(17,'UE4','area','high'),(61,'D11','area','high'),(14,'GZ6','area','high'),(24,'AB4','area','high'),(25,'AB5','area','high'),
(5,'CA3','area','high'),(43,'CA3','area','high'),(68,'CA4','area','high'),(4,'CA4','area','high'),(67,'CA3','area','high'),(6,'CA6','area','high'),
(36,'D21','area','high'),(1031,'D21','area','high'),(37,'D22','area','high'),(1032,'D22','area','high'),(38,'D23','area','high'),
(8,'GZ2','area','high'),(47,'GZ2','area','high'),(70,'GZ2','area','high'),(40,'D26','area','high'),(69,'CA5','area','high'),(44,'CA5','area','high'),
(50,'GZ6','area','high'),(76,'D14','area','high'),(77,'D15','area','high'),(49,'GZ1','area','high'),(12,'GZ1','area','high'),(46,'GZ4','area','high'),(9,'GZ4','area','high'),
(1036,'CA1','area','high'),(2,'CA1','area','high'),(11,'GZ5','area','high'),(10,'GZ3','area','high'),(75,'D16','area','high'),(58,'D16','area','high'),(34,'D16','area','high'),
(48,'GZ5','area','high'),(30,'D15','area','high'),(59,'D12','area','high'),(60,'D13','area','high'),(13,'UE1','area','high'),(15,'UE2','area','high'),(32,'D12','area','high'),(33,'D13','area','high'),
(3,'CA2','area','high'),(65,'CA2','area','high'),(45,'GZ7','area','high'),(62,'D26','area','high'),(78,'D11','area','high'),(51,'UE7','area','high'),(73,'UE7','area','high'),(19,'UE7','area','high'),(20,'UE8','area','high'),
(79,'D24','area','high'),(63,'D25','area','high'),(22,'UE5','area','high'),(21,'UE6','area','high'),(52,'UE5','area','high'),(53,'UE6','area','high'),(31,'D14','area','high'),(1035,'D14','area','high'),(41,'D24','area','high');
-- 8 ambiguous best-guesses
insert into au.area_migration_map(old_area_id, canonical_code, kind, confidence, note) values
(54,'AB4','area','ambiguous','Alex - Behiera'),(1011,'AB1','area','ambiguous','Alex-Delta'),
(1034,'D23','area','ambiguous','Dakahlia 4 (no canonical)'),(39,'D23','area','ambiguous','Dakahlia 4 (no canonical)'),
(71,'GZ4','area','ambiguous','Faisal & October'),(72,'GZ4','area','ambiguous','Haram, Giza midan, Giza Centers'),
(64,'D25','area','ambiguous','Sharkia 3 (no canonical)'),(66,'D11','area','ambiguous','Shoubra & Shoubra El Kheima');
-- 8 non-area (regions + office) — kept, not collapsed
insert into au.area_migration_map(old_area_id, canonical_code, kind, note) values
(23,null,'region','ALEX-BHR'),(1,null,'region','Cairo'),(29,null,'region','Delta (1)'),(35,null,'region','Delta (2)'),(7,null,'region','Giza'),(16,null,'region','Upper Egypt'),
(80,null,'office','Head office'),(42,null,'office','Egypt');
select kind, count(*) from au.area_migration_map group by kind order by kind;
