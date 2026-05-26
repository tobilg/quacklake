#!/usr/bin/env bash
set -euo pipefail

aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
aws_profile="${AWS_PROFILE:-}"
pool_name="${COGNITO_USER_POOL_NAME:-quacklake}"
client_name="${COGNITO_APP_CLIENT_NAME:-quacklake-quack}"
user_pool_id="${COGNITO_USER_POOL_ID:-}"
readers_group="${COGNITO_READERS_GROUP:-quacklake-readers}"
admins_group="${COGNITO_ADMINS_GROUP:-quacklake-admins}"
output_file="${OUTPUT_FILE:-}"
test_username="${COGNITO_TEST_USERNAME:-}"
test_password="${COGNITO_TEST_PASSWORD:-}"
test_email="${COGNITO_TEST_EMAIL:-}"
test_tenant_id="${COGNITO_TEST_TENANT_ID:-}"
test_user_group="${COGNITO_TEST_USER_GROUP:-readers}"

usage() {
  cat <<'EOF'
Usage: scripts/setup-cognito.sh [options]

Creates AWS Cognito resources suitable for quacklake OIDC authentication.
By default this creates a new user pool, an app client without a client secret,
and read-only/admin groups. It can also create a test user.

Required input:
  --region REGION             AWS region. Env: AWS_REGION or AWS_DEFAULT_REGION.

Options:
  --profile PROFILE           AWS CLI profile. Env: AWS_PROFILE.
  --pool-name NAME            New user pool name. Default: quacklake.
  --user-pool-id ID           Reuse an existing user pool instead of creating one.
  --client-name NAME          App client name. Default: quacklake-quack.
  --readers-group NAME        Cognito group for read-only users. Default: quacklake-readers.
  --admins-group NAME         Cognito group for admin users. Default: quacklake-admins.
  --output-file PATH          Write setup summary JSON for scripts/register-cognito-idp.sh.
  --test-username USER        Optional test user username. For the default pool, use an email.
  --test-password PASSWORD    Optional permanent password for the test user.
  --test-email EMAIL          Optional email attribute. Defaults to --test-username.
  --test-tenant-id VALUE      Optional custom:tenant_id attribute for the test user.
  --test-user-group GROUP     readers, admins, or both. Default: readers.
  -h, --help                  Show this help.

Examples:
  scripts/setup-cognito.sh \
    --region us-east-1 \
    --output-file quacklake-cognito.json

  scripts/setup-cognito.sh \
    --region us-east-1 \
    --test-username reader@example.com \
    --test-password 'ChangeMe123!' \
    --test-user-group readers \
    --output-file quacklake-cognito.json
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

json_field() {
  local field_path="$1"
  node -e '
const fieldPath = process.argv[1];
let body = "";
process.stdin.on("data", (chunk) => {
  body += chunk;
});
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    process.exit(0);
  }
  let value = data;
  for (const part of fieldPath.split(".")) {
    if (!part) continue;
    value = value?.[part];
  }
  if (value !== undefined && value !== null) {
    process.stdout.write(String(value));
  }
});
' "${field_path}"
}

pool_input_json() {
  node - "$pool_name" <<'NODE'
const poolName = process.argv[2];
process.stdout.write(JSON.stringify({
  PoolName: poolName,
  DeletionProtection: "INACTIVE",
  UsernameAttributes: ["email"],
  AutoVerifiedAttributes: ["email"],
  UsernameConfiguration: {
    CaseSensitive: false,
  },
  Policies: {
    PasswordPolicy: {
      MinimumLength: 12,
      RequireUppercase: true,
      RequireLowercase: true,
      RequireNumbers: true,
      RequireSymbols: false,
      TemporaryPasswordValidityDays: 7,
    },
  },
  AdminCreateUserConfig: {
    AllowAdminCreateUserOnly: true,
  },
  Schema: [
    {
      Name: "tenant_id",
      AttributeDataType: "String",
      Mutable: true,
      Required: false,
      StringAttributeConstraints: {
        MinLength: "1",
        MaxLength: "128",
      },
    },
  ],
  AccountRecoverySetting: {
    RecoveryMechanisms: [
      {
        Name: "verified_email",
        Priority: 1,
      },
    ],
  },
}));
NODE
}

