-- 8.1.47 采购商城商品图（店主 2026-11-26：要淘宝、得物那样逛高级电商的感觉、好的商品图，docs/MALL_V8147.md）：
-- 每样物料最多 6 张商品图，第 1 张是封面（目录卡片、比价页、清单都用它）。图片本身存在 erp_images（按内容去重、只追加），
-- 这里只记「哪样物料、第几张、哪张图」；物料主档里整组换（删了重写），改动记审计。
-- 风险已知：只新建一张表，不改已有数据；回滚见 docs/rollback/480_material_images.down.sql。

CREATE TABLE material_images (
  material_id bigint NOT NULL REFERENCES materials (id),
  sort_no     integer NOT NULL CHECK (sort_no BETWEEN 1 AND 6),
  image_id    bigint NOT NULL REFERENCES erp_images (id),
  PRIMARY KEY (material_id, sort_no)
);
CREATE INDEX material_images_image_idx ON material_images (image_id);
