#!/bin/sh
# Real lifecycle of the competitor registry through the CLI: create a
# registry file, add, show, edit, compare against it, remove, and the
# refusals a caller meets. Every step runs src/cli.js as a user would and
# reads the registry file it left behind. Output goes to
# .build/real-tests/registry/<stamp>/ with report.txt naming the revision.
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
out="$root/.build/real-tests/registry/$stamp"
mkdir -p "$out"
report="$out/report.txt"
registry="$out/competitors.registry.json"
cli() { node "$root/src/cli.js" "$@"; }
failed=0
step() { echo "$1" >>"$report"; }
check() {
  name=$1; shift
  if "$@"; then step "ok   $name"; else step "FAIL $name"; failed=1; fi
}
# Runs the CLI, keeps stdout, stderr and the exit status beside the report.
run() {
  label=$1; shift
  cli "$@" >"$out/$label.out" 2>"$out/$label.err"
  echo $? >"$out/$label.status"
}
status() { [ "$(cat "$out/$1.status")" = "$2" ]; }
says() { grep -q -- "$2" "$out/$1.out" "$out/$1.err"; }

{
  echo "competitors-cli registry lifecycle"
  echo "revision: $(git -C "$root" rev-parse HEAD)"
  echo "worktree changes: $(git -C "$root" status --porcelain -- src tests/registry | wc -l | tr -d ' ')"
  echo "node: $(node --version)"
  echo "registry: $registry"
} >"$report"

printf '%s\n' '{"name": "Alternative", "domains": ["alternative.example"], "features": {"Local mode": false, "Voice": true}, "pricing": {"Monthly": "$15"}}' >"$out/alternative.json"
printf '%s\n' '{"regions": ["EU"]}' >"$out/changes.json"
printf '%s\n' '{"name": "Example", "features": {"Local mode": true, "Voice": true}, "pricing": {"Monthly": "$10"}}' >"$out/ours.json"

run unnamed registry list
check "a registry nobody names is refused" status unnamed 1
check "the refusal says how to name it" says unnamed "no competitor registry is named"

run empty-compare compare --product "$out/ours.json" --registry "$registry"
check "compare refuses an empty registry" status empty-compare 1

run add registry add --competitor "$out/alternative.json" --registry "$registry" --text
check "add exits 0" status add 0
check "the registry file exists after add" test -s "$registry"
check "the file holds the added competitor" grep -q '"Alternative"' "$registry"

run add-again registry add --competitor "$out/alternative.json" --registry "$registry"
check "adding the same id twice is refused" status add-again 1

run list registry list --registry "$registry" --text
check "list exits 0" status list 0
check "list names the competitor" says list Alternative

id=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$registry" | head -n 1)
step "id: $id"
check "the added competitor carries an id" test -n "$id"

run show registry show "$id" --registry "$registry" --text
check "show exits 0" status show 0
check "show prints the domain" says show alternative.example

run edit registry edit "$id" --competitor "$out/changes.json" --registry "$registry"
check "edit exits 0" status edit 0
check "the file holds the edited region" grep -q '"EU"' "$registry"

run compare compare --product "$out/ours.json" --registry "$registry" --format markdown
check "compare against the registry exits 0" status compare 0
check "the comparison names the competitor" says compare Alternative

run both compare --product "$out/ours.json" --registry "$registry" --competitors "$out/alternative.json"
check "compare refuses two competitor sources" status both 2

run unknown registry show nobody --registry "$registry"
check "an unknown id is refused" status unknown 1
check "the refusal names the ids the file holds" says unknown "$id"

run remove registry remove "$id" --registry "$registry"
check "remove exits 0" status remove 0
check "the file no longer holds the competitor" sh -c "! grep -q '\"Alternative\"' '$registry'"

run removed registry show "$id" --registry "$registry"
check "a removed competitor is gone" status removed 1

if [ "$failed" -eq 0 ]; then step "PASS"; echo "PASS: $report"; exit 0; fi
step "FAIL"
echo "FAIL: $report"
exit 1
