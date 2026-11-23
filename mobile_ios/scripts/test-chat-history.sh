#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
swiftc -parse-as-library ADing/Networking/Models.swift ADing/App/ChatModel.swift tests/ChatHistoryTests.swift -o "$out/chat-history"
"$out/chat-history"
