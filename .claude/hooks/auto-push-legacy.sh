#!/usr/bin/env bash
# Auto-commit and push legacy_post_selector.html to origin/main on every
# Edit / Write / MultiEdit. Configured via .claude/settings.json so it
# travels with the repo. Output is JSON consumed by the hook system —
# additionalContext is surfaced back to the assistant so it can confirm
# success or relay errors in the next response.

set -u

# Read the entire JSON payload sent by the hook system on stdin.
input=$(cat)

# Extract tool_input.file_path (Edit/Write/MultiEdit) or tool_response.filePath
# without jq — sed handles both forward-slash and JSON-escaped backslash paths.
file=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$file" ]; then
  file=$(printf '%s' "$input" | sed -n 's/.*"filePath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
[ -n "$file" ] || exit 0

# Un-escape JSON backslashes so basename/dirname work on Windows-style paths.
file="${file//\\\\/\\}"

# Only act on legacy_post_selector.html. All other files exit silently.
[ "$(basename "$file")" = "legacy_post_selector.html" ] || exit 0

# JSON-string-escape helper: backslash, double-quote, newlines.
je() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# Emit a single JSON line whose additionalContext is surfaced to the model.
emit() {
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$(je "$1")"
}

dir="$(dirname "$file")"
cd "$dir" 2>/dev/null || { emit "Auto-push FAILED: could not cd to $dir"; exit 0; }

add_out=$(git add legacy_post_selector.html 2>&1)
if [ $? -ne 0 ]; then
  emit "Auto-push FAILED at git add. Output: $add_out"
  exit 0
fi

if git diff --cached --quiet -- legacy_post_selector.html; then
  emit "Auto-push: nothing to commit (file unchanged after edit)."
  exit 0
fi

commit_out=$(git -c user.name="Brett McLaughlin" -c user.email="brett@legacyrep.co" commit -m "Auto-sync legacy_post_selector.html" -- legacy_post_selector.html 2>&1)
if [ $? -ne 0 ]; then
  emit "Auto-push FAILED at git commit. Output: $commit_out"
  exit 0
fi

push_out=$(git push origin HEAD:main 2>&1)
if [ $? -ne 0 ]; then
  emit "Auto-push FAILED at git push (local commit was made but remote was NOT updated). Error: $push_out . Fix: check network and credentials, then retry manually: git push origin HEAD:main"
  exit 0
fi

emit "Auto-push SUCCESS: legacy_post_selector.html committed and pushed to origin/main. Cloudflare site updates within ~60 seconds."
