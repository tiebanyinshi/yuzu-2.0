#!/usr/bin/env bash
# 手工核对：用 v8.2.4 的真代码建一报多，再用本仓库的代码升级（迁移 740，docs/V8222_TECHNICIANS.md 第 11 节）。不进 CI。
#
#   git worktree add ../yuzu-v824 v8.2.4 && ln -s "$PWD/node_modules" ../yuzu-v824/node_modules
#   ADMIN_URL=postgres://<用户>:<密码>@127.0.0.1:5432 scripts/verify-batch-overlap-upgrade.sh ../yuzu-v824
#   git worktree remove ../yuzu-v824
#
# 新建三个独立库 yuzu_verify_824a / _824b / _824c（已有的先删；库名都含 verify，只在本机的开发数据库上跑，别指到门店或正式库）。
# 三个库都用 v8.2.4 的迁移与真接口写数据（scripts/verify-batch-overlap-seed824.ts）：一报多（同一技师同一时段两位 + 一位不指定），
# 跑 v8.2.4 自己的自检（cli check）：
#   · a）只有一报多：本仓库的 cli migrate 直接升到最新（570 … 740），自检通过；
#   · b）只有一报多：先手工执行本仓库 570 … 730（= 8.2.5 … 8.2.17 的库），自检误报；再 cli migrate（只剩 740），自检通过；
#        740 的 SQL 再执行一次，标记、审计、预约整行都一样；
#   · c）一报多 + 两张单张技师预约 + 两张派对房预约（接口不让建重叠，之后用 SQL 把第二张挪到与第一张重叠，模拟坏数据）：
#        直接升到最新，一报多不再报，普通预约与派对房的重叠照旧报，只读核对脚本列出出处。
# 每个库升级前后给预约整行（8.2.4 就有的每一列，不含 technician_overlap）做快照，比对一字不差。
set -euo pipefail

OLD=$(cd "${1:?用法：verify-batch-overlap-upgrade.sh <v8.2.4 工作区>}" && pwd)
HEAD_DIR=$(cd "$(dirname "$0")/.." && pwd)
ADMIN_URL=${ADMIN_URL:?请设 ADMIN_URL（不含库名）}
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
[ "$(git -C "$OLD" rev-parse HEAD)" = "$(git -C "$OLD" rev-list -n1 v8.2.4)" ] || { echo "✗ $OLD 不是 v8.2.4"; exit 1; }
echo "v8.2.4 工作区：${OLD}（$(git -C "$OLD" rev-parse --short HEAD)）；本仓库：$(git -C "$HEAD_DIR" rev-parse --short HEAD)；输出目录：$OUT"

psql_db() { psql "$ADMIN_URL/$1" -v ON_ERROR_STOP=1 -qAt "${@:2}"; }
old_cli() { (cd "$OLD" && DATABASE_URL="$ADMIN_URL/$1" npx tsx src/server/cli.ts "${@:2}" 2>/dev/null) || true; }
head_cli() { (cd "$HEAD_DIR" && DATABASE_URL="$ADMIN_URL/$1" npx tsx src/server/cli.ts "${@:2}" 2>/dev/null) || true; }
booking_check() { grep '预约不重叠' || echo '（没有这一项）'; }
json_field() { node -e 'console.log(JSON.parse(process.argv[1])[process.argv[2]] ?? "")' "$1" "$2"; }

# 8.2.4 就有的列（不含 technician_overlap），整行快照
COLS=""
snapshot() { psql_db "$1" -c "COPY (SELECT $COLS FROM bookings ORDER BY id) TO STDOUT" > "$OUT/$1.$2.tsv"; }
compare() {
  if cmp -s "$OUT/$1.$2.tsv" "$OUT/$1.$3.tsv"; then echo "✓ 预约整行（除 technician_overlap）$2 → $3 一字不差（$(wc -l < "$OUT/$1.$3.tsv") 张）"
  else echo "✗ 预约整行有变化"; diff "$OUT/$1.$2.tsv" "$OUT/$1.$3.tsv"; exit 1; fi
}
flags() { psql_db "$1" -c "SELECT booking_no || ':' || technician_overlap FROM bookings ORDER BY id" | tr '\n' ' '; }
audits() { psql_db "$1" -c "SELECT count(*) FROM audit_logs WHERE action = 'booking_overlap_backfill'"; }
diagnose() {
  echo "只读核对脚本："
  PGOPTIONS='-c default_transaction_read_only=on' psql "$ADMIN_URL/$1" -v ON_ERROR_STOP=1 -q -P pager=off \
    -c "SELECT booking_a, booking_b, tech_no, a_before_570, b_before_570, a_evidence, b_evidence FROM ($(sed -e '/^--/d' -e 's/;$//' "$HEAD_DIR/scripts/diagnose-booking-overlap.sql")) d" | sed 's/^/  /'
}

