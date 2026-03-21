#!/bin/bash
# Post-tool hook: Run ESLint on edited JS/JSX files
# Reads tool input from stdin, extracts file path, runs lint on it

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only lint JS/JSX files in src/
if [[ "$FILE_PATH" == *.js ]] || [[ "$FILE_PATH" == *.jsx ]]; then
  if [[ "$FILE_PATH" == *"/src/"* ]]; then
    cd /Users/atulkumar/RayTracing
    RESULT=$(npx eslint "$FILE_PATH" --no-error-on-unmatched-pattern 2>&1)
    EXIT_CODE=$?
    if [ $EXIT_CODE -ne 0 ]; then
      echo "ESLint issues found in $(basename "$FILE_PATH"):"
      echo "$RESULT" | grep -E "error|warning" | head -5
    fi
  fi
fi

exit 0
