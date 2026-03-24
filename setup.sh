#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="${SCRIPT_DIR}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd "${SKILL_ROOT}/.." && pwd)}"
if [[ "$(basename "${WORKSPACE_ROOT}")" == "skills" ]]; then
  WORKSPACE_ROOT="$(cd "${WORKSPACE_ROOT}/.." && pwd)"
fi

echo "CommunityIntegrationSkill installed."
echo "Checking whether first-run onboarding choice is required..."

cd "${SKILL_ROOT}"
WORKSPACE_ROOT="${WORKSPACE_ROOT}" node scripts/community-agent-cli.mjs onboarding-entry --install-source cli
