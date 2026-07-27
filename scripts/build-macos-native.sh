#!/bin/zsh
set -euo pipefail

root_dir="${0:A:h:h}"
cd "$root_dir"

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
  -Xlinker native/macos/OrbitSpeech-Info.plist \
  -o release-sidecar/orbit-speech
chmod +x release-sidecar/orbit-speech

embedded_plist="$(mktemp)"
trap 'rm -f "$embedded_plist"' EXIT
otool -s __TEXT __info_plist -X release-sidecar/orbit-speech \
  | tail -n +3 \
  | xxd -r -p > "$embedded_plist"
plutil -lint "$embedded_plist"
test "$(plutil -extract NSMicrophoneUsageDescription raw "$embedded_plist")" != ""
test "$(plutil -extract NSSpeechRecognitionUsageDescription raw "$embedded_plist")" != ""

echo "Built release-sidecar/orbit-speech with embedded privacy metadata."
