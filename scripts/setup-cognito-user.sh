#!/usr/bin/env bash
set -euo pipefail

aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
aws_profile="${AWS_PROFILE:-}"
user_pool_id="${COGNITO_USER_POOL_ID:-}"
username="${COGNITO_USERNAME:-}"
email="${COGNITO_EMAIL:-}"
password="${COGNITO_PASSWORD:-}"
group_name="${COGNITO_GROUP:-}"
tenant_id="${COGNITO_TENANT_ID:-}"
action="${COGNITO_USER_ACTION:-add}"

usage() {
  cat <<'EOF'
Usage: scripts/setup-cognito-user.sh [options]

Adds a Cognito user to a group or removes a Cognito user from a group.
This script does not create user pools, app clients, or groups.

Required input:
  --region REGION          AWS region. Env: AWS_REGION or AWS_DEFAULT_REGION.
  --user-pool-id ID        Cognito user pool id. Env: COGNITO_USER_POOL_ID.
  --username USER          Cognito username. For email-based pools, use the email. Env: COGNITO_USERNAME.
  --group NAME             Cognito group name. Env: COGNITO_GROUP.

Required for --action add when the user does not already exist:
  --password PASSWORD      Permanent password for the user. Env: COGNITO_PASSWORD.

Options:
  --profile PROFILE        AWS CLI profile. Env: AWS_PROFILE.
  --action add|delete      Add user to group or remove user from group. Default: add.
  --email EMAIL            Email attribute. Defaults to --username.
  --tenant-id VALUE        Optional custom:tenant_id attribute to set on add.
  -h, --help               Show this help.

Examples:
  scripts/setup-cognito-user.sh \
    --region us-east-1 \
    --user-pool-id us-east-1_EXAMPLE \
    --username reader@example.com \
    --password 'ChangeMe123!' \
    --group finance-readers

  scripts/setup-cognito-user.sh \
    --region us-east-1 \
    --user-pool-id us-east-1_EXAMPLE \
    --username reader@example.com \
    --group finance-readers \
    --action delete
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

aws_cmd() {
  local args=(--region "${aws_region}" --output json --no-cli-pager)
  if [[ -n "${aws_profile}" ]]; then
    args=(--profile "${aws_profile}" "${args[@]}")
  fi
  aws "${args[@]}" "$@"
}

user_exists() {
  local error_file="$1"
  : >"${error_file}"
  aws_cmd cognito-idp admin-get-user \
    --user-pool-id "${user_pool_id}" \
    --username "${username}" >/dev/null 2>"${error_file}"
}

create_or_update_user() {
  local tmp_dir="$1"
  local error_file="${tmp_dir}/admin-get-user.err"
  local user_email="${email:-${username}}"
  local attributes=(Name=email,Value="${user_email}" Name=email_verified,Value=true)
  if [[ -n "${tenant_id}" ]]; then
    attributes+=(Name=custom:tenant_id,Value="${tenant_id}")
  fi

  if user_exists "${error_file}"; then
    printf 'User %s already exists; updating password and attributes.\n' "${username}"
    aws_cmd cognito-idp admin-update-user-attributes \
      --user-pool-id "${user_pool_id}" \
      --username "${username}" \
      --user-attributes "${attributes[@]}" >/dev/null
  elif grep -q "UserNotFoundException" "${error_file}"; then
    [[ -n "${password}" ]] || fail "--password is required when creating a new user"
    printf 'Creating user %s...\n' "${username}"
    aws_cmd cognito-idp admin-create-user \
      --user-pool-id "${user_pool_id}" \
      --username "${username}" \
      --user-attributes "${attributes[@]}" \
      --message-action SUPPRESS \
      --temporary-password "${password}" >/dev/null
  else
    fail "failed to inspect user ${username}: $(head -c 1000 "${error_file}")"
  fi

  if [[ -n "${password}" ]]; then
    aws_cmd cognito-idp admin-set-user-password \
      --user-pool-id "${user_pool_id}" \
      --username "${username}" \
      --password "${password}" \
      --permanent >/dev/null
  fi

  printf 'Adding user %s to group %s...\n' "${username}" "${group_name}"
  aws_cmd cognito-idp admin-add-user-to-group \
    --user-pool-id "${user_pool_id}" \
    --username "${username}" \
    --group-name "${group_name}" >/dev/null
}

remove_user_from_group() {
  printf 'Removing user %s from group %s...\n' "${username}" "${group_name}"
  aws_cmd cognito-idp admin-remove-user-from-group \
    --user-pool-id "${user_pool_id}" \
    --username "${username}" \
    --group-name "${group_name}" >/dev/null
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      [[ $# -ge 2 ]] || fail "--region requires a value"
      aws_region="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || fail "--profile requires a value"
      aws_profile="$2"
      shift 2
      ;;
    --user-pool-id)
      [[ $# -ge 2 ]] || fail "--user-pool-id requires a value"
      user_pool_id="$2"
      shift 2
      ;;
    --username)
      [[ $# -ge 2 ]] || fail "--username requires a value"
      username="$2"
      shift 2
      ;;
    --email)
      [[ $# -ge 2 ]] || fail "--email requires a value"
      email="$2"
      shift 2
      ;;
    --password)
      [[ $# -ge 2 ]] || fail "--password requires a value"
      password="$2"
      shift 2
      ;;
    --group)
      [[ $# -ge 2 ]] || fail "--group requires a value"
      group_name="$2"
      shift 2
      ;;
    --tenant-id)
      [[ $# -ge 2 ]] || fail "--tenant-id requires a value"
      tenant_id="$2"
      shift 2
      ;;
    --action)
      [[ $# -ge 2 ]] || fail "--action requires a value"
      action="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "${action}" in
  add|create)
    action="add"
    ;;
  delete|remove)
    action="delete"
    ;;
  *)
    fail "--action must be add or delete"
    ;;
esac

require_command aws
[[ -n "${aws_region}" ]] || fail "set region via --region, AWS_REGION, or AWS_DEFAULT_REGION"
[[ -n "${user_pool_id}" ]] || fail "set user pool id via --user-pool-id or COGNITO_USER_POOL_ID"
[[ -n "${username}" ]] || fail "set username via --username or COGNITO_USERNAME"
[[ -n "${group_name}" ]] || fail "set group via --group or COGNITO_GROUP"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quacklake-cognito-user.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

if [[ "${action}" == "add" ]]; then
  create_or_update_user "${tmp_dir}"
  printf 'User %s is in group %s.\n' "${username}" "${group_name}"
else
  remove_user_from_group
  printf 'User %s was removed from group %s.\n' "${username}" "${group_name}"
fi
