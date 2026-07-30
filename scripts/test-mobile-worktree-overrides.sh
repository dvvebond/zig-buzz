#!/usr/bin/env bash
# Regression tests for Expo worktree identity:
# - main checkout removes stale overrides;
# - linked worktrees receive stable, sanitized iOS/Android identifiers;
# - branch changes only change the display label;
# - app.config.ts rejects malformed environment overrides;
# - cleanup never targets production application identifiers.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/mobile-worktree-overrides.sh"
clean_script="$repo_root/scripts/mobile-worktree-clean.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}
pass() {
  printf 'ok: %s\n' "$1"
}

make_repo() {
  local repo="$1" branch="$2"
  mkdir -p "$repo/scripts" "$repo/apps/mobile"
  cp "$script" "$repo/scripts/mobile-worktree-overrides.sh"
  git -C "$repo" init -q -b "$branch"
  git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
}

make_worktree() {
  local repo="$1" wt="$2" branch="$3"
  git -C "$repo" worktree add -q -b "$branch" "$wt"
  mkdir -p "$wt/scripts" "$wt/apps/mobile"
  cp "$script" "$wt/scripts/mobile-worktree-overrides.sh"
}

repo="$tmp/main-checkout"
make_repo "$repo" main
echo stale > "$repo/apps/mobile/.env.worktree.local"
"$repo/scripts/mobile-worktree-overrides.sh" >/dev/null
if [[ -e "$repo/apps/mobile/.env.worktree.local" ]]; then
  fail "main checkout must remove stale worktree overrides"
else
  pass "main checkout removes stale worktree overrides"
fi

wt="$tmp/Feature_Work-1"
make_worktree "$repo" "$wt" "tho/Fix_Thing-2"
out="$("$wt/scripts/mobile-worktree-overrides.sh")"
env_file="$wt/apps/mobile/.env.worktree.local"
[[ -f "$env_file" ]] || fail "worktree must write the Expo environment file"
grep -q '^BUZZ_MOBILE_IOS_BUNDLE_IDENTIFIER=com\.buzz\.buzzMobile\.feature-work-1$' "$env_file" \
  && pass "iOS bundle identifier keys to the sanitized worktree directory" \
  || fail "unexpected iOS worktree identifier: $(cat "$env_file")"
grep -q '^BUZZ_MOBILE_ANDROID_PACKAGE=xyz\.block\.buzz\.mobile\.feature_work_1$' "$env_file" \
  && pass "Android package keys to the sanitized worktree directory" \
  || fail "unexpected Android worktree identifier: $(cat "$env_file")"
grep -q '^BUZZ_MOBILE_APP_NAME=Buzz-Fix_Thing-2$' "$env_file" \
  && pass "display name carries a safe branch label" \
  || fail "unexpected worktree display name: $(cat "$env_file")"
printf '%s' "$out" | grep -q 'Worktree Feature_Work-1' \
  && pass "worktree run reports its directory identity" \
  || fail "worktree run must report the worktree name"

git -C "$wt" checkout -q -b "another/branch-name"
"$wt/scripts/mobile-worktree-overrides.sh" >/dev/null
grep -q '^BUZZ_MOBILE_IOS_BUNDLE_IDENTIFIER=com\.buzz\.buzzMobile\.feature-work-1$' "$env_file" \
  && grep -q '^BUZZ_MOBILE_ANDROID_PACKAGE=xyz\.block\.buzz\.mobile\.feature_work_1$' "$env_file" \
  && pass "branch switch preserves installed application identity" \
  || fail "application identity changed with the branch"
grep -q '^BUZZ_MOBILE_APP_NAME=Buzz-branch-name$' "$env_file" \
  && pass "branch switch refreshes the display label" \
  || fail "display label did not follow the branch"

git -C "$wt" checkout -q -b "it's-\$a\"branch"
"$wt/scripts/mobile-worktree-overrides.sh" >/dev/null
grep -q '^BUZZ_MOBILE_APP_NAME=Buzz-it-s-a-branch$' "$env_file" \
  && pass "shell metacharacters are removed from the display label" \
  || fail "display label was not safely sanitized: $(cat "$env_file")"

