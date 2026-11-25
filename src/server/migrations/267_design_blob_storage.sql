-- Design 素材库的文件按段读出来送（8.1.33，Codex 安全审查：下载不整份读进内存）。
-- 文件列改成「放在表外、不压缩」（EXTERNAL）：图片、视频、字体本来就是压缩过的，再压省不了多少；不压缩时按段读（substring）只取那一段，
-- 不用每读一段都把整份解压一遍。只影响之后写进来的文件，已有的照旧能读（读法一样，只是慢一点）。
-- 风险已知：只改列的存储方式，不改数据、不删数据；回滚见 docs/rollback/267_design_blob_storage.down.sql。

ALTER TABLE design_asset_versions ALTER COLUMN data SET STORAGE EXTERNAL;