summary_json() {
  node - "$aws_region" "$pool_name" "$created_user_pool" "$user_pool_id" "$issuer" "$jwks_uri" "$client_name" "$app_client_id" "$readers_group" "$admins_group" "$test_username" "$test_user_group" <<'NODE'
const [
  region,
  poolName,
  createdUserPool,
  userPoolId,
  issuer,
  jwksUri,
  clientName,
  appClientId,
  readersGroup,
  adminsGroup,
  testUsername,
  testUserGroup,
] = process.argv.slice(2);
const output = {
  region,
  userPoolName: poolName,
  userPoolId,
  issuer,
  jwksUri,
  appClientName: clientName,
  appClientId,
  audience: appClientId,
  tokenType: "id_token",
  readersGroup,
  adminsGroup,
  createdUserPool: createdUserPool === "true",
  createdAt: new Date().toISOString(),
};
if (testUsername) {
  output.testUser = {
    username: testUsername,
    group: testUserGroup,
  };
}
process.stdout.write(JSON.stringify(output, null, 2));
process.stdout.write("\n");
NODE
}

ensure_group() {
  local group_name="$1"
  local description="$2"
  local error_file="${tmp_dir}/group-${group_name//[^A-Za-z0-9_.-]/_}.err"
  if aws_cmd cognito-idp get-group --user-pool-id "${user_pool_id}" --group-name "${group_name}" >/dev/null 2>"${error_file}"; then
    printf 'Cognito group %s already exists.\n' "${group_name}"
    return
  fi
  if grep -q "ResourceNotFoundException" "${error_file}"; then
    printf 'Creating Cognito group %s...\n' "${group_name}"
    aws_cmd cognito-idp create-group \
      --user-pool-id "${user_pool_id}" \
      --group-name "${group_name}" \
      --description "${description}" >/dev/null
    return
  fi
  fail "failed to inspect Cognito group ${group_name}: $(head -c 1000 "${error_file}")"
}

admin_add_user_to_group() {
  local group_name="$1"
  printf 'Adding test user %s to group %s...\n' "${test_username}" "${group_name}"
  aws_cmd cognito-idp admin-add-user-to-group \
    --user-pool-id "${user_pool_id}" \
    --username "${test_username}" \
    --group-name "${group_name}" >/dev/null
}