sha="$(git -C "$wt" rev-parse --short HEAD)"
git -C "$wt" checkout -q --detach
"$wt/scripts/mobile-worktree-overrides.sh" >/dev/null
grep -q "^BUZZ_MOBILE_APP_NAME=Buzz-${sha}$" "$env_file" \
  && pass "detached HEAD uses the short commit SHA as label" \
  || fail "detached HEAD label was not the short SHA"

wt2="$tmp/2fast"
make_worktree "$repo" "$wt2" some-branch
"$wt2/scripts/mobile-worktree-overrides.sh" >/dev/null
grep -q '^BUZZ_MOBILE_ANDROID_PACKAGE=xyz\.block\.buzz\.mobile\.w_2fast$' \
  "$wt2/apps/mobile/.env.worktree.local" \
  && pass "digit-leading worktree name receives a valid Android segment" \
  || fail "digit-leading Android segment is invalid"

git -C "$repo_root" check-ignore -q apps/mobile/.env.worktree.local \
  && pass "Expo worktree environment file is gitignored" \
  || fail "apps/mobile/.env.worktree.local must be gitignored"
grep -q 'BUZZ_MOBILE_IOS_BUNDLE_IDENTIFIER' "$repo_root/apps/mobile/app.config.ts" \
  && grep -q 'BUZZ_MOBILE_ANDROID_PACKAGE' "$repo_root/apps/mobile/app.config.ts" \
  && pass "Expo dynamic config consumes both identity overrides" \
  || fail "Expo dynamic config must consume the worktree identities"
grep -Eq '^\s+\./scripts/mobile-worktree-overrides\.sh$' "$repo_root/Justfile" \
  && pass "mobile-dev generates the worktree identity" \
  || fail "Justfile mobile-dev must generate worktree identity"
grep -Eq '^\s+\./scripts/mobile-worktree-clean\.sh$' "$repo_root/Justfile" \
  && pass "mobile-clean retains safe stale-install cleanup" \
  || fail "Justfile mobile-clean must call the safe cleanup script"

(
  cd "$repo_root"
  BUZZ_MOBILE_IOS_BUNDLE_IDENTIFIER=not-safe \
    pnpm --filter @buzz/mobile exec expo config --type public >/dev/null 2>&1
) && fail "Expo config accepted a malformed iOS bundle identifier" \
  || pass "Expo config rejects malformed identity overrides"

stub_bin="$tmp/stub-bin"
mkdir -p "$stub_bin"
cat > "$stub_bin/adb" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then
  printf 'List of devices attached\nemulator-5554\tdevice\n'
  exit 0
fi
if [[ "$3 $4 $5" == "shell pm list" ]]; then
  printf 'package:xyz.block.buzz.mobile\n'
  printf 'package:xyz.block.buzz.mobile.feature_work_1\n'
  printf 'package:xyz.block.buzz.mobile.w_2fast\n'
  printf 'package:com.android.settings\n'
  exit 0
fi
if [[ "$3" == "uninstall" ]]; then
  echo Success
fi
STUB
chmod +x "$stub_bin/adb"

clean_out="$(PATH="$stub_bin:/usr/bin:/bin" bash "$clean_script" --dry-run)"
printf '%s\n' "$clean_out" | grep -q 'xyz\.block\.buzz\.mobile\.feature_work_1' \
  && pass "cleanup targets suffixed Android worktree installs" \
  || fail "cleanup did not report a suffixed worktree install"
if printf '%s\n' "$clean_out" | grep -Eq '(would uninstall|uninstalling).*xyz\.block\.buzz\.mobile$'; then
  fail "cleanup must never target the production Android app"
else
  pass "cleanup preserves the production Android app"
fi
if printf '%s\n' "$clean_out" | grep -q 'com\.android\.settings'; then
  fail "cleanup must never target unrelated packages"
else
  pass "cleanup ignores unrelated packages"
fi

if [[ "$failures" -gt 0 ]]; then
  printf '%d failure(s)\n' "$failures" >&2
  exit 1
fi
printf 'all Expo mobile worktree identity contract checks passed\n'
