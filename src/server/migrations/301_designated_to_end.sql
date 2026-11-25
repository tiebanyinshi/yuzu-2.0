-- 8.1.38（docs/V8138.md 第 2 节）：客人指定挑选（点钟）的技师下钟后排到队尾（店主 2026-11-25《门店系统需求梳理与优化方案》，规则已确认）。
-- 「点钟后的排位」加一种「下钟后排到队尾」（finish），代码里的默认改成它；库里存过钟房规则、点钟后的排位还是原来默认的「不动牌」（keep）的，
-- 改成新规则（店主定的是全公司的规则；要改回的在「后台 → 技师 → 钟房规则」改）。选过「轮到就排尾」「派点钟就排尾」的不动。
-- 风险已知：改的是设置里钟房规则的一项（不是账本、不是单据），只把 keep 改成 finish，其余各项原样保留。
-- 回滚：docs/rollback/301_designated_to_end.down.sql。

UPDATE settings SET value = jsonb_set(value, '{afterDesignated}', '"finish"')
WHERE key = 'clockroom_rules' AND value->>'afterDesignated' = 'keep';

UPDATE store_settings SET value = jsonb_set(value, '{afterDesignated}', '"finish"')
WHERE key = 'clockroom_rules' AND value->>'afterDesignated' = 'keep';
