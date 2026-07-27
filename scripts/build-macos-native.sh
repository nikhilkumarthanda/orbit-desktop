#!/bin/zsh
set -euo pipefail

root_dir="${0:A:h:h}"
cd "$root_dir"

info_plist="native/macos/OrbitSpeech-Info.plist"
plutil -lint "$info_plist"
test "$(plutil -extract NSMicrophoneUsageDescription raw "$info_plist")" != ""
test "$(plutil -extract NSSpeechRecognitionUsageDescription raw "$info_plist")" != ""

mkdir -p release-sidecar
xcrun swiftc \
  native/macos/OrbitSpeech.swift \
  -O \
  -framework AppKit \
  -framework Speech \
  -framework AVFoundation \
  -framework CoreLocation \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$info_plist" \
  -o release-sidecar/orbit-speech
chmod +x release-sidecar/orbit-speech

otool -l release-sidecar/orbit-speech \
  | awk '$1 == "sectname" && $2 == "__info_plist" { found = 1 } END { exit !found }'

echo "Built release-sidecar/orbit-speech with embedded privacy metadata."
