---
name: headwind-location-never-registered-gps-provider
description: why no rep tablet ever reported GPS — the launcher required the (absent) network provider first — and the 6.45 fix
metadata:
  node_type: memory
  type: project
  originSessionId: d36b05eb-2113-46dd-a685-dfc52e3baf52
  modified: 2026-10-22T07:11:59.202Z
---

For the whole life of the fleet, no Headwind tablet ever reported a GPS fix, and the cause was in the launcher, not the config. `LocationService.requestLocationUpdates()` called `requestLocationUpdates(NETWORK_PROVIDER, …)` first and unconditionally, in the same try block as the GPS registration. The de-Googled Lenovo tablets have **no network-location provider**, so that call threw "provider doesn't exist", the catch returned `false`, and GPS was never registered at all; `onStartCommand` then read that `false` as "No permissions!" and stopped the service. So every tablet looked permissioned (`permissions:[1,0,1,0]`) yet produced zero fixes. 6.44's fix caching (`LocationService.rememberFix` + `DeviceInfoProvider.getLocation` cache fallback) was correct but never had a fix to cache.

**Fix — launcher 6.45** (fork `Gawish-1997/hmdm-android`, branch `phoenix/location-register-providers-independently`, build run 39737073337): register each provider independently, gated on `isProviderEnabled`, each in its own try/catch, and return `true` if *any* provider registered. Shipped to the fleet via Fly on 2026-10-22 — version row 10045 (app id 46, com.hmdm.launcher) repointed in place to `https://phoenix-tablet-apps.fly.dev/hmdm-phoenix-6.45.apk` (code 15450), config 3 launcher link now 6.45/action=1.

Phoenix reads location from the **check-in position** (`getHeadwindLocation`) and the `deviceinfo` plugin `gpsLat/gpsLon` (`src/lib/devices/headwind/locations.ts`), NOT the `devicelocations` plugin (that 404s — a red herring). See [[tablet-location-goes-periodic-after-6-45-reports]].
