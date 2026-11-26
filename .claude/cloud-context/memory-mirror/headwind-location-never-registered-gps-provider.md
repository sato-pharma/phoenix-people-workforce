---
name: headwind-location-never-registered-gps-provider
description: why no rep tablet ever reported GPS — the launcher required the (absent) network provider first — and the 6.45 fix
metadata:
  node_type: memory
  type: project
  originSessionId: d36b05eb-2113-46dd-a685-dfc52e3baf52
  modified: 2026-11-26T00:42:24.724Z
---

For the whole life of the fleet, no Headwind tablet ever reported a GPS fix, and the cause was in the launcher, not the config. `LocationService.requestLocationUpdates()` called `requestLocationUpdates(NETWORK_PROVIDER, …)` first and unconditionally, in the same try block as the GPS registration. The de-Googled Lenovo tablets have **no network-location provider**, so that call threw "provider doesn't exist", the catch returned `false`, and GPS was never registered at all; `onStartCommand` then read that `false` as "No permissions!" and stopped the service. So every tablet looked permissioned (`permissions:[1,0,1,0]`) yet produced zero fixes. 6.44's fix caching (`LocationService.rememberFix` + `DeviceInfoProvider.getLocation` cache fallback) was correct but never had a fix to cache.

**Fix — launcher 6.45** (fork `it-gawish-hr/hmdm-android`, branch `phoenix/location-register-providers-independently`, build run 39737073337): register each provider independently, gated on `isProviderEnabled`, each in its own try/catch, and return `true` if *any* provider registered. Shipped to the fleet via Fly on 2026-10-22 — version row 10045 (app id 46, com.hmdm.launcher) repointed in place to `https://phoenix-tablet-apps.fly.dev/hmdm-phoenix-6.45.apk` (code 15450), config 3 launcher link now 6.45/action=1.

Phoenix reads location from the **check-in position** (`getHeadwindLocation`), the `deviceinfo` plugin `gpsLat/gpsLon`, and — since 26 Nov 2026 — the positions the tablet **uploads itself** (`src/lib/devices/headwind/locations.ts`). 🔴 **The `devicelocations` 404 was NOT a red herring, and this line said so for seventeen days.** The launcher PUTs its stored fixes to `/rest/plugins/devicelocations/public/update/{number}` and deletes them only on a 2xx; that path belongs to a premium Headwind plugin the free server does not have, so every upload answered 404 (measured on PHX-TAB-0008 at 02:13 and 02:14 Cairo on 26 Nov) and each tablet threw its own trail away after a day — which is why the `deviceinfo` history has never held a single row from any tablet. Our own add-on receives them now (`DeviceLocationsResource` + `PhoenixLocationStore`, table `phoenix_device_locations`) and Phoenix reads them back from `/rest/plugins/phoenix-actions/private/locations/{number}`. See [[tablet-location-goes-periodic-after-6-45-reports]].
