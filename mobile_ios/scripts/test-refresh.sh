#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
swiftc -parse-as-library ADing/Networking/RequestCancellation.swift ADing/App/RefreshState.swift tests/RefreshStateTests.swift -o "$out/state"
"$out/state"
swiftc -parse-as-library ADing/Networking/APIClient.swift ADing/Networking/RequestCancellation.swift ADing/Networking/Models.swift ADing/Networking/Attachments.swift tests/APIClientCancellationTests.swift -o "$out/network"
"$out/network"