create_or_update_test_user() {
  local error_file="${tmp_dir}/admin-get-user.err"
  local email="${test_email:-${test_username}}"
  local attributes=(Name=email,Value="${email}" Name=email_verified,Value=true)
  if [[ -n "${test_tenant_id}" ]]; then
    attributes+=(Name=custom:tenant_id,Value="${test_tenant_id}")
  fi

  if aws_cmd cognito-idp admin-get-user --user-pool-id "${user_pool_id}" --username "${test_username}" >/dev/null 2>"${error_file}"; then
    printf 'Test user %s already exists; updating password and group membership.\n' "${test_username}"
  elif grep -q "UserNotFoundException" "${error_file}"; then
    printf 'Creating test user %s...\n' "${test_username}"
    aws_cmd cognito-idp admin-create-user \
      --user-pool-id "${user_pool_id}" \
      --username "${test_username}" \
      --user-attributes "${attributes[@]}" \
      --message-action SUPPRESS \
      --temporary-password "${test_password}" >/dev/null
  else
    fail "failed to inspect test user ${test_username}: $(head -c 1000 "${error_file}")"
  fi

  aws_cmd cognito-idp admin-set-user-password \
    --user-pool-id "${user_pool_id}" \
    --username "${test_username}" \
    --password "${test_password}" \
    --permanent >/dev/null

  case "${test_user_group}" in
    readers|reader)
      admin_add_user_to_group "${readers_group}"
      ;;
    admins|admin)
      admin_add_user_to_group "${admins_group}"
      ;;
    both)
      admin_add_user_to_group "${readers_group}"
      admin_add_user_to_group "${admins_group}"
      ;;
    *)
      fail "--test-user-group must be readers, admins, or both"
      ;;
  esac
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
    --pool-name)
      [[ $# -ge 2 ]] || fail "--pool-name requires a value"
      pool_name="$2"
      shift 2
      ;;
    --user-pool-id)
      [[ $# -ge 2 ]] || fail "--user-pool-id requires a value"
      user_pool_id="$2"
      shift 2
      ;;
    --client-name)
      [[ $# -ge 2 ]] || fail "--client-name requires a value"
      client_name="$2"
      shift 2
      ;;
    --readers-group)
      [[ $# -ge 2 ]] || fail "--readers-group requires a value"
      readers_group="$2"
      shift 2
      ;;
    --admins-group)
      [[ $# -ge 2 ]] || fail "--admins-group requires a value"
      admins_group="$2"
      shift 2
      ;;
    --output-file)
      [[ $# -ge 2 ]] || fail "--output-file requires a value"
      output_file="$2"
      shift 2
      ;;
    --test-username)
      [[ $# -ge 2 ]] || fail "--test-username requires a value"
      test_username="$2"
      shift 2
      ;;
    --test-password)
      [[ $# -ge 2 ]] || fail "--test-password requires a value"
      test_password="$2"
      shift 2
      ;;
    --test-email)
      [[ $# -ge 2 ]] || fail "--test-email requires a value"
      test_email="$2"
      shift 2
      ;;
    --test-tenant-id)
      [[ $# -ge 2 ]] || fail "--test-tenant-id requires a value"
      test_tenant_id="$2"
      shift 2
      ;;
    --test-user-group)
      [[ $# -ge 2 ]] || fail "--test-user-group requires a value"
      test_user_group="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

require_command aws
require_command node

[[ -n "${aws_region}" ]] || fail "set AWS_REGION, AWS_DEFAULT_REGION, or pass --region"
[[ -n "${pool_name}" ]] || fail "pool name must not be empty"
[[ -n "${client_name}" ]] || fail "client name must not be empty"
[[ -n "${readers_group}" ]] || fail "readers group must not be empty"
[[ -n "${admins_group}" ]] || fail "admins group must not be empty"
if [[ -n "${test_username}" || -n "${test_password}" ]]; then
  [[ -n "${test_username}" ]] || fail "--test-username is required when --test-password is set"
  [[ -n "${test_password}" ]] || fail "--test-password is required when --test-username is set"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quacklake-cognito.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

created_user_pool="false"
if [[ -n "${user_pool_id}" ]]; then
  printf 'Using existing Cognito user pool %s...\n' "${user_pool_id}"
else
  printf 'Creating Cognito user pool %s in %s...\n' "${pool_name}" "${aws_region}"
  pool_input="${tmp_dir}/create-user-pool.json"
  pool_input_json >"${pool_input}"
  pool_response="$(aws_cmd cognito-idp create-user-pool --cli-input-json "file://${pool_input}")"
  user_pool_id="$(printf '%s' "${pool_response}" | json_field UserPool.Id)"
  [[ -n "${user_pool_id}" ]] || fail "create-user-pool response did not contain UserPool.Id"
  created_user_pool="true"
fi

issuer="https://cognito-idp.${aws_region}.amazonaws.com/${user_pool_id}"
jwks_uri="${issuer}/.well-known/jwks.json"

printf 'Creating app client %s without a client secret...\n' "${client_name}"
client_response="$(
  aws_cmd cognito-idp create-user-pool-client \
    --user-pool-id "${user_pool_id}" \
    --client-name "${client_name}" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --supported-identity-providers COGNITO \
    --access-token-validity 60 \
    --id-token-validity 60 \
    --refresh-token-validity 30 \
    --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=days
)"
app_client_id="$(printf '%s' "${client_response}" | json_field UserPoolClient.ClientId)"
[[ -n "${app_client_id}" ]] || fail "create-user-pool-client response did not contain UserPoolClient.ClientId"

ensure_group "${readers_group}" "quacklake read-only catalog users"
ensure_group "${admins_group}" "quacklake catalog administrators"

if [[ -n "${test_username}" ]]; then
  create_or_update_test_user
fi

summary="$(summary_json)"
if [[ -n "${output_file}" ]]; then
  printf '%s\n' "${summary}" >"${output_file}"
fi

printf '\nCognito setup complete.\n'
printf 'User pool ID: %s\n' "${user_pool_id}"
printf 'Issuer: %s\n' "${issuer}"
printf 'JWKS URI: %s\n' "${jwks_uri}"
printf 'App client ID / ID-token audience: %s\n' "${app_client_id}"
printf 'Readers group: %s\n' "${readers_group}"
printf 'Admins group: %s\n' "${admins_group}"
if [[ -n "${output_file}" ]]; then
  printf 'Wrote setup summary to %s\n' "${output_file}"
fi

printf '\nRegister this provider with quacklake:\n'
if [[ -n "${output_file}" ]]; then
  printf "scripts/register-cognito-idp.sh --worker-url <worker-url> --admin-token <admin-token> --catalog-id <catalog-id> --cognito-file %q\n" "${output_file}"
else
  printf "scripts/register-cognito-idp.sh --worker-url <worker-url> --admin-token <admin-token> --catalog-id <catalog-id> --region %q --user-pool-id %q --app-client-id %q --readers-group %q --admins-group %q\n" "${aws_region}" "${user_pool_id}" "${app_client_id}" "${readers_group}" "${admins_group}"
fi

printf '\nFetch an ID token for a test user:\n'
printf "aws cognito-idp initiate-auth --region %q --auth-flow USER_PASSWORD_AUTH --client-id %q --auth-parameters USERNAME='<username>',PASSWORD='<password>' --query 'AuthenticationResult.IdToken' --output text\n" "${aws_region}" "${app_client_id}"
