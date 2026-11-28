#!/usr/bin/env bash
# tool-habits: the edit-habit case table through the real hook entry.
set -uo pipefail
node "$(dirname "$0")/edit-habit-cases.js"
