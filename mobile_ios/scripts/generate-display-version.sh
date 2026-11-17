#!/bin/sh

set -eu

output_path="$1"
base_version="${MARKETING_VERSION:?MARKETING_VERSION is required}"
channel="${ADING_VERSION_CHANNEL:-release}"

if [ "$channel" = "pre" ] || [ "$channel" = "develop" ]; then
    year=$(/bin/date +%Y)
    month=$(/bin/date +%m)
    day=$(/bin/date +%d)
    time=$(/bin/date +%H%M%S)
    month=${month#0}
    day=${day#0}
    # Same as desktop: pre-release -pre, Debug builds run directly from Xcode -dev
    suffix=$([ "$channel" = "develop" ] && echo dev || echo pre)
    display_version="${base_version}-${year}.${month}.${day}-${time}-${suffix}"
else
    display_version="$base_version"
fi

/bin/mkdir -p "$(/usr/bin/dirname "$output_path")"
/usr/bin/plutil -create xml1 "$output_path"
/usr/bin/plutil -insert ADingDisplayVersion -string "$display_version" "$output_path"
