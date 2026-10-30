# Live verification names its model explicitly. Nothing in this repository picks a
# provider for you: a quiet default is how a routine run drains a paid account.
sprout_live_model() {
  local value="${SPROUT_VERIFY_PI_MODEL:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(
      sed -n 's/^SPROUT_VERIFY_PI_MODEL=//p' .env |
        tail -1 |
        sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/[[:space:]]*$//'
    )"
  fi
  if [ -z "$value" ]; then
    cat >&2 <<'EOF'
SPROUT_VERIFY_PI_MODEL is not set.

Live verification talks to a real provider, so it refuses to guess which one.
Name the model, either for this invocation or in this checkout's .env:

    SPROUT_VERIFY_PI_MODEL=provider/model bash scripts/verify-live/<gate>.sh
    printf '%s\n' 'SPROUT_VERIFY_PI_MODEL=provider/model' >> .env

`bash scripts/verify.sh` does not need it: routine gates run the local model
fixture and make no paid calls.
EOF
    return 2
  fi
  export SPROUT_VERIFY_PI_MODEL="$value"
}