build824() {
  local db=$1 conflicts=$2
  psql "$ADMIN_URL/postgres" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" 2>/dev/null
  echo
  echo "════ ${db}：v8.2.4 的代码写数据$([ "$conflicts" = 1 ] && echo '（另有普通预约与派对房的坏数据）')"
  local seeded
  seeded=$(cd "$OLD" && VERIFY_WITH_CONFLICTS=$conflicts DATABASE_URL="$ADMIN_URL/$db" npx tsx "$HEAD_DIR/scripts/verify-batch-overlap-seed824.ts" 2>/dev/null)
  echo "$seeded"
  if [ "$conflicts" = 1 ]; then
    # 模拟坏数据：第二张挪到与第一张同一时段（普通预约、派对房各一对）
    for pair in singleA:singleB roomA:roomB; do
      local a b
      a=$(json_field "$seeded" "${pair%%:*}")
      b=$(json_field "$seeded" "${pair##*:}")
      psql_db "$db" -c "UPDATE bookings b SET starts_at = a.starts_at, ends_at = a.ends_at FROM bookings a WHERE a.booking_no = '$a' AND b.booking_no = '$b'"
    done
  fi
  psql_db "$db" -c "SELECT '  ' || booking_no || ' ' || kind || ' 技师=' || coalesce(technician_id::text, '-') || ' ' || starts_at || ' client_key=' || client_key FROM bookings ORDER BY id"
  psql_db "$db" -c "SELECT '  idempotency_keys：' || key || ' ' || op_type || ' ref_id=' || ref_id FROM idempotency_keys WHERE op_type = 'booking_create' ORDER BY created_at"
  echo "v8.2.4 的自检：$(old_cli "$db" check | booking_check)"
  [ -n "$COLS" ] || COLS=$(psql_db "$db" -c "SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings'")
  snapshot "$db" before
}

# ── a）只有一报多：8.2.4 → 最新
build824 yuzu_verify_824a 0
echo "── a）本仓库的 migrate：$(head_cli yuzu_verify_824a migrate | tail -1)"
echo "最新的自检：$(head_cli yuzu_verify_824a check | booking_check)"
echo "标记：$(flags yuzu_verify_824a)；740 的审计 $(audits yuzu_verify_824a) 条"
snapshot yuzu_verify_824a after
compare yuzu_verify_824a before after

# ── b）只有一报多：8.2.4 → 8.2.17（570 … 730）→ 740
build824 yuzu_verify_824b 0
for path in "$HEAD_DIR"/src/server/migrations/*.sql; do
  f=$(basename "$path")
  [[ "$f" =~ ^(5[7-9][0-9]|6[0-9][0-9]|7[0-3][0-9])_.*\.sql$ ]] || continue
  [ "$(psql_db yuzu_verify_824b -c "SELECT count(*) FROM schema_migrations WHERE version = '$f'")" = 0 ] || continue
  psql_db yuzu_verify_824b -1 -f "$HEAD_DIR/src/server/migrations/$f" -c "INSERT INTO schema_migrations (version) VALUES ('$f')"
  echo "  已执行 $f"
done
echo "── b）8.2.17 的库（740 以前）的自检：$(head_cli yuzu_verify_824b check | booking_check)"
echo "标记：$(flags yuzu_verify_824b)"
echo "── b）本仓库的 migrate：$(head_cli yuzu_verify_824b migrate | tail -1)"
echo "跑 740 以后的自检：$(head_cli yuzu_verify_824b check | booking_check)"
FLAGS1=$(flags yuzu_verify_824b)
AUDIT1=$(audits yuzu_verify_824b)
echo "标记：${FLAGS1}；740 的审计 $AUDIT1 条"
snapshot yuzu_verify_824b after
compare yuzu_verify_824b before after
psql_db yuzu_verify_824b -1 -f "$HEAD_DIR/src/server/migrations/740_booking_batch_overlap.sql"
if [ "$(flags yuzu_verify_824b)" = "$FLAGS1" ] && [ "$(audits yuzu_verify_824b)" = "$AUDIT1" ]; then echo "✓ 740 再执行一次：标记与审计（$AUDIT1 条）一样"; else echo "✗ 740 再执行结果不同"; exit 1; fi
snapshot yuzu_verify_824b again
compare yuzu_verify_824b after again
echo "重跑以后的自检：$(head_cli yuzu_verify_824b check | booking_check)"

# ── c）一报多 + 坏数据：8.2.4 → 最新
build824 yuzu_verify_824c 1
echo "── c）本仓库的 migrate：$(head_cli yuzu_verify_824c migrate | tail -1)"
echo "最新的自检：$(head_cli yuzu_verify_824c check | booking_check)"
echo "标记：$(flags yuzu_verify_824c)；740 的审计 $(audits yuzu_verify_824c) 条"
diagnose yuzu_verify_824c
snapshot yuzu_verify_824c after
compare yuzu_verify_824c before after
