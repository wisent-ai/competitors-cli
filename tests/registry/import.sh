#!/bin/sh
# Real run of registry import and the registry filters through the CLI: import
# a file of competitors into a fresh registry, refuse a file that repeats a held
# id without touching the registry, list by tag, region, category and state,
# and compare against a filtered registry. Every step runs src/cli.js as a user
# would and reads the registry file it left behind. Output goes to
# .build/real-tests/registry-import/<stamp>/ with report.txt naming the revision.
#
# The contract's statuses are declared by the caller, as for the usage test:
# COMPETITORS_TEST_USAGE_EXIT and COMPETITORS_TEST_FAILURE_EXIT.
set -u
: "${COMPETITORS_TEST_USAGE_EXIT:?declare the usage exit status of the CLI contract}"
: "${COMPETITORS_TEST_FAILURE_EXIT:?declare the operational failure exit status of the CLI contract}"
usage_exit=$COMPETITORS_TEST_USAGE_EXIT
failure_exit=$COMPETITORS_TEST_FAILURE_EXIT
success_exit=$(true; echo $?)
root=$(cd "$(dirname "$0")/../.." && pwd)
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
out="$root/.build/real-tests/registry-import/$stamp"
mkdir -p "$out"
report="$out/report.txt"
registry="$out/competitors.registry.json"
cli() { node "$root/src/cli.js" "$@"; }
failed=false
step() { echo "$*" >>"$report"; }
check() {
  name=$1; shift
  if "$@"; then step "ok   $name"; else step "FAIL $name"; failed=true; fi
}
run() {
  label=$1; shift
  cli "$@" >"$out/$label.out" 2>"$out/$label.err"
  echo $? >"$out/$label.status"
}
status() { [ "$(cat "$out/$1.status")" = "$2" ]; }
says() { grep -q -- "$2" "$out/$1.out" "$out/$1.err"; }
lacks() { ! grep -q -- "$2" "$out/$1.out"; }

{
  echo "competitors-cli registry import and filters"
  echo "revision: $(git -C "$root" rev-parse HEAD)"
  echo "worktree changes: $(git -C "$root" status --porcelain -- src tests/registry | wc -l | tr -d ' ')"
  echo "node: $(node --version)"
  echo "registry: $registry"
} >"$report"

cat >"$out/batch.json" <<'JSON'
{"competitors": [
  {"name": "Alternative", "domains": ["alternative.example"], "tags": ["voice"], "regions": ["EU"]},
  {"name": "Bystander", "domains": ["bystander.example"], "tags": ["chat"], "regions": ["US"], "active": false},
  {"name": "Corner", "domains": ["corner.example"], "tags": ["chat"], "regions": ["global"]}
]}
JSON
printf '%s\n' '[{"name": "Delta"}, {"name": "Alternative"}]' >"$out/repeat.json"
printf '%s\n' '{"name": "Example", "features": {"Voice": true}, "pricing": {"Monthly": "$10"}}' >"$out/ours.json"
imported=$(grep -c '"name"' "$out/batch.json")

run import registry import --competitors "$out/batch.json" --registry "$registry"
check "import exits with success" status import "$success_exit"
check "the registry holds every imported competitor" grep -q '"corner"' "$registry"
check "import answers what it added" says import '"bystander"'
cp "$registry" "$out/after-import.json"

run repeat registry import --competitors "$out/repeat.json" --registry "$registry"
check "an import naming a held id is refused" status repeat "$failure_exit"
check "the refusal names the held id" says repeat "import refused, nothing was added: alternative"
check "a refused import leaves the registry as it was" cmp -s "$registry" "$out/after-import.json"

run by-tag registry list --tag VOICE --registry "$registry"
check "list by tag exits with success" status by-tag "$success_exit"
check "a tag keeps the competitor carrying it, ignoring case" says by-tag '"alternative"'
check "a tag drops competitors without it" lacks by-tag '"bystander"'
check "a filtered list says how many the registry holds" says by-tag "\"held\": $imported"

run by-region registry list --region us --region eu --registry "$registry"
check "repeated regions keep either" says by-region '"bystander"'
check "repeated regions drop the rest" lacks by-region '"corner"'

run inactive registry list --inactive --registry "$registry" --text
check "--inactive lists the inactive competitor" says inactive "bystander"
check "--inactive drops active competitors" lacks inactive "corner"

run both-states registry list --active --inactive --registry "$registry"
check "--active with --inactive is a usage error" status both-states "$usage_exit"

run compare-filtered compare --product "$out/ours.json" --registry "$registry" --tag chat --active --format json
check "compare against a filtered registry exits with success" status compare-filtered "$success_exit"
check "the comparison holds the matching competitor" says compare-filtered "Corner"
check "the comparison leaves out filtered competitors" lacks compare-filtered "Bystander"

run compare-none compare --product "$out/ours.json" --registry "$registry" --region mars
check "a filter matching nothing fails" status compare-none "$failure_exit"
check "the failure names the filter" says compare-none "matches region mars"

run compare-file compare --product "$out/ours.json" --competitors "$out/batch.json" --tag chat
check "filters with --competitors are a usage error" status compare-file "$usage_exit"

step "output: $out"
cat "$report"
if $failed; then exit "$failure_exit"; fi
