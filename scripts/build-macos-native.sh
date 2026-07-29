#!/bin/zsh
set -euo pipefail
mkdir -p release-sidecar
xcrun swiftc native/macos/OrbitSpeech.swift -O -framework AppKit -framework Speech -framework AVFoundation -framework CoreLocation -o release-sidecar/orbit-speech
xcrun swiftc native/macos/OrbitGesture.swift -O -framework AppKit -framework CoreGraphics -o release-sidecar/orbit-gesture
chmod +x release-sidecar/orbit-speech
chmod +x release-sidecar/orbit-gesture
